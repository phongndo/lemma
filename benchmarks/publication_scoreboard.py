#!/usr/bin/env python3
"""Build a correctness-qualified publication scoreboard from a randomized comparison."""

from __future__ import annotations

import argparse
import json
import random
import statistics
from pathlib import Path
from typing import Any

MetricPath = tuple[str, ...]
METRICS: tuple[tuple[str, str, MetricPath, str], ...] = (
    ("warm-scroll latency", "warm_scroll", ("samples_ns",), "ns"),
    ("attach-to-visible latency", "attach_to_visible", ("samples_ns",), "ns"),
    (
        "continuous-output visibility",
        "interactive_under_output",
        ("key_to_outer_bytes", "samples_ns"),
        "ns",
    ),
    (
        "open-loop visibility",
        "interactive_open_loop",
        ("key_to_outer_bytes", "samples_ns"),
        "ns",
    ),
    (
        "TUI redraw visibility",
        "tui_redraw",
        ("key_to_outer_bytes", "samples_ns"),
        "ns",
    ),
    (
        "wheel visibility",
        "tui_wheel_burst",
        ("key_to_outer_bytes", "samples_ns"),
        "ns",
    ),
    ("idle process-tree RSS", "idle_resources", ("rss", "samples_bytes"), "bytes"),
    (
        "idle process-tree CPU",
        "idle_resources",
        ("cpu_time", "samples_ns"),
        "ns",
    ),
    ("warm-scroll wire bytes", "warm_scroll", ("outer_bytes",), "bytes"),
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comparison", required=True, type=Path)
    parser.add_argument("--paired-gate", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--output-markdown", required=True, type=Path)
    parser.add_argument("--bootstrap-samples", type=int, default=5_000)
    parser.add_argument("--seed", type=int, default=0x1E44A)
    return parser.parse_args()


def percentile(values: list[int], fraction: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def statistic(values: list[int], name: str) -> int:
    if name == "p50":
        return int(statistics.median(values))
    if name == "p95":
        return percentile(values, 0.95)
    raise ValueError(name)


def bootstrap_interval(
    values: list[int], name: str, samples: int, generator: random.Random
) -> dict[str, int]:
    distribution = []
    for _ in range(samples):
        resampled = [generator.choice(values) for _ in values]
        distribution.append(statistic(resampled, name))
    return {
        "low": percentile(distribution, 0.025),
        "high": percentile(distribution, 0.975),
    }


def nested(value: dict[str, Any], path: MetricPath) -> Any:
    current: Any = value
    for component in path:
        if not isinstance(current, dict) or component not in current:
            return None
        current = current[component]
    return current


def valid_samples(workload: dict[str, Any], path: MetricPath) -> list[int] | None:
    if workload.get("status") != "completed":
        return None
    value = nested(workload, path)
    if not isinstance(value, list) or not value:
        return None
    if not all(isinstance(sample, int) and sample >= 0 for sample in value):
        return None
    return value


def raw_failures(results: list[dict[str, Any]]) -> list[dict[str, str]]:
    failures = []
    for result in results:
        subject = str(result.get("multiplexer", "unknown"))
        for workload, value in result.get("workloads", {}).items():
            if not isinstance(value, dict):
                failures.append(
                    {"subject": subject, "workload": workload, "status": "malformed"}
                )
                continue
            status = str(value.get("status", "missing"))
            if status != "completed":
                failures.append(
                    {"subject": subject, "workload": workload, "status": status}
                )
    return failures


def format_value(value: int, unit: str) -> str:
    if unit == "ns":
        return f"{value / 1_000:.1f} us"
    return f"{value:,} B"


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Lemma publication scoreboard",
        "",
        "Lower is better. Intervals are deterministic 95% bootstrap confidence intervals. "
        "Only correctness-complete workloads are ranked.",
        "",
        "| Metric | Lemma p50 (95% CI) | tmux p50 (95% CI) | p50 effect | "
        "Lemma p95 (95% CI) | tmux p95 (95% CI) | Winner |",
        "|---|---:|---:|---:|---:|---:|---|",
    ]
    for metric in report["metrics"]:
        unit = metric["unit"]
        lemma = metric["subjects"]["lemma"]
        tmux = metric["subjects"]["tmux"]

        def cell(subject: dict[str, Any], stat: str) -> str:
            point = format_value(subject[stat], unit)
            interval = subject[stat + "_ci95"]
            return (
                f"{point} ({format_value(interval['low'], unit)}-"
                f"{format_value(interval['high'], unit)})"
            )

        effect = metric["lemma_vs_tmux_p50_percent"]
        effect_text = "n/a" if effect is None else f"{effect:+.1f}%"
        lines.append(
            f"| {metric['name']} | {cell(lemma, 'p50')} | {cell(tmux, 'p50')} | "
            f"{effect_text} | {cell(lemma, 'p95')} | {cell(tmux, 'p95')} | "
            f"{metric['winner_p50']} |"
        )
    lines.extend(
        [
            "",
            "## Qualification",
            "",
            f"- Comparison source: `{report['source']}`",
            f"- Latest exact-source paired gate: `{report['paired_gate']['source']}`; "
            f"{report['paired_gate']['passed_comparisons']} enforced comparisons passed, "
            f"with {report['paired_gate']['failed_absolute_target_count']} absolute product "
            "targets still failed.",
            f"- Seeded execution order: `{report['execution_seed']}`; "
            f"{len(report['execution_order'])} recorded phases.",
            "- Direct before/after brackets and drift remain embedded in the source report and are "
            "referenced, not discarded.",
            "- Normalized 80x24 `xterm-256color` results are reported above. Stock terminal-lab "
            "results remain explicitly unavailable rather than being mixed with normalized data.",
            f"- Raw non-completed workload records: {len(report['raw_failures'])}.",
            "",
            "## Unmet product targets and unavailable matrices",
            "",
        ]
    )
    lines.extend(f"- {item}" for item in report["unavailable_or_failed_gates"])
    return "\n".join(lines) + "\n"


def main() -> int:
    arguments = parse_arguments()
    if arguments.bootstrap_samples < 1_000:
        raise ValueError("bootstrap-samples must be at least 1000")
    source = json.loads(arguments.comparison.read_text())
    paired = json.loads(arguments.paired_gate.read_text())
    if paired.get("status") != "passed":
        raise ValueError("paired gate did not pass")
    paired_comparisons = paired.get("comparisons")
    paired_targets = paired.get("target_checks")
    if not isinstance(paired_comparisons, list) or not isinstance(paired_targets, list):
        raise ValueError("paired gate is missing comparisons or target checks")
    results = source.get("results")
    if not isinstance(results, list):
        raise ValueError("comparison has no result list")
    by_subject = {
        result.get("multiplexer"): result
        for result in results
        if isinstance(result, dict)
    }
    if "lemma" not in by_subject or "tmux" not in by_subject:
        raise ValueError("comparison must contain Lemma and tmux")
    generator = random.Random(arguments.seed)
    metrics = []
    for name, workload_name, path, unit in METRICS:
        subjects: dict[str, Any] = {}
        for subject in ("lemma", "tmux"):
            workload = by_subject[subject].get("workloads", {}).get(workload_name, {})
            samples = valid_samples(workload, path)
            if samples is None:
                raise ValueError(
                    f"{subject} {workload_name} is not correctness-complete"
                )
            subjects[subject] = {
                "sample_count": len(samples),
                "samples": samples,
                "p50": statistic(samples, "p50"),
                "p95": statistic(samples, "p95"),
                "p50_ci95": bootstrap_interval(
                    samples, "p50", arguments.bootstrap_samples, generator
                ),
                "p95_ci95": bootstrap_interval(
                    samples, "p95", arguments.bootstrap_samples, generator
                ),
            }
        lemma_p50 = subjects["lemma"]["p50"]
        tmux_p50 = subjects["tmux"]["p50"]
        effect = ((lemma_p50 / tmux_p50) - 1.0) * 100.0 if tmux_p50 != 0 else None
        winner = (
            "tie"
            if lemma_p50 == tmux_p50
            else ("lemma" if lemma_p50 < tmux_p50 else "tmux")
        )
        metrics.append(
            {
                "name": name,
                "workload": workload_name,
                "sample_path": path,
                "unit": unit,
                "subjects": subjects,
                "lemma_vs_tmux_p50_percent": effect,
                "practical_effect_at_least_5_percent": (
                    abs(effect) >= 5.0 if effect is not None else False
                ),
                "winner_p50": winner,
            }
        )
    report = {
        "schema": "lemma.publication-scoreboard/v1",
        "source": str(arguments.comparison),
        "source_schema": source.get("schema"),
        "paired_gate": {
            "source": str(arguments.paired_gate),
            "status": paired["status"],
            "passed_comparisons": sum(
                value.get("status") == "passed" for value in paired_comparisons
            ),
            "diagnostic_comparisons": sum(
                value.get("status") == "diagnostic" for value in paired_comparisons
            ),
            "unsupported_comparisons": sum(
                value.get("status") == "unsupported" for value in paired_comparisons
            ),
            "failed_absolute_target_count": sum(
                value.get("status") == "failed" for value in paired_targets
            ),
        },
        "environment_valid": source.get("environment_valid"),
        "statistics_valid": source.get("statistics_valid"),
        "execution_seed": source.get("seed"),
        "execution_order": source.get("execution_order"),
        "direct_brackets": {
            "before_after": source.get("direct_after_controls"),
            "baseline_deltas": source.get("direct_baseline_deltas"),
            "control_drift": source.get("direct_control_drift"),
        },
        "configuration_sets": {
            "normalized": {
                "status": "qualified",
                "geometry": {"columns": 80, "rows": 24},
                "term": "xterm-256color",
            },
            "stock": {
                "status": "unavailable",
                "reason": "terminal lab remains contract-only; no GUI stock-profile runner",
            },
        },
        "bootstrap": {
            "seed": arguments.seed,
            "samples": arguments.bootstrap_samples,
            "confidence": 0.95,
        },
        "metrics": metrics,
        "raw_failures": raw_failures(results),
        "unavailable_or_failed_gates": [
            f"{sum(value.get('status') == 'failed' for value in paired_targets)} latest "
            "exact-source paired-gate absolute product targets remain failed; see "
            f"{arguments.paired_gate}.",
            "Stock GUI terminal-lab qualification is unavailable.",
            "Remote qualification is explicitly deferred.",
            "Linux wakeup accounting and Darwin kqueue execution evidence are unavailable.",
        ],
    }
    arguments.output_json.parent.mkdir(parents=True, exist_ok=True)
    arguments.output_markdown.parent.mkdir(parents=True, exist_ok=True)
    arguments.output_json.write_text(json.dumps(report, indent=2) + "\n")
    arguments.output_markdown.write_text(markdown(report))
    print(arguments.output_markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
