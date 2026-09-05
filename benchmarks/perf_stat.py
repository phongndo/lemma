#!/usr/bin/env python3
"""Run one explicit profiling command under the reviewed Linux perf-stat groups."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mux_benchmark import git_provenance, host_fingerprint

HARDWARE_GROUP = "{cycles:u,instructions:u,branches:u,branch-misses:u}"
CACHE_GROUP = "{cache-references:u,cache-misses:u}"
SOFTWARE_GROUP = "{context-switches,cpu-migrations,page-faults}"
EVENTS = (
    "cycles:u",
    "instructions:u",
    "branches:u",
    "branch-misses:u",
    "cache-references:u",
    "cache-misses:u",
    "context-switches:u",
    "cpu-migrations:u",
    "page-faults:u",
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.command[:1] == ["--"]:
        arguments.command = arguments.command[1:]
    if not arguments.command:
        parser.error("a command is required after --")
    return arguments


def parse_perf_stat(text: str) -> list[dict[str, Any]]:
    measurements: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split(";")
        if len(fields) < 5:
            raise ValueError(f"invalid perf stat record: {line!r}")
        encoded_value, unit, event, runtime_ns, percentage = fields[:5]
        if event not in EVENTS:
            continue
        supported = encoded_value not in {"<not counted>", "<not supported>"}
        try:
            value = int(encoded_value) if supported else None
            runtime = int(runtime_ns)
            running_percentage = float(percentage)
        except ValueError as error:
            raise ValueError(f"invalid perf stat value: {line!r}") from error
        measurements.append(
            {
                "event": event.removesuffix(":u"),
                "scope": "user" if event.endswith(":u") else "process",
                "unit": unit or "count",
                "supported": supported,
                "value": value,
                "counter_runtime_ns": runtime,
                "counter_running_percentage": running_percentage,
            }
        )
    observed = {measurement["event"] for measurement in measurements}
    expected = {event.removesuffix(":u") for event in EVENTS}
    if observed != expected:
        raise ValueError(f"perf stat event mismatch: {sorted(expected - observed)}")
    return measurements


def main() -> int:
    arguments = parse_arguments()
    if platform.system() != "Linux":
        print("perf-stat profiling requires Linux", file=sys.stderr)
        return 2
    perf = shutil.which("perf")
    if perf is None:
        print("perf is unavailable; use nix develop .#benchmarks", file=sys.stderr)
        return 2

    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    raw = arguments.output.with_suffix(arguments.output.suffix + ".perf-stat.txt")
    if arguments.output.exists() or raw.exists():
        print("perf-stat output already exists", file=sys.stderr)
        return 2
    command = [
        perf,
        "stat",
        "--no-big-num",
        "--field-separator=;",
        "--output",
        str(raw),
        "--event",
        HARDWARE_GROUP,
        "--event",
        CACHE_GROUP,
        "--event",
        SOFTWARE_GROUP,
        "--",
        *arguments.command,
    ]
    started = time.monotonic_ns()
    completed = subprocess.run(command, check=False)
    elapsed_ns = time.monotonic_ns() - started
    try:
        measurements = parse_perf_stat(raw.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"perf-stat parse failed: {error}", file=sys.stderr)
        return 2

    commit, dirty, diff = git_provenance()
    report = {
        "schema": 1,
        "suite": "lemma-linux-perf-stat",
        "generated_at": datetime.now(UTC).isoformat(),
        "scope": (
            "complete selected command and descendants, including explicit fixture setup and "
            "teardown; use workload-owned output for semantic endpoints"
        ),
        "system": platform.system(),
        "system_release": platform.release(),
        "host": platform.node(),
        "host_fingerprint": host_fingerprint(),
        "command": arguments.command,
        "returncode": completed.returncode,
        "elapsed_ns": elapsed_ns,
        "groups": [HARDWARE_GROUP, CACHE_GROUP, SOFTWARE_GROUP],
        "measurements": measurements,
        "raw_report": str(raw.resolve()),
        "commit": commit,
        "worktree_dirty": dirty,
        "worktree_diff_sha256": diff,
        "status": "completed" if completed.returncode == 0 else "command_failed",
    }
    arguments.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"perf-stat report: {arguments.output}")
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
