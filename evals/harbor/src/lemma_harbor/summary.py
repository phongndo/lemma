"""Summarizes Harbor job directories: per agent version and model, what a harness change is judged by.

    lemma-harbor-summary jobs/baseline jobs/candidate
    python3 evals/harbor/src/lemma_harbor/summary.py jobs/baseline jobs/candidate

For each agent version and model: trials and tasks, the pass rate with a 95%
Wilson interval, mean cost, cache hit rate (cacheRead / (input + cacheRead +
cacheWrite), over all the group's tokens), mean steps and tool calls (Lemma's
model calls and tool calls; other agents report none), and errors and timeouts.
Where one model ran under several versions, each later version's pass rate is
compared with the first's: the difference with a 95% Newcombe interval. Groups
come in the order their job directories are given, so give the baseline first.

Only the standard library: it reads the `result.json` Harbor writes per trial.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

Z = 1.959963984540054  # the standard normal's 97.5th percentile


def wilson(passed: int, n: int) -> tuple[float, float]:
    """The 95% Wilson score interval of `passed` successes in `n` trials."""
    if n == 0:
        return (math.nan, math.nan)
    p = passed / n
    denominator = 1 + Z * Z / n
    centre = (p + Z * Z / (2 * n)) / denominator
    half = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / denominator
    return (max(0.0, centre - half), min(1.0, centre + half))


def newcombe(passed: int, n: int, base_passed: int, base_n: int) -> tuple[float, float, float]:
    """The difference of two independent pass rates (this minus the base), with its 95% Newcombe hybrid score interval."""
    p, q = passed / n, base_passed / base_n
    low, high = wilson(passed, n)
    base_low, base_high = wilson(base_passed, base_n)
    d = p - q
    return (d, d - math.sqrt((p - low) ** 2 + (base_high - q) ** 2), d + math.sqrt((high - p) ** 2 + (q - base_low) ** 2))


# ---------------------------------------------------------------- reading trials


def trial_results(directories: Iterable[Path]) -> Iterator[dict[str, Any]]:
    """Every trial's `result.json` under the directories, in their order; a job's own `result.json` is not one."""
    seen: set[Path] = set()
    for directory in directories:
        paths = [directory] if directory.is_file() else sorted(directory.rglob("result.json"))
        for path in paths:
            if path.resolve() in seen:
                continue
            seen.add(path.resolve())
            try:
                value = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(value, dict) and "trial_name" in value and "task_name" in value:
                yield value


def reward(trial: Mapping[str, Any]) -> float | None:
    rewards = (trial.get("verifier_result") or {}).get("rewards") or {}
    if "reward" in rewards:
        return rewards["reward"]
    return next(iter(rewards.values())) if len(rewards) == 1 else None


def agent_context(trial: Mapping[str, Any]) -> dict[str, Any]:
    """The trial's agent result; a multi-step trial's steps summed."""
    if trial.get("agent_result") is not None:
        return trial["agent_result"]
    total: dict[str, Any] = {}
    for step in trial.get("step_results") or []:
        context = step.get("agent_result") or {}
        for key in ("n_input_tokens", "n_cache_tokens", "n_output_tokens", "cost_usd"):
            if context.get(key) is not None:
                total[key] = total.get(key, 0) + context[key]
    return total


def _mean(values: list[float] | list[int]) -> float | None:
    return sum(values) / len(values) if values else None


def label(trial: Mapping[str, Any]) -> tuple[str, str]:
    """(agent@version, model) for grouping."""
    info = trial.get("agent_info") or {}
    agent = f"{info.get('name', '?')}@{info.get('version', '?')}"
    model_info = info.get("model_info") or {}
    if model_info.get("name"):
        model = "/".join(part for part in (model_info.get("provider"), model_info["name"]) if part)
    else:
        model = ((trial.get("config") or {}).get("agent") or {}).get("model_name") or "?"
    return agent, model


@dataclass
class Group:
    agent: str
    model: str
    trials: int = 0
    passed: int = 0
    tasks: set[str] = field(default_factory=set)
    costs: list[float] = field(default_factory=list)
    steps: list[int] = field(default_factory=list)
    tool_calls: list[int] = field(default_factory=list)
    cache_read: int = 0
    input_total: int = 0  # input + cacheRead + cacheWrite
    timeouts: int = 0
    errors: dict[str, int] = field(default_factory=dict)
    unverified: int = 0

    def add(self, trial: Mapping[str, Any]) -> None:
        self.trials += 1
        self.tasks.add(trial["task_name"])
        value = reward(trial)
        if value is None:
            self.unverified += 1
        elif value >= 1:
            self.passed += 1
        exception = (trial.get("exception_info") or {}).get("exception_type")
        if exception == "AgentTimeoutError":
            self.timeouts += 1
        elif exception is not None:
            self.errors[exception] = self.errors.get(exception, 0) + 1
        context = agent_context(trial)
        if context.get("cost_usd") is not None:
            self.costs.append(context["cost_usd"])
        lemma = (context.get("metadata") or {}).get("lemma") or {}
        usage = lemma.get("usage")
        if isinstance(usage, dict):
            read = usage.get("cacheRead") or 0
            self.cache_read += read
            self.input_total += (usage.get("input") or 0) + read + (usage.get("cacheWrite") or 0)
        elif context.get("n_input_tokens") is not None:
            # Harbor's own counts, for other agents: its input count includes cached input.
            self.cache_read += context.get("n_cache_tokens") or 0
            self.input_total += context["n_input_tokens"]
        if isinstance(lemma.get("steps"), int):
            self.steps.append(lemma["steps"])
        if isinstance(lemma.get("tool_calls"), int):
            self.tool_calls.append(lemma["tool_calls"])

    def summary(self) -> dict[str, Any]:
        low, high = wilson(self.passed, self.trials)
        return {
            "agent": self.agent,
            "model": self.model,
            "trials": self.trials,
            "tasks": len(self.tasks),
            "passed": self.passed,
            "pass_rate": self.passed / self.trials if self.trials else None,
            "pass_rate_ci95": [low, high],
            "mean_cost_usd": _mean(self.costs),
            "trials_with_cost": len(self.costs),
            "cache_hit_rate": self.cache_read / self.input_total if self.input_total else None,
            "mean_steps": _mean(self.steps),
            "mean_tool_calls": _mean(self.tool_calls),
            "timeouts": self.timeouts,
            "errors": sum(self.errors.values()),
            "error_types": dict(sorted(self.errors.items(), key=lambda item: -item[1])),
            "unverified": self.unverified,
        }


def summarize(trials: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    groups: dict[tuple[str, str], Group] = {}
    for trial in trials:
        key = label(trial)
        groups.setdefault(key, Group(*key)).add(trial)
    summaries = [group.summary() for group in groups.values()]
    comparisons = []
    for model in dict.fromkeys(summary["model"] for summary in summaries):
        runs = [summary for summary in summaries if summary["model"] == model]
        base = runs[0]
        for run in runs[1:]:
            d, low, high = newcombe(run["passed"], run["trials"], base["passed"], base["trials"])
            shared = len(groups[(run["agent"], model)].tasks & groups[(base["agent"], model)].tasks)
            comparisons.append({"model": model, "agent": run["agent"], "baseline": base["agent"], "difference": d, "ci95": [low, high], "shared_tasks": shared})
    return {"groups": summaries, "comparisons": comparisons}


# ---------------------------------------------------------------- printing


def _percent(value: float | None) -> str:
    return "-" if value is None or math.isnan(value) else f"{100 * value:.1f}%"


def _number(value: float | None, digits: int = 1, prefix: str = "") -> str:
    return "-" if value is None else f"{prefix}{value:.{digits}f}"


def render(result: Mapping[str, Any]) -> str:
    lines = []
    for group in result["groups"]:
        low, high = group["pass_rate_ci95"]
        errors = ", ".join(f"{name} {count}" for name, count in group["error_types"].items())
        lines += [
            f"{group['agent']}  {group['model']}",
            f"  trials        {group['trials']} over {group['tasks']} tasks",
            f"  pass rate     {_percent(group['pass_rate'])} ({group['passed']}/{group['trials']}; 95% CI {_percent(low)}–{_percent(high)})",
            f"  mean cost     {_number(group['mean_cost_usd'], 4, '$')} ({group['trials_with_cost']} trials report one)",
            f"  cache hits    {_percent(group['cache_hit_rate'])}",
            f"  mean steps    {_number(group['mean_steps'])} ({_number(group['mean_tool_calls'])} tool calls)",
            f"  timeouts      {group['timeouts']}",
            f"  errors        {group['errors']}{f' ({errors})' if errors else ''}",
            *([f"  no reward     {group['unverified']} (counted as failed)"] if group["unverified"] else []),
            "",
        ]
    for comparison in result["comparisons"]:
        low, high = comparison["ci95"]
        lines.append(
            f"{comparison['model']}: {comparison['agent']} vs {comparison['baseline']}: "
            f"{100 * comparison['difference']:+.1f} points (95% CI {100 * low:+.1f} to {100 * high:+.1f}; {comparison['shared_tasks']} tasks in both)"
        )
    return "\n".join(lines).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("jobs", nargs="+", type=Path, help="Harbor job directories (or trial directories), the baseline first")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args(argv)
    result = summarize(trial_results(args.jobs))
    if not result["groups"]:
        print(f"No trial results under {', '.join(map(str, args.jobs))}", file=sys.stderr)
        return 1
    sys.stdout.write(json.dumps(result, indent=2) + "\n" if args.json else render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
