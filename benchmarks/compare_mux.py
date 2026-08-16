#!/usr/bin/env python3
"""Run the common process-level workload against pinned mux executables."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def load_report(path: Path, expected_mux: str) -> dict[str, Any]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"invalid {expected_mux} report {path}: {error}") from error
    if not isinstance(report, dict) or report.get("schema") != 4:
        raise RuntimeError(f"{expected_mux} report does not use process schema 4")
    if report.get("multiplexer") != expected_mux:
        raise RuntimeError(f"expected {expected_mux} report, got {report.get('multiplexer')!r}")
    workloads = report.get("workloads")
    if not isinstance(workloads, dict) or not {
        "warm_scroll",
        "attach_to_visible",
        "interactive_under_output",
        "idle_resources",
        "blocked_pty",
    }.issubset(workloads):
        raise RuntimeError(f"{expected_mux} report is missing common workloads")
    return report


def resolve_executable(value: str) -> Path:
    resolved = shutil.which(value)
    path = Path(resolved or value)
    if not path.is_file():
        raise RuntimeError(f"missing executable: {value}")
    return path.resolve()


def run_competitor(
    harness: Path,
    multiplexer: str,
    executable: Path,
    peer: Path,
    repetitions: int,
    destination: Path,
) -> dict[str, Any]:
    subprocess.run(
        [
            sys.executable,
            str(harness),
            "--multiplexer",
            multiplexer,
            f"--{multiplexer}",
            str(executable),
            "--peer",
            str(peer),
            "--mode",
            "comparison",
            "--repetitions",
            str(repetitions),
            "--allow-workload-failures",
            "--output",
            str(destination),
        ],
        check=True,
        timeout=240.0,
        stdout=subprocess.DEVNULL,
    )
    return load_report(destination, multiplexer)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lemma-report", type=Path, required=True)
    parser.add_argument("--peer", type=Path, default=Path("build/release/lemma_test_pty_peer"))
    parser.add_argument("--tmux", default="tmux")
    parser.add_argument("--zellij", default="zellij")
    parser.add_argument("--herdr", default="herdr")
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.repetitions < 1 or arguments.repetitions > 1_000:
        parser.error("--repetitions must be between 1 and 1000")
    if not arguments.peer.is_file():
        parser.error(f"missing executable: {arguments.peer}")

    try:
        lemma = load_report(arguments.lemma_report, "lemma")
        tmux = resolve_executable(arguments.tmux)
        zellij = resolve_executable(arguments.zellij)
        herdr = resolve_executable(arguments.herdr)
        harness = Path(__file__).with_name("mux_benchmark.py").resolve()
        with tempfile.TemporaryDirectory(prefix="mux-comparison-") as temporary:
            root = Path(temporary)
            reports = [
                lemma,
                run_competitor(
                    harness,
                    "tmux",
                    tmux,
                    arguments.peer.resolve(),
                    arguments.repetitions,
                    root / "tmux.json",
                ),
                run_competitor(
                    harness,
                    "zellij",
                    zellij,
                    arguments.peer.resolve(),
                    arguments.repetitions,
                    root / "zellij.json",
                ),
                run_competitor(
                    harness,
                    "herdr",
                    herdr,
                    arguments.peer.resolve(),
                    arguments.repetitions,
                    root / "herdr.json",
                ),
            ]
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.error(str(error))

    report = {
        "schema": 2,
        "suite": "core-mux-comparison",
        "contract": "docs/quality.md",
        "policy": (
            "Workloads share inputs and completion markers. A failed completion remains an "
            "explicit result and is never converted into a latency sample."
        ),
        "results": reports,
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
