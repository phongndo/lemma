#!/usr/bin/env python3
"""Exercise repeated snapshot parking/hydration and verify bounded resource convergence."""

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

from tests.support.mux_harness import LemmaServer, wait_until  # noqa: E402


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--peer", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sessions", type=int, default=16)
    parser.add_argument("--rows", type=int, default=1_000)
    parser.add_argument("--cycles", type=int, default=50)
    parser.add_argument("--parking-delay-ms", type=int, default=25)
    return parser.parse_args()


def daemon_rollup_bytes(process: int, field: str) -> int:
    for line in Path(f"/proc/{process}/smaps_rollup").read_text().splitlines():
        if line.startswith(field + ":"):
            return int(line.split()[1]) * 1_024
    raise RuntimeError(f"{field} missing from smaps_rollup")


def daemon_rss_bytes(process: int) -> int:
    resident_pages = int(Path(f"/proc/{process}/statm").read_text().split()[1])
    return resident_pages * os.sysconf("SC_PAGE_SIZE")


def daemon_descriptors(process: int) -> int:
    return len(list(Path(f"/proc/{process}/fd").iterdir()))


def descendant_count(process: int) -> int:
    pending = [process]
    descendants = 0
    while pending:
        parent = pending.pop()
        children_path = Path(f"/proc/{parent}/task/{parent}/children")
        if not children_path.exists():
            continue
        children = [int(value) for value in children_path.read_text().split()]
        descendants += len(children)
        pending.extend(children)
    return 1 + descendants


def snapshot_mappings(process: int) -> tuple[int, int]:
    count = 0
    mapped_bytes = 0
    for line in Path(f"/proc/{process}/maps").read_text().splitlines():
        if ".lemma-pane-snapshot-" not in line:
            continue
        start_text, end_text = line.split(maxsplit=1)[0].split("-", maxsplit=1)
        count += 1
        mapped_bytes += int(end_text, 16) - int(start_text, 16)
    return count, mapped_bytes


def sample_resources(process: int) -> dict[str, int]:
    mappings, mapped_bytes = snapshot_mappings(process)
    return {
        "daemon_pss_bytes": daemon_rollup_bytes(process, "Pss"),
        "daemon_private_dirty_bytes": daemon_rollup_bytes(process, "Private_Dirty"),
        "daemon_rss_bytes": daemon_rss_bytes(process),
        "daemon_descriptors": daemon_descriptors(process),
        "process_tree_processes": descendant_count(process),
        "snapshot_mappings": mappings,
        "snapshot_mapped_bytes": mapped_bytes,
    }


def percentile(values: list[int], fraction: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def slope(values: list[int]) -> float:
    if len(values) < 2:
        return 0.0
    center = (len(values) - 1) / 2
    denominator = sum((index - center) ** 2 for index in range(len(values)))
    return (
        sum((index - center) * value for index, value in enumerate(values))
        / denominator
    )


def main() -> int:
    arguments = parse_arguments()
    if (
        arguments.sessions <= 0
        or arguments.sessions > 64
        or arguments.rows <= 0
        or arguments.cycles < 20
        or arguments.parking_delay_ms <= 0
    ):
        raise ValueError("invalid bounded parking churn configuration")
    load_before = os.getloadavg()
    started_ns = time.monotonic_ns()
    with LemmaServer(
        arguments.server,
        arguments.cli,
        arguments.peer,
        parking_delay_ms=arguments.parking_delay_ms,
    ) as server:
        anchor = server.create_session(
            "parking-churn-anchor",
            command=(str(server.peer_path), "idle"),
        )
        anchor.pane().expect_output("__LEMMA_IDLE_READY__")
        baseline = sample_resources(server.process.pid)

        panes: list[tuple[str, str]] = []
        for index in range(arguments.sessions):
            name = f"parking-churn-{index}"
            session = server.create_session(
                name,
                attach=False,
                command=(
                    str(server.peer_path),
                    "parking",
                    str(arguments.rows),
                    str(index),
                ),
            )
            pane = session.pane()
            panes.append((name, pane.id))
            marker = f"__LEMMA_PARK_READY_{index:04d}__"
            wait_until(
                f"{name} initial output",
                lambda name=name, pane_id=pane.id, marker=marker: (
                    result
                    if (
                        result := server.command("pane", "capture", name, pane_id)
                    ).status
                    == 0
                    and marker in result.output
                    else None
                ),
                timeout=20.0,
                diagnostics=server.diagnostics,
            )

        hydrated_samples: list[dict[str, int]] = []
        parked_samples: list[dict[str, int]] = []
        hydration_latencies_ns: list[int] = []
        for cycle in range(arguments.cycles):
            wait_until(
                f"cycle {cycle} parked mappings",
                lambda: (
                    resources
                    if (resources := sample_resources(server.process.pid))[
                        "snapshot_mappings"
                    ]
                    == arguments.sessions
                    else None
                ),
                timeout=(arguments.parking_delay_ms / 1_000) + 10.0,
                diagnostics=server.diagnostics,
            )
            parked_samples.append(sample_resources(server.process.pid))

            hydration_started = time.monotonic_ns()
            for index, (name, pane) in enumerate(panes):
                initial = server.command("pane", "capture", name, pane)
                if initial.status == 0 or "unavailable" not in initial.output:
                    raise RuntimeError(
                        f"cycle {cycle} did not begin hydration: {initial}"
                    )
                capture = wait_until(
                    f"cycle {cycle} hydrate {name}",
                    lambda name=name, pane=pane: (
                        result
                        if (
                            result := server.command("pane", "capture", name, pane)
                        ).status
                        == 0
                        else None
                    ),
                    timeout=10.0,
                    diagnostics=server.diagnostics,
                )
                if f"__LEMMA_PARK_READY_{index:04d}__" not in capture.output:
                    raise RuntimeError(f"cycle {cycle} lost content for {name}")
            hydration_latencies_ns.append(time.monotonic_ns() - hydration_started)
            hydrated = sample_resources(server.process.pid)
            if hydrated["snapshot_mappings"] != 0:
                raise RuntimeError(
                    f"cycle {cycle} retained a hydrated snapshot mapping"
                )
            hydrated_samples.append(hydrated)

        for name, _pane in panes:
            result = server.command("kill", name)
            if result.status != 0:
                raise RuntimeError(f"failed to destroy {name}: {result.output}")
        wait_until(
            "parking churn cleanup",
            lambda: (
                resources
                if (resources := sample_resources(server.process.pid))[
                    "process_tree_processes"
                ]
                == baseline["process_tree_processes"]
                and resources["snapshot_mappings"] == 0
                else None
            ),
            timeout=10.0,
            diagnostics=server.diagnostics,
        )
        final_samples = []
        for _ in range(10):
            final_samples.append(sample_resources(server.process.pid))
            time.sleep(0.02)

    parked_pss = [sample["daemon_pss_bytes"] for sample in parked_samples]
    hydrated_pss = [sample["daemon_pss_bytes"] for sample in hydrated_samples]
    final_pss = [sample["daemon_pss_bytes"] for sample in final_samples]
    parked_private_dirty = [
        sample["daemon_private_dirty_bytes"] for sample in parked_samples
    ]
    hydrated_private_dirty = [
        sample["daemon_private_dirty_bytes"] for sample in hydrated_samples
    ]
    final_private_dirty = [
        sample["daemon_private_dirty_bytes"] for sample in final_samples
    ]
    report: dict[str, Any] = {
        "schema": "lemma.parking-churn/v1",
        "host": os.uname().nodename,
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "configuration": {
            "sessions": arguments.sessions,
            "rows_per_pane": arguments.rows,
            "cycles": arguments.cycles,
            "parking_delay_ms": arguments.parking_delay_ms,
        },
        "baseline": baseline,
        "parked_samples": parked_samples,
        "hydrated_samples": hydrated_samples,
        "final_samples": final_samples,
        "measurements": {
            "hydration_latency_ns": hydration_latencies_ns,
            "hydration_latency_p50_ns": int(statistics.median(hydration_latencies_ns)),
            "hydration_latency_p95_ns": percentile(hydration_latencies_ns, 0.95),
            "parked_daemon_pss_p50_bytes": int(statistics.median(parked_pss)),
            "parked_daemon_pss_p95_bytes": percentile(parked_pss, 0.95),
            "parked_daemon_pss_slope_bytes_per_cycle": slope(parked_pss),
            "hydrated_daemon_pss_p50_bytes": int(statistics.median(hydrated_pss)),
            "hydrated_daemon_pss_p95_bytes": percentile(hydrated_pss, 0.95),
            "hydrated_daemon_pss_slope_bytes_per_cycle": slope(hydrated_pss),
            "parked_daemon_private_dirty_p50_bytes": int(
                statistics.median(parked_private_dirty)
            ),
            "parked_daemon_private_dirty_p95_bytes": percentile(
                parked_private_dirty, 0.95
            ),
            "parked_daemon_private_dirty_slope_bytes_per_cycle": slope(
                parked_private_dirty
            ),
            "hydrated_daemon_private_dirty_p50_bytes": int(
                statistics.median(hydrated_private_dirty)
            ),
            "hydrated_daemon_private_dirty_p95_bytes": percentile(
                hydrated_private_dirty, 0.95
            ),
            "hydrated_daemon_private_dirty_slope_bytes_per_cycle": slope(
                hydrated_private_dirty
            ),
            "final_daemon_private_dirty_range_bytes": max(final_private_dirty)
            - min(final_private_dirty),
            "final_daemon_private_dirty_slope_bytes_per_sample": slope(
                final_private_dirty
            ),
            "final_daemon_pss_range_bytes": max(final_pss) - min(final_pss),
            "final_daemon_pss_slope_bytes_per_sample": slope(final_pss),
            "final_descriptor_delta": final_samples[-1]["daemon_descriptors"]
            - baseline["daemon_descriptors"],
            "final_process_delta": final_samples[-1]["process_tree_processes"]
            - baseline["process_tree_processes"],
            "final_snapshot_mappings": final_samples[-1]["snapshot_mappings"],
            "elapsed_ns": time.monotonic_ns() - started_ns,
        },
    }
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
