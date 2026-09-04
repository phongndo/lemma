#!/usr/bin/env python3
"""Measure the ownership and wake cost of active-only dedicated reactor threads."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

THREAD_COUNTS = (0, 1, 64, 256, 512)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def status_values(path: Path) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in path.read_text().splitlines():
        if ":" not in line:
            continue
        field, text = line.split(":", 1)
        words = text.split()
        if words and words[0].isdigit():
            multiplier = 1_024 if len(words) > 1 and words[1] == "kB" else 1
            values[field] = int(words[0]) * multiplier
    return values


def rollup_values(process: int) -> dict[str, int]:
    status = status_values(Path(f"/proc/{process}/smaps_rollup"))
    return {
        "pss_bytes": status["Pss"],
        "private_dirty_bytes": status["Private_Dirty"],
        "anonymous_bytes": status["Anonymous"],
    }


def task_scheduler_values(process: int) -> dict[str, int]:
    totals = {
        "cpu_time_ns": 0,
        "runqueue_wait_ns": 0,
        "timeslices": 0,
        "voluntary_context_switches": 0,
        "involuntary_context_switches": 0,
    }
    for task in Path(f"/proc/{process}/task").iterdir():
        scheduler = [int(value) for value in (task / "schedstat").read_text().split()]
        totals["cpu_time_ns"] += scheduler[0]
        totals["runqueue_wait_ns"] += scheduler[1]
        totals["timeslices"] += scheduler[2]
        status = status_values(task / "status")
        totals["voluntary_context_switches"] += status.get("voluntary_ctxt_switches", 0)
        totals["involuntary_context_switches"] += status.get(
            "nonvoluntary_ctxt_switches", 0
        )
    return totals


def sample(process: int) -> dict[str, int]:
    status = status_values(Path(f"/proc/{process}/status"))
    return {
        "threads": status["Threads"],
        "virtual_bytes": status["VmSize"],
        "rss_bytes": status["VmRSS"],
        "peak_rss_bytes": status["VmHWM"],
        "descriptors": len(list(Path(f"/proc/{process}/fd").iterdir())),
        **rollup_values(process),
        **task_scheduler_values(process),
    }


def stable_sample(process: int) -> dict[str, int]:
    samples = []
    for _ in range(5):
        samples.append(sample(process))
        time.sleep(0.02)
    result = samples[-1]
    for field in (
        "virtual_bytes",
        "rss_bytes",
        "peak_rss_bytes",
        "pss_bytes",
        "private_dirty_bytes",
        "anonymous_bytes",
    ):
        result[field] = int(statistics.median(entry[field] for entry in samples))
    return result


def run_profile(probe: Path, threads: int) -> dict[str, Any]:
    process = subprocess.Popen(
        [str(probe), str(threads)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        line = process.stdout.readline()
        if not line:
            stderr = "" if process.stderr is None else process.stderr.read()
            raise RuntimeError(
                f"thread probe failed to start {threads} workers: {stderr}"
            )
        ready = json.loads(line)
        if ready != {"stage": "idle", "worker_threads": threads}:
            raise RuntimeError(f"unexpected thread probe readiness: {ready}")
        idle = stable_sample(process.pid)
        assert process.stdin is not None
        started = time.monotonic_ns()
        process.stdin.write("stop\n")
        process.stdin.flush()
        stopped = json.loads(process.stdout.readline())
        wake_and_join_ns = time.monotonic_ns() - started
        if stopped != {"stage": "stopped"}:
            raise RuntimeError(f"unexpected thread probe completion: {stopped}")
        process.wait(timeout=10.0)
        if process.returncode != 0:
            raise RuntimeError(f"thread probe exited with {process.returncode}")
        return {
            "worker_threads": threads,
            "idle": idle,
            "wake_and_join_ns": wake_and_join_ns,
        }
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=2.0)


def comparisons(profiles: dict[str, dict[str, Any]]) -> dict[str, Any]:
    baseline = profiles["T0"]["idle"]
    result = {}
    for threads in THREAD_COUNTS[1:]:
        profile = profiles[f"T{threads}"]
        deltas = {}
        for field in (
            "virtual_bytes",
            "rss_bytes",
            "pss_bytes",
            "private_dirty_bytes",
            "anonymous_bytes",
            "descriptors",
            "cpu_time_ns",
            "runqueue_wait_ns",
            "timeslices",
            "voluntary_context_switches",
            "involuntary_context_switches",
        ):
            delta = profile["idle"][field] - baseline[field]
            deltas[field] = {
                "total_delta": delta,
                "per_worker_delta": delta // threads,
            }
        result[f"T{threads}"] = {
            "idle_deltas": deltas,
            "wake_and_join_ns": profile["wake_and_join_ns"],
            "wake_and_join_ns_per_worker": profile["wake_and_join_ns"] // threads,
        }
    return result


def main() -> int:
    arguments = parse_arguments()
    probe = Path(arguments.probe).resolve()
    if not probe.is_file():
        raise FileNotFoundError(probe)
    load_before = os.getloadavg()
    profiles = {f"T{count}": run_profile(probe, count) for count in THREAD_COUNTS}
    report = {
        "schema": "lemma.reactor-topology/v1",
        "host": os.uname().nodename,
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "configuration": {"worker_thread_counts": THREAD_COUNTS},
        "profiles": profiles,
        "comparisons_to_T0": comparisons(profiles),
        "unavailable_metrics": [
            "kernel memory charged outside process smaps",
            "RAPL energy counters on this host",
            "Darwin scheduler and kqueue execution",
        ],
    }
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
