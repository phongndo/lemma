#!/usr/bin/env python3
"""Measure Ghostty allocator and anonymous-mapping behavior across terminal states."""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

COUNTS = (0, 1, 4, 16, 64)
SCROLLBACK_LINES = (0, 1, 100, 5_000)
MAPPING_HEADER = re.compile(
    r"^(?P<start>[0-9a-f]+)-(?P<end>[0-9a-f]+) "
    r"(?P<permissions>\S+) \S+ \S+ \S+(?:\s+(?P<path>.*))?$"
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--scrollback-lines",
        default=",".join(str(lines) for lines in SCROLLBACK_LINES),
    )
    parser.add_argument("--counts", default=",".join(str(count) for count in COUNTS))
    return parser.parse_args()


def read_report(process: subprocess.Popen[str], expected_stage: str) -> dict[str, Any]:
    assert process.stdout is not None
    ready = process.stdout.readline()
    if not ready:
        stderr = "" if process.stderr is None else process.stderr.read()
        raise RuntimeError(f"terminal probe exited before {expected_stage}: {stderr}")
    report = json.loads(ready)
    if report.get("stage") != expected_stage:
        raise RuntimeError(f"expected {expected_stage}, received {report}")
    return report


def parse_smaps(process: int) -> dict[str, Any]:
    mappings: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in Path(f"/proc/{process}/smaps").read_text().splitlines():
        header = MAPPING_HEADER.match(line)
        if header is not None:
            current = {
                "virtual_bytes": int(header["end"], 16) - int(header["start"], 16),
                "permissions": header["permissions"],
                "path": header["path"] or "",
            }
            mappings.append(current)
            continue
        if current is None or ":" not in line:
            continue
        field, value = line.split(":", 1)
        words = value.split()
        if words and words[0].isdigit():
            current[field] = int(words[0]) * 1_024

    def aggregate(selected: list[dict[str, Any]]) -> dict[str, int]:
        return {
            "mapping_count": len(selected),
            "virtual_bytes": sum(mapping["virtual_bytes"] for mapping in selected),
            "rss_bytes": sum(mapping.get("Rss", 0) for mapping in selected),
            "pss_bytes": sum(mapping.get("Pss", 0) for mapping in selected),
            "private_dirty_bytes": sum(
                mapping.get("Private_Dirty", 0) for mapping in selected
            ),
            "anonymous_bytes": sum(mapping.get("Anonymous", 0) for mapping in selected),
        }

    anonymous = [
        mapping
        for mapping in mappings
        if mapping["path"] == "" or mapping["path"].startswith("[anon:")
    ]
    anonymous_writable = [
        mapping for mapping in anonymous if "w" in mapping["permissions"]
    ]
    heap = [mapping for mapping in mappings if mapping["path"] == "[heap]"]
    size_histogram: dict[str, dict[str, int]] = {}
    for mapping in anonymous_writable:
        key = str(mapping["virtual_bytes"])
        bucket = size_histogram.setdefault(
            key, {"mapping_count": 0, "rss_bytes": 0, "private_dirty_bytes": 0}
        )
        bucket["mapping_count"] += 1
        bucket["rss_bytes"] += mapping.get("Rss", 0)
        bucket["private_dirty_bytes"] += mapping.get("Private_Dirty", 0)
    return {
        "all": aggregate(mappings),
        "anonymous": aggregate(anonymous),
        "anonymous_writable": aggregate(anonymous_writable),
        "heap": aggregate(heap),
        "anonymous_writable_size_histogram": size_histogram,
    }


def stable_memory(process: int) -> dict[str, Any]:
    samples = []
    for _ in range(5):
        samples.append(parse_smaps(process))
        time.sleep(0.01)
    result = samples[-1]
    for group in ("all", "anonymous", "anonymous_writable", "heap"):
        for field in (
            "mapping_count",
            "virtual_bytes",
            "rss_bytes",
            "pss_bytes",
            "private_dirty_bytes",
            "anonymous_bytes",
        ):
            result[group][field] = int(
                statistics.median(sample[group][field] for sample in samples)
            )
    return result


def command(process: subprocess.Popen[str], value: str, stage: str) -> dict[str, Any]:
    assert process.stdin is not None
    process.stdin.write(value + "\n")
    process.stdin.flush()
    probe = read_report(process, stage)
    time.sleep(0.05)
    return {"probe": probe, "memory": stable_memory(process.pid)}


def run_profile(probe: Path, count: int, scrollback_lines: int) -> dict[str, Any]:
    process = subprocess.Popen(
        [str(probe), str(count), str(scrollback_lines)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        empty_report = read_report(process, "empty")
        time.sleep(0.05)
        empty = {"probe": empty_report, "memory": stable_memory(process.pid)}
        history = command(process, "history", "history")
        cleared_immediate = command(process, "clear", "cleared")
        time.sleep(1.0)
        cleared_settled = {
            "probe": cleared_immediate["probe"],
            "memory": stable_memory(process.pid),
        }
        return {
            "terminals": count,
            "scrollback_lines_max": scrollback_lines,
            "empty": empty,
            "history": history,
            "cleared_immediate": cleared_immediate,
            "cleared_settled": cleared_settled,
        }
    finally:
        if process.poll() is None and process.stdin is not None:
            process.stdin.write("exit\n")
            process.stdin.flush()
        process.communicate(timeout=5.0)
        if process.returncode != 0:
            raise RuntimeError(
                f"terminal memory probe failed with {process.returncode}"
            )


def profile_deltas(profiles: dict[str, dict[str, Any]]) -> dict[str, Any]:
    baseline = profiles["P0"]
    comparisons: dict[str, Any] = {}
    for name, profile in profiles.items():
        if name == "P0":
            continue
        count = int(name.removeprefix("P"))
        stages: dict[str, Any] = {}
        for stage in ("empty", "history", "cleared_immediate", "cleared_settled"):
            memory: dict[str, Any] = {}
            for group in ("all", "anonymous", "anonymous_writable", "heap"):
                memory[group] = {}
                for field in (
                    "mapping_count",
                    "virtual_bytes",
                    "rss_bytes",
                    "pss_bytes",
                    "private_dirty_bytes",
                    "anonymous_bytes",
                ):
                    delta = (
                        profile[stage]["memory"][group][field]
                        - baseline[stage]["memory"][group][field]
                    )
                    memory[group][field] = {
                        "total_delta": delta,
                        "per_terminal_delta": delta // count,
                    }
            allocator_delta = (
                profile[stage]["probe"]["allocator_bytes_current"]
                - baseline[stage]["probe"]["allocator_bytes_current"]
            )
            stages[stage] = {
                "memory": memory,
                "allocator_bytes_current": {
                    "total_delta": allocator_delta,
                    "per_terminal_delta": allocator_delta // count,
                },
            }
        stages["history_to_cleared_settled"] = {
            field: {
                "total_delta": (
                    profile["cleared_settled"]["memory"]["anonymous_writable"][field]
                    - profile["history"]["memory"]["anonymous_writable"][field]
                ),
                "per_terminal_delta": (
                    profile["cleared_settled"]["memory"]["anonymous_writable"][field]
                    - profile["history"]["memory"]["anonymous_writable"][field]
                )
                // count,
            }
            for field in ("virtual_bytes", "rss_bytes", "private_dirty_bytes")
        }
        comparisons[f"P{count}"] = stages
    return comparisons


def main() -> int:
    arguments = parse_arguments()
    probe = Path(arguments.probe).resolve()
    if not probe.is_file():
        raise FileNotFoundError(probe)
    scrollback_values = tuple(
        int(value) for value in arguments.scrollback_lines.split(",")
    )
    if not scrollback_values or any(
        value not in SCROLLBACK_LINES for value in scrollback_values
    ):
        raise ValueError("scrollback-lines must select values from 0,1,100,5000")
    counts = tuple(int(value) for value in arguments.counts.split(","))
    if (
        not counts
        or counts[0] != 0
        or len(set(counts)) != len(counts)
        or any(count < 0 or count > 64 for count in counts)
    ):
        raise ValueError(
            "counts must be unique values from 0 through 64, beginning with 0"
        )
    load_before = os.getloadavg()
    configurations: dict[str, Any] = {}
    for scrollback_lines in scrollback_values:
        profiles = {
            f"P{count}": run_profile(probe, count, scrollback_lines) for count in counts
        }
        configurations[f"S{scrollback_lines}"] = {
            "scrollback_lines_max": scrollback_lines,
            "profiles": profiles,
            "comparisons_to_P0": profile_deltas(profiles),
        }
    report = {
        "schema": "lemma.ghostty-page-pool/v2",
        "host": os.uname().nodename,
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "configuration": {
            "terminal_counts": counts,
            "scrollback_lines_max": scrollback_values,
            "geometry": {"columns": 80, "rows": 24},
            "history_rows_written": 5_100,
        },
        "configurations": configurations,
    }
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
