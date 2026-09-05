#!/usr/bin/env python3
"""Measure idle compiled-extension overhead and absence of daemon hot-path callbacks."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.support.mux_harness import LemmaServer  # noqa: E402

CONFIGURATION = """
local lemma = require("lemma")
lemma.setup({
  input = { preset = "none", prefix = false },
  terminal = { scrollback_lines = 5000 },
  ui = { status_line = false },
  launch = {
    default_cwd = "/tmp",
    default_program = { "/bin/sh" },
  },
})
lemma.keymap.set("normal", "M-z", "enter_copy_mode")
"""


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--peer", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--sample-ms", type=int, default=200)
    return parser.parse_args()


def descendants(process: int) -> list[int]:
    result = [process]
    pending = [process]
    while pending:
        parent = pending.pop()
        children_path = Path(f"/proc/{parent}/task/{parent}/children")
        if not children_path.exists():
            continue
        children = [int(value) for value in children_path.read_text().split()]
        result.extend(children)
        pending.extend(children)
    return result


def schedstat(process: int) -> dict[str, int]:
    values = [
        int(value) for value in Path(f"/proc/{process}/schedstat").read_text().split()
    ]
    return {
        "cpu_time_ns": values[0],
        "runqueue_wait_ns": values[1],
        "timeslices": values[2],
    }


def process_io(process: int) -> dict[str, int]:
    result = {}
    for line in Path(f"/proc/{process}/io").read_text().splitlines():
        field, value = line.split(":", maxsplit=1)
        result[field] = int(value)
    return result


def pss_bytes(process: int) -> int:
    for line in Path(f"/proc/{process}/smaps_rollup").read_text().splitlines():
        if line.startswith("Pss:"):
            return int(line.split()[1]) * 1_024
    raise RuntimeError("Pss missing from smaps_rollup")


def percentile(values: list[int], fraction: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def host_process(server: LemmaServer) -> int | None:
    for process in descendants(server.process.pid)[1:]:
        command_path = Path(f"/proc/{process}/cmdline")
        if not command_path.exists():
            continue
        command = command_path.read_bytes().split(b"\0", maxsplit=1)[0]
        if command == os.fsencode(server.server_path):
            return process
    return None


def deltas(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    return {field: after[field] - value for field, value in before.items()}


def run_profile(arguments: argparse.Namespace, configured: bool) -> dict[str, Any]:
    with LemmaServer(
        arguments.server,
        arguments.cli,
        arguments.peer,
        config_text=CONFIGURATION if configured else None,
    ) as server:
        session = server.create_session(
            "extension-idle", command=(str(server.peer_path), "idle")
        )
        session.pane().expect_output("__LEMMA_IDLE_READY__")
        host = host_process(server)
        if configured != (host is not None):
            raise RuntimeError("extension host ownership does not match configuration")
        time.sleep(0.1)
        samples: list[dict[str, Any]] = []
        for _ in range(arguments.repetitions):
            daemon_scheduler_before = schedstat(server.process.pid)
            daemon_io_before = process_io(server.process.pid)
            host_scheduler_before = schedstat(host) if host is not None else None
            time.sleep(arguments.sample_ms / 1_000)
            daemon_scheduler = deltas(
                daemon_scheduler_before, schedstat(server.process.pid)
            )
            daemon_io = deltas(daemon_io_before, process_io(server.process.pid))
            host_scheduler = (
                deltas(host_scheduler_before, schedstat(host))
                if host is not None and host_scheduler_before is not None
                else None
            )
            samples.append(
                {
                    "daemon_scheduler": daemon_scheduler,
                    "daemon_io": daemon_io,
                    "host_scheduler": host_scheduler,
                }
            )
        daemon_cpu = [sample["daemon_scheduler"]["cpu_time_ns"] for sample in samples]
        host_cpu = (
            [sample["host_scheduler"]["cpu_time_ns"] for sample in samples]
            if host is not None
            else []
        )
        processes = descendants(server.process.pid)
        return {
            "configured": configured,
            "extension_host": host,
            "process_count": len(processes),
            "process_tree_pss_bytes": sum(pss_bytes(process) for process in processes),
            "daemon_pss_bytes": pss_bytes(server.process.pid),
            "samples": samples,
            "daemon_cpu_p50_ns": int(statistics.median(daemon_cpu)),
            "daemon_cpu_p95_ns": percentile(daemon_cpu, 0.95),
            "extension_host_cpu_p50_ns": (
                int(statistics.median(host_cpu)) if host_cpu else None
            ),
            "extension_host_cpu_p95_ns": percentile(host_cpu, 0.95)
            if host_cpu
            else None,
            "daemon_write_syscalls_total": sum(
                sample["daemon_io"]["syscw"] for sample in samples
            ),
            "daemon_write_char_bytes_total": sum(
                sample["daemon_io"]["wchar"] for sample in samples
            ),
        }


def main() -> int:
    arguments = parse_arguments()
    if arguments.repetitions < 20 or arguments.sample_ms < 100:
        raise ValueError("need at least 20 samples of at least 100 ms")
    load_before = os.getloadavg()
    profiles = {
        "without_configuration": run_profile(arguments, False),
        "compiled_configuration": run_profile(arguments, True),
    }
    baseline = profiles["without_configuration"]
    configured = profiles["compiled_configuration"]
    report = {
        "schema": "lemma.extension-isolation/v1",
        "host": os.uname().nodename,
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "configuration": {
            "repetitions": arguments.repetitions,
            "sample_duration_ms": arguments.sample_ms,
        },
        "profiles": profiles,
        "compiled_configuration_deltas": {
            "process_count": configured["process_count"] - baseline["process_count"],
            "process_tree_pss_bytes": configured["process_tree_pss_bytes"]
            - baseline["process_tree_pss_bytes"],
            "daemon_pss_bytes": configured["daemon_pss_bytes"]
            - baseline["daemon_pss_bytes"],
            "daemon_cpu_p50_ns": configured["daemon_cpu_p50_ns"]
            - baseline["daemon_cpu_p50_ns"],
            "daemon_cpu_p95_ns": configured["daemon_cpu_p95_ns"]
            - baseline["daemon_cpu_p95_ns"],
        },
    }
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
