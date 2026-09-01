#!/usr/bin/env python3
"""Validate and record the approved local performance-host state."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mux_benchmark import host_fingerprint


def read_values(pattern: str) -> list[str]:
    values: set[str] = set()
    for path in Path("/").glob(pattern.lstrip("/")):
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            values.add(value)
    return sorted(values)


def host_snapshot() -> dict[str, Any]:
    return {
        "captured_at": datetime.now(UTC).isoformat(),
        "fingerprint": host_fingerprint(),
        "system": platform.system(),
        "system_release": platform.release(),
        "architecture": platform.machine(),
        "logical_cpu_count": os.cpu_count(),
        "load_average": list(os.getloadavg()),
        "scaling_governors": read_values(
            "/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor"
        ),
        "energy_performance_preferences": read_values(
            "/sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference"
        ),
    }


def validate(snapshot: dict[str, Any], policy: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    fingerprint = snapshot["fingerprint"]
    exact = {
        "host_name": fingerprint.get("host_name"),
        "system": snapshot.get("system"),
        "architecture": snapshot.get("architecture"),
        "cpu_model": fingerprint.get("cpu_model"),
        "physical_cpu_count": fingerprint.get("physical_cpu_count"),
        "logical_cpu_count": snapshot.get("logical_cpu_count"),
        "model_identifier": fingerprint.get("model_identifier"),
        "scaling_governors": snapshot.get("scaling_governors"),
        "energy_performance_preferences": snapshot.get(
            "energy_performance_preferences"
        ),
    }
    for field, observed in exact.items():
        if policy.get(field) != observed:
            failures.append(
                f"{field} mismatch: observed {observed!r}, expected {policy.get(field)!r}"
            )
    memory = fingerprint.get("memory_bytes")
    if not isinstance(memory, int) or memory < policy["minimum_memory_bytes"]:
        failures.append("installed memory is below the approved-host minimum")
    load = snapshot.get("load_average")
    if (
        not isinstance(load, list)
        or not load
        or load[0] > policy["maximum_load_average_1m"]
    ):
        failures.append("one-minute load average exceeds the approved-host maximum")
    return failures


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--policy", type=Path, default=Path("benchmarks/performance_hosts.json")
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    document = json.loads(arguments.policy.read_text(encoding="utf-8"))
    if document.get("schema") != 1 or not isinstance(document.get("hosts"), dict):
        raise SystemExit("performance host policy must use schema 1")
    snapshot = host_snapshot()
    name = snapshot["fingerprint"]["host_name"]
    policy = document["hosts"].get(name)
    failures = (
        [f"host {name!r} is not approved"]
        if not isinstance(policy, dict)
        else validate(snapshot, policy)
    )
    report = {
        "schema": 1,
        "suite": "lemma-performance-host",
        "status": "failed" if failures else "passed",
        "policy": str(arguments.policy.resolve()),
        "cpu_affinity": policy.get("cpu_affinity")
        if isinstance(policy, dict)
        else None,
        "failures": failures,
        **snapshot,
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    if failures:
        for failure in failures:
            print(f"performance host error: {failure}", file=sys.stderr)
        return 1
    print(f"approved performance host: {name}; report: {arguments.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
