import json
import tempfile
import unittest
from pathlib import Path

from lemma_harbor.trial import (
    add_usage,
    cache_hit_rate,
    empty_usage,
    key_variable,
    load_config,
    merge,
    model_ref,
    parse_result,
    read_report,
    report_from_log,
    report_from_result,
    strip_jsonc,
    thinking_level,
    trial_config,
)


def usage(input=0, output=0, cache_read=0, cache_write=0, cost=0.0):
    return {
        "input": input,
        "output": output,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": input + output + cache_read + cache_write,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost},
    }


RESULT = {
    "session": "s1",
    "turn": "t1",
    "reason": "done",
    "steps": 3,
    "toolCalls": 2,
    "usage": usage(100, 20, 300, 50, 0.25),
    "duration": 1234,
    "text": "Done.",
}


def event(seq, data, at=None):
    return json.dumps({"seq": seq, "id": f"e{seq}", "parent": None, "at": at if at is not None else 1000 + seq, "data": data})


LOG = [
    json.dumps({"type": "session", "version": 1, "id": "s1", "cwd": "/app", "createdAt": 1}),
    event(1, {"type": "turn-start", "turnId": "t1", "model": "anthropic/x"}, at=1000),
    event(2, {"type": "message", "turnId": "t1", "message": {"role": "user", "content": [{"type": "text", "text": "go"}]}}),
    event(3, {"type": "step-start", "turnId": "t1", "stepId": "a"}),
    event(4, {"type": "attempt", "turnId": "t1", "stepId": "a", "message": {"role": "assistant", "content": [], "usage": usage(10, 1, cost=0.01)}}),
    event(5, {"type": "step-start", "turnId": "t1", "stepId": "b"}),
    event(
        6,
        {
            "type": "message",
            "turnId": "t1",
            "stepId": "b",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "x"}, {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {}}],
                "usage": usage(100, 10, 400, 0, 0.1),
            },
        },
    ),
    event(7, {"type": "message", "turnId": "t1", "stepId": "b", "message": {"role": "toolResult", "toolCallId": "c1", "usage": usage(999)}}),
    event(
        8,
        {
            "type": "compaction",
            "turnId": "t1",
            "summary": "…",
            "firstKeptId": "e2",
            "tokensBefore": 5,
            "source": "context.compaction",
            "usage": usage(50, 5, cost=0.02),
        },
    ),
    "not json",
]


class ModelRefs(unittest.TestCase):
    def test_built_in_providers_pass_through(self):
        self.assertEqual(model_ref("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5")
        self.assertEqual(model_ref("openai/gpt-5"), "openai/gpt-5")

    def test_openrouter_keeps_the_upstream_in_the_model(self):
        self.assertEqual(model_ref("openrouter/anthropic/claude-sonnet-4.5"), "openrouter/anthropic/claude-sonnet-4.5")

    def test_a_ref_needs_a_provider_and_a_model(self):
        for bad in (None, "", "gpt-5", "openai/", "/gpt-5"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                model_ref(bad)

    def test_the_key_is_the_provider_s(self):
        self.assertEqual(key_variable("anthropic/x"), "ANTHROPIC_API_KEY")
        self.assertEqual(key_variable("openai/x"), "OPENAI_API_KEY")
        self.assertEqual(key_variable("openrouter/anthropic/x"), "OPENROUTER_API_KEY")
        self.assertEqual(key_variable("opencode-go/kimi-k3"), "OPENCODE_API_KEY")
        self.assertIsNone(key_variable("mock/scripted"))

    def test_thinking_levels_are_lemma_s(self):
        self.assertEqual(thinking_level("high"), "high")
        self.assertIsNone(thinking_level(None))
        with self.assertRaises(ValueError):
            thinking_level("extreme")


class Config(unittest.TestCase):
    def test_jsonc_comments_and_trailing_commas_go_but_strings_stay(self):
        text = """{
          // a comment
          "url": "http://x//y", /* block */ "glob": "a/*b*/",
          "quote": "say \\"hi\\" // not a comment",
          "list": [1, 2,],
        }"""
        self.assertEqual(
            json.loads(strip_jsonc(text)),
            {"url": "http://x//y", "glob": "a/*b*/", "quote": 'say "hi" // not a comment', "list": [1, 2]},
        )

    def test_a_config_file_or_inline_object(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.jsonc"
            path.write_text('{ "plugins": { "context.compaction": { "enabled": false }, }, }\n')
            self.assertEqual(load_config(path), {"plugins": {"context.compaction": {"enabled": False}}})
            self.assertEqual(load_config(str(path)), load_config(path))
            path.write_text("[1]")
            with self.assertRaises(ValueError):
                load_config(path)
        self.assertEqual(load_config({"plugins": {}}), {"plugins": {}})
        self.assertIsNone(load_config(None))

    def test_the_user_s_rows_merge_key_by_key_over_the_trial_s(self):
        config = trial_config(
            "/installed-agent/lemma/bin/lemma",
            {"plugins": {"agent.loop": {"config": {"maxSteps": 50}}, "tools.ask": {"enabled": True}}},
        )
        self.assertEqual(config["plugins"]["agent.loop"]["config"], {"cli": "/installed-agent/lemma/bin/lemma", "maxSteps": 50})
        self.assertEqual(config["plugins"]["tools.ask"], {"enabled": True})
        self.assertEqual(config["plugins"]["transport.server"], {"config": {"port": 0}})

    def test_merge_replaces_what_is_not_an_object(self):
        self.assertEqual(merge({"a": {"b": 1, "c": [1]}}, {"a": {"c": [2]}, "d": 3}), {"a": {"b": 1, "c": [2]}, "d": 3})


class Reports(unittest.TestCase):
    def test_the_run_s_result_is_read_even_after_other_output(self):
        self.assertEqual(parse_result(json.dumps(RESULT, indent=2))["steps"], 3)
        self.assertEqual(parse_result("a notice\n" + json.dumps(RESULT))["session"], "s1")
        self.assertIsNone(parse_result(""))
        self.assertIsNone(parse_result('{"error": {"code": "NoHost"}}'))

    def test_harbor_counts_cached_input_as_input(self):
        report = report_from_result(RESULT)
        self.assertEqual(report.source, "run")
        self.assertEqual((report.steps, report.tool_calls, report.duration_ms), (3, 2, 1234))
        self.assertEqual(report.harbor_counts(), {"n_input_tokens": 450, "n_cache_tokens": 300, "n_output_tokens": 20, "cost_usd": 0.25})
        self.assertAlmostEqual(report.metadata()["cache_hit_rate"], 300 / 450)

    def test_the_log_sums_answers_failed_attempts_and_compactions(self):
        report = report_from_log(LOG)
        self.assertEqual(report.source, "log")
        self.assertEqual(report.session, "s1")
        self.assertEqual(report.reason, "unfinished")
        self.assertEqual((report.steps, report.tool_calls), (2, 1))
        self.assertEqual((report.usage["input"], report.usage["output"], report.usage["cacheRead"]), (160, 16, 400))
        self.assertAlmostEqual(report.usage["cost"]["total"], 0.13)

    def test_an_ended_turn_in_the_log_says_how(self):
        ended = [*LOG, event(9, {"type": "turn-end", "turnId": "t1", "reason": "error", "error": "429"}, at=4000)]
        report = report_from_log(ended)
        self.assertEqual((report.reason, report.error, report.duration_ms), ("error", "429", 3000))

    def test_the_run_s_result_wins_and_the_log_stands_in(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            self.assertIsNone(read_report(logs))
            sessions = logs / "lemma-home" / "sessions" / "--app--"
            sessions.mkdir(parents=True)
            (sessions / "2026_s1.jsonl").write_text("\n".join(LOG) + "\n")
            self.assertEqual(read_report(logs).source, "log")
            (logs / "lemma-run.json").write_text("")
            self.assertEqual(read_report(logs).source, "log")
            (logs / "lemma-run.json").write_text(json.dumps(RESULT))
            self.assertEqual(read_report(logs).source, "run")

    def test_usage_adds_up_and_hit_rate_is_lemma_s(self):
        total = add_usage(add_usage(empty_usage(), usage(10, 1, 30, 0, 0.5)), None)
        self.assertEqual(total["cacheRead"], 30)
        self.assertEqual(cache_hit_rate(total), 0.75)
        self.assertIsNone(cache_hit_rate(empty_usage()))


if __name__ == "__main__":
    unittest.main()
