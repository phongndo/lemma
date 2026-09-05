#!/usr/bin/env python3
"""Publish the final qualification status and exact remaining product floors."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paired-gate", required=True, type=Path)
    parser.add_argument("--scoreboard", required=True, type=Path)
    parser.add_argument("--binaries", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--output-markdown", required=True, type=Path)
    return parser.parse_args()


def category(
    milestone: str,
    name: str,
    status: str,
    verified: list[str],
    floor: list[str],
) -> dict[str, Any]:
    return {
        "milestone": milestone,
        "name": name,
        "status": status,
        "verified": verified,
        "remaining_floor": floor,
    }


def metric_summary(scoreboard: dict[str, Any], metric_name: str) -> str:
    metric = next(
        value for value in scoreboard["metrics"] if value["name"] == metric_name
    )
    lemma = metric["subjects"]["lemma"]
    tmux = metric["subjects"]["tmux"]
    return (
        f"{metric_name}: Lemma p50/p95 {lemma['p50']}/{lemma['p95']} {metric['unit']}; "
        f"tmux {tmux['p50']}/{tmux['p95']} {metric['unit']}"
    )


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Definition-of-Done qualification",
        "",
        "Workload boundaries are unchanged. `partial`, `failed`, `unavailable`, and `deferred` "
        "results are reported rather than promoted.",
        "",
        "| Milestone | Category | Status | Exact remaining floor |",
        "|---|---|---|---|",
    ]
    for value in report["categories"]:
        floor = "<br>".join(value["remaining_floor"]) or "None in qualified scope"
        lines.append(
            f"| {value['milestone']} | {value['name']} | {value['status']} | {floor} |"
        )
    lines.extend(
        [
            "",
            "## Failed absolute product targets",
            "",
            "| Target | Observed | Maximum | Samples |",
            "|---|---:|---:|---:|",
        ]
    )
    for target in report["failed_absolute_targets"]:
        lines.append(
            f"| {target['id']} | {target['observed']} {target['unit']} | "
            f"{target['maximum']} {target['unit']} | {target['samples']} |"
        )
    lines.extend(["", "## Unsupported target evidence", ""])
    for target in report["unsupported_targets"]:
        lines.append(f"- `{target['id']}`: {target['status']}")
    lines.extend(
        [
            "",
            "## Comparative floors",
            "",
            *[f"- {value}" for value in report["comparative_floors"]],
            "",
            "## Sources",
            "",
            *[f"- `{value}`" for value in report["sources"]],
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    arguments = parse_arguments()
    paired = json.loads(arguments.paired_gate.read_text())
    scoreboard = json.loads(arguments.scoreboard.read_text())
    binaries = json.loads(arguments.binaries.read_text())
    stripped_binary_bytes = binaries["binaries"]["lemma"]["stripped_bytes"]
    target_checks = paired["target_checks"]
    failed = [target for target in target_checks if target["status"] == "failed"]
    unsupported = [
        target for target in target_checks if target["status"] == "unsupported"
    ]
    report = {
        "schema": "lemma.definition-of-done/v1",
        "status": "partial",
        "policy": {
            "workload_boundaries_changed": False,
            "remote": "deferred",
            "stock_gui_lab": "unavailable",
        },
        "categories": [
            category(
                "A",
                "measurement contract",
                "passed",
                [
                    "approved-host affinity/load policy",
                    "seeded randomized order and direct before/after brackets",
                    "raw samples, 95% bootstrap intervals, and practical effects",
                ],
                ["stock GUI-lab runner unavailable"],
            ),
            category(
                "B",
                "Ghostty pin and capability matrix",
                "passed",
                ["full profile retained at 3e7230bf5d0e12d018b850ed3856daa848bfebb7"],
                ["smaller profiles rejected by repeatable small-write regression"],
            ),
            category(
                "C",
                "bounded ownership and steady-state allocation",
                "passed",
                [
                    "10,000-iteration allocation audit is zero",
                    "cold storage ownership reduced",
                    "sparse owner tables maintain authoritative dense live-slot registries",
                    "turn-local capacity arrays initialize only live Session slots",
                    "Pane failure, hydration, write, and deadline work is authority-counted",
                ],
                [],
            ),
            category(
                "D",
                "PTY, render, and interaction path",
                "partial",
                [
                    "all paired regression comparisons passed",
                    "retained correlated traces have zero drops",
                ],
                [
                    metric_summary(scoreboard, "continuous-output visibility"),
                    metric_summary(scoreboard, "TUI redraw visibility"),
                ],
            ),
            category(
                "E",
                "viewer sharing and fan-out",
                "partial",
                [
                    "public projection cache qualified from V1 through V64",
                    "long-lived passive observers split from PendingConnection setup ownership",
                ],
                ["general private FrameBlob sharing not implemented"],
            ),
            category(
                "F",
                "snapshot, parking, and restoration",
                "passed",
                [
                    "bounded snapshot API and secure sealed storage",
                    "incremental deterministic hydration",
                    "1,000-cycle 16-Pane soak with zero final resource deltas",
                ],
                [
                    "callback-backed streaming restore rejected after deterministic heap corruption"
                ],
            ),
            category(
                "G",
                "active-terminal memory",
                "partial",
                ["active PagePool memory and decommit floor measured"],
                [
                    "empty terminal: 2,134,016 anonymous writable virtual bytes and 45,056 resident/private-dirty bytes",
                    "5,000-line terminal: 5,025,792 virtual and 3,063,808 resident bytes",
                    "compact/shared/COW Ghostty PagePool not implemented",
                ],
            ),
            category(
                "H",
                "large-scale reactor",
                "partial",
                [
                    "intrusive lifecycle-owned live-Pane registry",
                    "dense lifecycle-owned live, attached, and frame-work Session registries",
                    "authoritative Pane failure/hydration counts and deadline minima",
                    "phase-local reactor clock refreshed across the blocking poll boundary",
                    "child collection driven only by child-reaper descriptor readiness",
                    "activity-aware persistent Linux epoll retained and qualified at R64",
                    "dedicated-thread and serial-shard ownership measured and rejected",
                ],
                ["Darwin kqueue execution unavailable"],
            ),
            category(
                "I",
                "binary ownership and release artifact",
                "passed",
                [
                    "ordinary non-LTO full-profile binary: "
                    f"{stripped_binary_bytes:,} stripped bytes"
                ],
                [],
            ),
            category(
                "J",
                "product surface, extensions, and remote",
                "partial/deferred",
                [
                    "compiled Lua policy is process-isolated and idle host has zero measured CPU",
                    "versioned bounded Proc Commands/results and immutable passive Events are public",
                ],
                [
                    "supervised jobs, package capabilities, and declarative extension views not implemented",
                    "remote transport/authentication/reconnect matrix explicitly deferred",
                ],
            ),
            category(
                "K",
                "publication and portability",
                "partial",
                [
                    "latest-source just check and Nix production reproduction passed",
                    "latest exact-source paired gate passed every enforced comparison",
                    "Linux sanitizer, fuzz, mux, scale, binary, and soak evidence published",
                ],
                [
                    f"{len(failed)} absolute product targets failed",
                    "idle wakeup count unsupported on Linux collector",
                    "stock GUI and Darwin execution unavailable",
                ],
            ),
        ],
        "failed_absolute_targets": failed,
        "unsupported_targets": unsupported,
        "comparative_floors": [
            metric_summary(scoreboard, "continuous-output visibility"),
            metric_summary(scoreboard, "TUI redraw visibility"),
            metric_summary(scoreboard, "idle process-tree RSS"),
        ],
        "sources": [
            str(arguments.paired_gate),
            str(arguments.scoreboard),
            "build/ghostty-feature-matrix/results-extended.json",
            "build/performance/e-viewer-scale-shared-screen.json",
            "build/performance/e-viewer-scale-dedicated-observers.json",
            "build/performance/e-viewer-scale-dense-owners.json",
            "build/performance/f-parking-ready-peak-40-high-rate.json",
            "build/performance/g-ghostty-page-pool.json",
            "build/performance/h-reactor-backends-linux.json",
            "build/performance/h-reactor-adaptive-linux.json",
            "build/performance/h-reactor-production-r64-linux.json",
            "build/performance/h-reactor-epoll-shards-linux.json",
            "build/performance/h-reactor-thread-topology-linux.json",
            "build/performance/j-extension-isolation-linux.json",
            "build/performance/k-parking-hydration-soak-1000-latest-source.json",
            str(arguments.binaries),
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
