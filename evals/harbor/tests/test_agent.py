"""LemmaAgent against Harbor's real base class, with an environment that records what it is asked to do."""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiRateLimitError,
    ModelNotFoundError,
    NonZeroAgentExitCodeError,
)
from harbor.models.agent.context import AgentContext

from lemma_harbor.agent import LEMMA, ROOT, LemmaAgent
from test_source import git

RESULT = {"session": "s1", "turn": "t1", "reason": "done", "steps": 2, "toolCalls": 1, "duration": 5, "text": "ok"}
RESULT["usage"] = {"input": 240, "output": 48, "cacheRead": 60, "cacheWrite": 0, "totalTokens": 348, "cost": {"total": 0.5}}


class Environment:
    """Records each exec and upload; `answer(command)` gives an exec's stdout, or raises."""

    default_user = None

    def __init__(self, answer=lambda command: ""):
        self.answer = answer
        self.execs: list[tuple[str, dict | None, str | None]] = []
        self.uploads: dict[str, bytes] = {}

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.execs.append((command, env, user))
        return SimpleNamespace(return_code=0, stdout=self.answer(command), stderr="")

    async def upload_file(self, source_path, target_path):
        self.uploads[str(target_path)] = Path(source_path).read_bytes()


class LemmaAgentTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.repo, self.logs = root / "repo", root / "logs"
        self.repo.mkdir()
        self.logs.mkdir()
        git(self.repo, "init", "-q")
        (self.repo / "package.json").write_text('{"packageManager": "pnpm@12.11.2"}\n')
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "one")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        patcher = mock.patch.dict(os.environ, {"XDG_CACHE_HOME": str(root / "cache"), "ANTHROPIC_API_KEY": "sk-test", "OPENAI_API_KEY": "sk-other"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.directory.cleanup()

    def agent(self, model="anthropic/claude-sonnet-4-5", **kwargs):
        return LemmaAgent(logs_dir=self.logs, model_name=model, repo=str(self.repo), **kwargs)

    def test_the_version_is_the_commit_and_a_digest_of_what_else_was_chosen(self):
        plain = self.agent()
        self.assertEqual(plain.version(), self.commit[:12])
        self.assertEqual(plain.to_agent_info().name, "lemma")
        thinking = self.agent(thinking="high")
        configured = self.agent(config={"plugins": {"context.compaction": {"enabled": False}}})
        self.assertRegex(thinking.version(), rf"^{self.commit[:12]}\+[0-9a-f]{{8}}$")
        self.assertNotEqual(thinking.version(), configured.version())
        self.assertEqual(self.agent(reasoning_effort="high").version(), thinking.version())

    def test_bad_choices_fail_at_once(self):
        with self.assertRaises(ValueError):
            self.agent(model="claude-sonnet-4-5")
        with self.assertRaises(ValueError):
            self.agent(thinking="extreme")

    def test_only_the_model_s_provider_key_goes_in(self):
        env = self.agent(thinking="low").run_env()
        self.assertEqual(env["LEMMA_EVAL_MODEL"], "anthropic/claude-sonnet-4-5")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "sk-test")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertEqual(env["LEMMA_EVAL_THINKING"], "low")
        self.assertEqual(env["LEMMA_HOME"], "/logs/agent/lemma-home")
        self.assertNotIn("ANTHROPIC_API_KEY", self.agent(model="mock/scripted").run_env())

    def test_install_uploads_the_commit_and_its_scripts_and_runs_the_installer_as_root(self):
        environment = Environment()
        asyncio.run(self.agent().install(environment))
        self.assertEqual(set(environment.uploads), {f"{ROOT}/lemma.tar.gz", f"{ROOT}/install.sh", f"{ROOT}/run.sh"})
        self.assertTrue(environment.uploads[f"{ROOT}/install.sh"].startswith(b"#!/usr/bin/env bash"))
        command, env, user = environment.execs[-1]
        self.assertIn(f"bash {ROOT}/install.sh", command)
        self.assertEqual(user, "root")
        self.assertEqual(env["LEMMA_EVAL_NODE_VERSION"], "24.21.0")

    def run_turn(self, agent, answer):
        environment = Environment(answer)
        asyncio.run(agent.run("Fix it.\n--not a flag", environment, AgentContext()))
        return environment

    def test_run_uploads_the_trial_s_config_and_instruction_and_runs_the_turn(self):
        agent = self.agent(config={"plugins": {"agent.loop": {"config": {"maxSteps": 7}}}})
        environment = self.run_turn(agent, lambda command: json.dumps(RESULT) if "run.sh" in command else "")
        config = json.loads(environment.uploads["/logs/agent/lemma-home/config.jsonc"])
        self.assertEqual(config["plugins"]["agent.loop"]["config"], {"cli": str(LEMMA), "maxSteps": 7})
        self.assertEqual(config["plugins"]["tools.ask"], {"enabled": False})
        self.assertEqual(environment.uploads["/logs/agent/instruction.md"], b"Fix it.\n--not a flag")
        command, env, _ = environment.execs[-1]
        self.assertIn(f"bash {ROOT}/run.sh", command)
        self.assertEqual(env["LEMMA_EVAL_MODEL"], "anthropic/claude-sonnet-4-5")

    def test_a_turn_out_of_steps_is_graded_but_a_failed_one_is_an_error(self):
        out_of_steps = {**RESULT, "reason": "max-steps"}
        self.run_turn(self.agent(), lambda command: json.dumps(out_of_steps) if "run.sh" in command else "")
        cases = [
            ("429 Too Many Requests: rate limit exceeded", ApiRateLimitError),
            ("Anthropic is not authenticated. Run /login anthropic or set its API key environment variable.", AgentAuthenticationError),
            ("Unknown model: anthropic/nope. Model refs are <provider>/<model>.", ModelNotFoundError),
        ]
        for error, expected in cases:
            failed = json.dumps({**RESULT, "reason": "error", "error": error})
            with self.subTest(error=error), self.assertRaises(expected):
                self.run_turn(self.agent(), lambda command, failed=failed: failed if "run.sh" in command else "")
        with self.assertRaises(NonZeroAgentExitCodeError):
            self.run_turn(self.agent(), lambda command: "")

    def test_a_timeout_stops_the_host_before_harbor_goes_on(self):
        def answer(command):
            if "run.sh" in command:
                raise asyncio.CancelledError
            return ""

        with self.assertRaises(asyncio.CancelledError):
            environment = Environment(answer)
            try:
                asyncio.run(self.agent().run("go", environment, AgentContext()))
            finally:
                self.environment = environment
        command, env, _ = self.environment.execs[-1]
        self.assertEqual(command, f"{LEMMA} stop --force")
        self.assertEqual(env, {"LEMMA_HOME": "/logs/agent/lemma-home"})

    def test_the_context_is_read_back_from_the_run_s_result(self):
        (self.logs / "lemma-run.json").write_text(json.dumps(RESULT, indent=2))
        context = AgentContext()
        self.agent().populate_context_post_run(context)
        self.assertEqual((context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens, context.cost_usd), (300, 60, 48, 0.5))
        lemma = context.metadata["lemma"]
        self.assertEqual((lemma["revision"], lemma["source"], lemma["steps"], lemma["tool_calls"]), (self.commit, "run", 2, 1))
        self.assertAlmostEqual(lemma["cache_hit_rate"], 0.2)

    def test_no_logs_are_recorded_not_raised(self):
        context = AgentContext()
        self.agent().populate_context_post_run(context)
        self.assertTrue(context.metadata["lemma"]["missing"])
        self.assertIsNone(context.n_input_tokens)


if __name__ == "__main__":
    unittest.main()
