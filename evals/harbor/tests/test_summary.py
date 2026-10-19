import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from lemma_harbor.summary import main, newcombe, summarize, trial_results, wilson


def trial(task, agent, version, passed, *, exception=None, verified=True, cost=0.1, lemma=True, model=("anthropic", "m")):
    context = {"n_input_tokens": 1000, "n_cache_tokens": 500, "n_output_tokens": 10, "cost_usd": cost}
    if lemma:
        context["metadata"] = {"lemma": {"steps": 4, "tool_calls": 3, "usage": {"input": 100, "output": 10, "cacheRead": 300, "cacheWrite": 0}}}
    return {
        "task_name": task,
        "trial_name": f"{task}__{version}",
        "agent_info": {"name": agent, "version": version, "model_info": {"provider": model[0], "name": model[1]}},
        "agent_result": context,
        "verifier_result": {"rewards": {"reward": 1.0 if passed else 0.0}} if verified else None,
        "exception_info": None if exception is None else {"exception_type": exception, "exception_message": "…"},
        "config": {"agent": {"model_name": "/".join(model)}},
    }


def write_job(root: Path, name: str, trials: list[dict]) -> Path:
    job = root / name
    for index, value in enumerate(trials):
        directory = job / f"{value['trial_name']}__{index}"
        directory.mkdir(parents=True)
        (directory / "result.json").write_text(json.dumps(value))
    # A job's own result.json, which is not a trial's.
    (job / "result.json").write_text(json.dumps({"id": "x", "n_total_trials": len(trials), "stats": {}}))
    return job


class Intervals(unittest.TestCase):
    def test_wilson_matches_newcombe_s_worked_example(self):
        low, high = wilson(81, 263)
        self.assertAlmostEqual(low, 0.2553, places=4)
        self.assertAlmostEqual(high, 0.3662, places=4)
        self.assertEqual(wilson(0, 10)[0], 0.0)

    def test_the_difference_matches_newcombe_s_method_10(self):
        d, low, high = newcombe(56, 70, 48, 80)
        self.assertAlmostEqual(d, 0.2)
        self.assertAlmostEqual(low, 0.0524, places=4)
        self.assertAlmostEqual(high, 0.3339, places=4)


class Summary(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        tasks = [f"task-{n}" for n in range(5)]
        baseline = [trial(task, "lemma", "aaaa", True) for task in tasks for _ in range(2)]
        baseline[8] = trial("task-4", "lemma", "aaaa", False, exception="AgentTimeoutError")
        baseline[9] = trial("task-4", "lemma", "aaaa", False, exception="NonZeroAgentExitCodeError", verified=False, cost=None)
        candidate = [trial(task, "lemma", "bbbb", index < 5) for index, task in enumerate(tasks * 2)]
        other = [trial(task, "claude-code", "2.1", True, lemma=False) for task in tasks[:2]]
        self.jobs = [write_job(root, "baseline", baseline), write_job(root, "candidate", candidate), write_job(root, "other", other)]

    def tearDown(self):
        self.directory.cleanup()

    def test_each_version_and_model_is_summarized(self):
        result = summarize(trial_results(self.jobs))
        groups = {group["agent"]: group for group in result["groups"]}
        self.assertEqual(list(groups), ["lemma@aaaa", "lemma@bbbb", "claude-code@2.1"])
        base = groups["lemma@aaaa"]
        self.assertEqual((base["trials"], base["tasks"], base["passed"]), (10, 5, 8))
        self.assertEqual(base["pass_rate_ci95"], list(wilson(8, 10)))
        self.assertAlmostEqual(base["mean_cost_usd"], 0.1)
        self.assertEqual(base["trials_with_cost"], 9)
        self.assertAlmostEqual(base["cache_hit_rate"], 0.75)
        self.assertEqual((base["mean_steps"], base["mean_tool_calls"]), (4, 3))
        self.assertEqual((base["timeouts"], base["errors"], base["unverified"]), (1, 1, 1))
        self.assertEqual(base["error_types"], {"NonZeroAgentExitCodeError": 1})
        other = groups["claude-code@2.1"]
        self.assertAlmostEqual(other["cache_hit_rate"], 0.5)
        self.assertIsNone(other["mean_steps"])

    def test_later_versions_are_compared_with_the_first(self):
        comparisons = summarize(trial_results(self.jobs))["comparisons"]
        self.assertEqual([(c["agent"], c["baseline"]) for c in comparisons], [("lemma@bbbb", "lemma@aaaa"), ("claude-code@2.1", "lemma@aaaa")])
        first = comparisons[0]
        self.assertAlmostEqual(first["difference"], -0.3)
        self.assertEqual(first["ci95"], list(newcombe(5, 10, 8, 10)[1:]))
        self.assertEqual(first["shared_tasks"], 5)

    def test_the_command_prints_text_or_json(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main([str(job) for job in self.jobs]), 0)
        text = out.getvalue()
        self.assertIn("lemma@aaaa  anthropic/m", text)
        self.assertIn("pass rate     80.0% (8/10; 95% CI", text)
        self.assertIn("errors        1 (NonZeroAgentExitCodeError 1)", text)
        self.assertIn("anthropic/m: lemma@bbbb vs lemma@aaaa: -30.0 points", text)
        out = io.StringIO()
        with redirect_stdout(out):
            main(["--json", str(self.jobs[0])])
        self.assertEqual(json.loads(out.getvalue())["groups"][0]["trials"], 10)

    def test_no_trials_is_a_failure(self):
        with tempfile.TemporaryDirectory() as empty, redirect_stderr(io.StringIO()):
            self.assertEqual(main([empty]), 1)


if __name__ == "__main__":
    unittest.main()
