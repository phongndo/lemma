"""Lemma as a Harbor installed agent: `harbor run -a lemma_harbor:LemmaAgent`.

`setup` uploads a commit of Lemma and installs it in the task's container
(`install.sh`); `run` sends the instruction as one prompt through `lemma run`
in a host of the trial's own (`run.sh`), with no approvals: the container is
the sandbox. The trial home, its session log among it, is kept in the trial's
agent logs, which Harbor's reported tokens and cost are read back from.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shlex
from importlib.resources import as_file, files
from pathlib import PurePosixPath
from types import SimpleNamespace
from typing import Any, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import (
    AgentAuthenticationError,
    BaseInstalledAgent,
    ErrorPattern,
    ModelNotFoundError,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from lemma_harbor.source import pack
from lemma_harbor.trial import (
    key_variable,
    load_config,
    model_ref,
    parse_result,
    read_report,
    thinking_level,
    trial_config,
)

# The flake's Node.js (`nix develop -c node --version`), which Lemma is tested on.
NODE_VERSION = "24.21.0"
ROOT = PurePosixPath("/installed-agent/lemma")
LEMMA = ROOT / "bin" / "lemma"
# Turns that ended on their own: the verifier grades what they left. Any other end (an error) fails the run.
FINISHED = ("done", "max-steps")


class LemmaAgent(BaseInstalledAgent):
    """Kwargs (`--ak name=value`): `revision` (a git revision of `repo`; default
    HEAD), `repo` (default: the checkout this package is in), `thinking` (or
    Harbor's `--effort`), `node_version`, and `config`: a Lemma config (a JSON
    or JSONC file, or inline JSON) over the trial's own."""

    capabilities = AgentCapabilities(native_config=True)
    ERROR_PATTERNS = [
        *BaseInstalledAgent.ERROR_PATTERNS,
        ErrorPattern(r"is not authenticated\. Run /login", AgentAuthenticationError),
        ErrorPattern(r"Unknown model: ", ModelNotFoundError),
    ]

    def __init__(
        self,
        *args: Any,
        revision: str = "HEAD",
        repo: str | None = None,
        thinking: str | None = None,
        reasoning_effort: str | None = None,
        node_version: str = NODE_VERSION,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._lemma_model = model_ref(self.model_name)
        self._thinking = thinking_level(thinking or reasoning_effort)
        # Harbor reads `--ak` values as JSON where they parse: an all-digit revision arrives as a number.
        self._node_version = str(node_version)
        self._source = pack(str(revision), repo)
        user_config = load_config(self.config_source)
        self._trial_config = trial_config(str(LEMMA), user_config)
        # What ran: the commit, and a digest of the config and thinking level when either is given, so a job that
        # compares setups of one commit keeps them apart.
        self._version = self._source.short
        if user_config is not None or self._thinking is not None:
            variant = json.dumps([self._trial_config, self._thinking], sort_keys=True)
            self._version += "+" + hashlib.sha256(variant.encode()).hexdigest()[:8]

    @staticmethod
    @override
    def name() -> str:
        return "lemma"

    @override
    def version(self) -> str:
        return self._version

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # curl fetches Node.js; bash runs the scripts and is the bash tool's shell.
        await self.ensure_system_dependencies(environment, ("curl", "bash"))
        await self.exec_as_root(environment, command=f"mkdir -p {ROOT}")
        await environment.upload_file(self._source.archive, str(ROOT / "lemma.tar.gz"))
        for script in ("install.sh", "run.sh"):
            with as_file(files("lemma_harbor") / script) as path:
                await environment.upload_file(path, str(ROOT / script))
        await self.exec_as_root(
            environment,
            command=f"bash {ROOT / 'install.sh'}",
            env={"LEMMA_EVAL_ROOT": str(ROOT), "LEMMA_EVAL_NODE_VERSION": self._node_version},
        )

    def run_env(self) -> dict[str, str]:
        """What `run.sh` is given: where things are, the model, and the key of its provider."""
        out = self.environment_logs_dir
        env = {
            "LEMMA_EVAL_ROOT": str(ROOT),
            "LEMMA_EVAL_OUT": str(out),
            "LEMMA_EVAL_MODEL": self._lemma_model,
            "LEMMA_HOME": str(out / "lemma-home"),
        }
        if self._thinking is not None:
            env["LEMMA_EVAL_THINKING"] = self._thinking
        variable = key_variable(self._lemma_model)
        if variable is not None and (key := self._get_env(variable)) is not None:
            env[variable] = key
        return env

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        out = self.environment_logs_dir
        home = out / "lemma-home"
        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(str(home))}")
        config = json.dumps(self._trial_config, indent=2) + "\n"
        await self._upload_config_text(environment, content=config, remote_path=str(home / "config.jsonc"), filename="config.jsonc")
        await self._upload_config_text(environment, content=instruction, remote_path=str(out / "instruction.md"), filename="instruction.md")
        command = f"bash {ROOT / 'run.sh'}"
        try:
            result = await self.exec_as_agent(environment, command=command, env=self.run_env())
        except asyncio.CancelledError:
            # Harbor's timeout: stop the host, so the turn and its commands do not run on into the verifier's time.
            await self._stop(environment, home)
            raise
        turn = parse_result(result.stdout)
        if turn is None:
            raise NonZeroAgentExitCodeError(f"lemma run printed no result: {self._truncate_output(result.stdout)}")
        if turn.get("reason") not in FINISHED:
            # Classified as a failed command is: a provider's failure that outlasted Lemma's retries reads as one.
            failed = SimpleNamespace(return_code=1, stdout=str(turn.get("error") or ""), stderr=f"turn ended: {turn.get('reason')}")
            raise self._classify_exec_error(command, failed)

    async def _stop(self, environment: BaseEnvironment, home: PurePosixPath) -> None:
        try:
            await environment.exec(command=f"{LEMMA} stop --force", env={"LEMMA_HOME": str(home)}, timeout_sec=60)
        except Exception as error:  # the trial is ending anyway: say so and go on
            self.logger.warning(f"Could not stop the trial's Lemma host: {error}")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        identity = {"revision": self._source.commit, "model": self._lemma_model, "thinking": self._thinking}
        report = read_report(self.logs_dir)
        if report is None:
            # Nothing came back (setup failed, or the logs were lost): recorded rather than raised, which ends the job.
            context.metadata = {**(context.metadata or {}), "lemma": {**identity, "missing": True}}
            return
        for name, value in report.harbor_counts().items():
            setattr(context, name, value)
        context.metadata = {**(context.metadata or {}), "lemma": {**identity, **report.metadata()}}
