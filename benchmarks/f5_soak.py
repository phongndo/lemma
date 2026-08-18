#!/usr/bin/env python3
"""Bounded mixed-output Lemma soak with raw latency and resource evidence."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shlex
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mux_benchmark import (
    LATENCY_OUTPUT_READY,
    LemmaRuntime,
    PtyReceiptChannel,
    git_provenance,
    host_fingerprint,
    latency_samples,
    metric_summary,
    open_descriptor_snapshot,
    runtime_resource_snapshot,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resource_sample(runtime: LemmaRuntime, elapsed_ns: int) -> dict[str, Any]:
    resources = runtime_resource_snapshot(runtime)
    descriptors = open_descriptor_snapshot(runtime.server.pid)
    if (
        resources.get("available") is not True
        or descriptors.get("available") is not True
    ):
        raise RuntimeError("soak resource census became unavailable")
    daemon = resources.get("roles", {}).get("daemon", {})
    client = resources.get("roles", {}).get("attached_client", {})
    if daemon.get("available") is not True or client.get("available") is not True:
        raise RuntimeError(
            "soak daemon or attached-client resource role became unavailable"
        )
    return {
        "elapsed_ns": elapsed_ns,
        "tree_rss_bytes": int(resources["rss_bytes"]),
        "tree_cpu_time_ns": int(resources["cpu_time_ns"]),
        "process_count": int(resources["process_count"]),
        "daemon_rss_bytes": int(daemon["rss_bytes"]),
        "daemon_cpu_time_ns": int(daemon["cpu_time_ns"]),
        "client_rss_bytes": int(client["rss_bytes"]),
        "client_cpu_time_ns": int(client["cpu_time_ns"]),
        "daemon_open_descriptors": int(descriptors["count"]),
        "wakeups": resources["wakeups"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-seconds", type=float, default=86_400.0)
    parser.add_argument("--interaction-interval-seconds", type=float, default=1.0)
    parser.add_argument("--reattach-every", type=int, default=300)
    parser.add_argument("--resource-interval-seconds", type=float, default=60.0)
    parser.add_argument(
        "--server", type=Path, default=Path("build/release/lemma_test_server")
    )
    parser.add_argument(
        "--cli", type=Path, default=Path("build/release/lemma_test_cli")
    )
    parser.add_argument(
        "--peer", type=Path, default=Path("build/release/lemma_test_pty_peer")
    )
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if not 1.0 <= arguments.duration_seconds <= 172_800.0:
        parser.error("--duration-seconds must be between 1 and 172800")
    if not 0.05 <= arguments.interaction_interval_seconds <= 60.0:
        parser.error("--interaction-interval-seconds must be between 0.05 and 60")
    if not 1 <= arguments.reattach_every <= 100_000:
        parser.error("--reattach-every must be between 1 and 100000")
    if not 1.0 <= arguments.resource_interval_seconds <= 3_600.0:
        parser.error("--resource-interval-seconds must be between 1 and 3600")
    for executable in (arguments.server, arguments.cli, arguments.peer):
        if not executable.is_file():
            parser.error(f"missing executable: {executable}")

    def interrupted(signal_number: int, frame: Any) -> None:
        del frame
        raise InterruptedError(f"received signal {signal_number}")

    for signal_number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signal_number, interrupted)

    started_wall = utc_now()
    process_started_ns = time.monotonic_ns()
    requested_duration_ns = int(arguments.duration_seconds * 1_000_000_000)
    workload_started_ns: int | None = None
    workload_finished_ns: int | None = None
    runtime: LemmaRuntime | None = None
    receipts: PtyReceiptChannel | None = None
    interactions: list[dict[str, int]] = []
    resources: list[dict[str, Any]] = []
    restoration_checks = 0
    reattachments = 0
    failure: str | None = None
    try:
        runtime = LemmaRuntime(arguments.server, arguments.cli, arguments.peer)
        receipts = PtyReceiptChannel(runtime.receipt_path)
        client = runtime.start_and_attach("f5_mixed_soak")
        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency-output "
            f"{shlex.quote(str(runtime.receipt_path))}\r"
        ).encode()
        client.write_all(launch, 2.0)
        client.read_until(LATENCY_OUTPUT_READY, 5.0)
        client.drain(0.05)
        resources.append(resource_sample(runtime, 0))
        workload_started_ns = time.monotonic_ns()
        deadline_ns = workload_started_ns + requested_duration_ns
        next_resource_ns = workload_started_ns + int(
            arguments.resource_interval_seconds * 1_000_000_000
        )
        cycle = 0
        dimensions = ((80, 24), (111, 37), (40, 12), (160, 60), (73, 29))

        while time.monotonic_ns() < deadline_ns:
            cycle_started_ns = time.monotonic_ns()
            columns, rows = dimensions[cycle % len(dimensions)]
            client.resize(columns, rows)
            measured = latency_samples(
                client,
                receipts,
                "OUTPUT",
                1,
                wait_for_peer_ready=True,
            )
            interaction = {
                "cycle": cycle,
                "elapsed_ns": time.monotonic_ns() - workload_started_ns,
                "columns": columns,
                "rows": rows,
                "key_to_pty_ns": int(measured["key_to_pty"]["samples_ns"][0]),
                "key_to_visible_ns": int(measured["key_to_visible"]["samples_ns"][0]),
                "controlled_outer_bytes": int(measured["client_bytes"][0]),
            }
            cycle += 1

            if cycle % arguments.reattach_every == 0:
                runtime.detach(client, "f5_mixed_soak")
                if client.terminal_state_restored is not True:
                    raise RuntimeError("soak detach leaked outer-terminal state")
                restoration_checks += 1
                client = runtime.attach("f5_mixed_soak")
                client.drain(0.05)
                reattachments += 1

            now_ns = time.monotonic_ns()
            if now_ns >= next_resource_ns:
                resources.append(resource_sample(runtime, now_ns - workload_started_ns))
                next_resource_ns = now_ns + int(
                    arguments.resource_interval_seconds * 1_000_000_000
                )

            remaining_interval = arguments.interaction_interval_seconds - (
                (time.monotonic_ns() - cycle_started_ns) / 1_000_000_000
            )
            if remaining_interval > 0:
                interaction["background_outer_bytes"] = client.drain(
                    min(
                        remaining_interval,
                        max(0.0, (deadline_ns - time.monotonic_ns()) / 1e9),
                    )
                )
            else:
                interaction["background_outer_bytes"] = 0
            interactions.append(interaction)

        workload_finished_ns = time.monotonic_ns()
        if not interactions:
            raise RuntimeError("active soak interval completed without an interaction")
        resources.append(
            resource_sample(runtime, workload_finished_ns - workload_started_ns)
        )
        runtime.detach(client, "f5_mixed_soak")
        if client.terminal_state_restored is not True:
            raise RuntimeError("final soak detach leaked outer-terminal state")
        restoration_checks += 1
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        if workload_started_ns is not None and workload_finished_ns is None:
            workload_finished_ns = time.monotonic_ns()
        if runtime is not None:
            runtime.close()
        if receipts is not None:
            receipts.close()

    total_elapsed_ns = time.monotonic_ns() - process_started_ns
    elapsed_ns = (
        workload_finished_ns - workload_started_ns
        if workload_started_ns is not None and workload_finished_ns is not None
        else 0
    )
    completed = (
        failure is None and elapsed_ns >= requested_duration_ns and bool(interactions)
    )
    commit, dirty = git_provenance()
    report: dict[str, Any] = {
        "schema": 1,
        "suite": "f5-mixed-output-soak",
        "status": "completed" if completed else "failed",
        "failure": failure,
        "commit": commit,
        "worktree_dirty": dirty,
        "host": platform.node(),
        "host_fingerprint": host_fingerprint(),
        "system": platform.system(),
        "system_release": platform.release(),
        "architecture": platform.machine(),
        "build_profile": arguments.server.parent.name,
        "sanitizers": {
            "asan_options": os.environ.get("ASAN_OPTIONS"),
            "ubsan_options": os.environ.get("UBSAN_OPTIONS"),
        },
        "started_at": started_wall,
        "finished_at": utc_now(),
        "requested_duration_ns": requested_duration_ns,
        "setup_elapsed_ns": (
            workload_started_ns - process_started_ns
            if workload_started_ns is not None
            else None
        ),
        "elapsed_ns": elapsed_ns,
        "total_elapsed_ns": total_elapsed_ns,
        "interaction_interval_ns": int(
            arguments.interaction_interval_seconds * 1_000_000_000
        ),
        "reattach_every": arguments.reattach_every,
        "reattachments": reattachments,
        "terminal_restoration_checks": restoration_checks,
        "interactions": interactions,
        "resource_samples": resources,
    }
    if interactions:
        report["key_to_pty"] = metric_summary(
            [sample["key_to_pty_ns"] for sample in interactions], "ns"
        )
        report["key_to_visible"] = metric_summary(
            [sample["key_to_visible_ns"] for sample in interactions], "ns"
        )
        report["outer_bytes"] = metric_summary(
            [
                sample["controlled_outer_bytes"] + sample["background_outer_bytes"]
                for sample in interactions
            ],
            "bytes",
        )
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if completed else 1


if __name__ == "__main__":
    raise SystemExit(main())
