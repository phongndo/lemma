#!/usr/bin/env python3
"""Measure detached-Pane parking memory, storage, READY/full latency, and peak hydration PSS."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import threading
import time
from pathlib import Path

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
    parser.add_argument("--rows", type=int, default=5_000)
    parser.add_argument("--parking-delay-ms", type=int, default=10_000)
    parser.add_argument("--sample-peak-hydration-memory", action="store_true")
    return parser.parse_args()


def daemon_pss_bytes(process: int) -> int:
    for line in Path(f"/proc/{process}/smaps_rollup").read_text().splitlines():
        if line.startswith("Pss:"):
            return int(line.split()[1]) * 1_024
    raise RuntimeError("Pss missing from smaps_rollup")


def median_pss_bytes(process: int) -> int:
    samples = []
    for _ in range(5):
        samples.append(daemon_pss_bytes(process))
        time.sleep(0.01)
    return int(statistics.median(samples))


def daemon_rss_bytes(process: int) -> int:
    resident_pages = int(Path(f"/proc/{process}/statm").read_text().split()[1])
    return resident_pages * os.sysconf("SC_PAGE_SIZE")


def median_rss_bytes(process: int) -> int:
    samples = []
    for _ in range(5):
        samples.append(daemon_rss_bytes(process))
        time.sleep(0.002)
    return int(statistics.median(samples))


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


def percentile(values: list[int], fraction: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


class PeakMemorySampler:
    def __init__(self, process: int, metric: str) -> None:
        self.process = process
        self.metric = metric
        self.samples: list[int] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        if self.metric == "pss":
            while not self._stop.is_set():
                self.samples.append(daemon_pss_bytes(self.process))
                self._stop.wait(0.0005)
            return
        while not self._stop.is_set():
            self.samples.append(daemon_rss_bytes(self.process))
            self._stop.wait(0.00005)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join()


def main() -> int:
    arguments = parse_arguments()
    if arguments.sessions <= 0 or arguments.rows <= 0:
        raise ValueError("sessions and rows must be positive")
    load_before = os.getloadavg()
    started_ns = time.monotonic_ns()
    with LemmaServer(
        arguments.server,
        arguments.cli,
        arguments.peer,
        parking_delay_ms=arguments.parking_delay_ms,
    ) as server:
        pane_ids: list[str] = []
        for index in range(arguments.sessions):
            created_session = server.create_session(
                f"parking-{index}",
                attach=False,
                command=(
                    str(server.peer_path),
                    "parking",
                    str(arguments.rows),
                    str(index),
                ),
            )
            pane_ids.append(created_session.pane().id)

        for index, pane in enumerate(pane_ids):
            marker = f"__LEMMA_PARK_READY_{index:04d}__"
            wait_until(
                f"Pane {pane} to finish initial output",
                lambda: (
                    result
                    if (
                        result := server.command(
                            "pane", "capture", f"parking-{index}", pane
                        )
                    ).status
                    == 0
                    and marker in result.output
                    else None
                ),
                timeout=20.0,
                diagnostics=server.diagnostics,
            )
        time.sleep(0.1)
        active_mapping_count, _ = snapshot_mappings(server.process.pid)
        if active_mapping_count != 0:
            raise RuntimeError("a Pane parked before the active memory sample")
        active_pss = median_pss_bytes(server.process.pid)
        parked_count, parked_mapped_bytes = wait_until(
            "all detached Panes to park",
            lambda: (
                mapping
                if (mapping := snapshot_mappings(server.process.pid))[0]
                == arguments.sessions
                else None
            ),
            timeout=(arguments.parking_delay_ms / 1_000) + 10.0,
            diagnostics=server.diagnostics,
        )
        parked_pss = median_pss_bytes(server.process.pid)

        capture_count = max(1, arguments.sessions // 2)
        capture_ready_latencies_ns: list[int] = []
        capture_wake_latencies_ns: list[int] = []
        for index, pane in enumerate(pane_ids[:capture_count]):
            session_name = f"parking-{index}"
            wake_started = time.monotonic_ns()
            initial = server.command("pane", "capture", session_name, pane)
            if initial.status == 0 or "unavailable" not in initial.output:
                raise RuntimeError(
                    f"parked capture did not request hydration: {initial}"
                )
            capture_ready_latencies_ns.append(time.monotonic_ns() - wake_started)
            captured = wait_until(
                f"Pane {pane} full hydration",
                lambda: (
                    result
                    if (
                        result := server.command("pane", "capture", session_name, pane)
                    ).status
                    == 0
                    else None
                ),
                timeout=10.0,
                diagnostics=server.diagnostics,
            )
            capture_wake_latencies_ns.append(time.monotonic_ns() - wake_started)
            if f"__LEMMA_PARK_READY_{index:04d}__" not in captured.output:
                raise RuntimeError(f"hydrated capture lost marker for {session_name}")

        attach_wake_latencies_ns: list[int] = []
        for index, _pane in enumerate(pane_ids[capture_count:], start=capture_count):
            session_name = f"parking-{index}"
            wake_started = time.monotonic_ns()
            client = server.attach(session_name)
            client.expect_output(f"__LEMMA_PARK_READY_{index:04d}__")
            attach_wake_latencies_ns.append(time.monotonic_ns() - wake_started)
            client.close()
            wait_until(
                f"hydrated Session {session_name} to detach",
                lambda: (
                    state
                    if (state := server.session_state(session_name)) is not None
                    and not state.attached
                    else None
                ),
                diagnostics=server.diagnostics,
            )

        peak_hydration_pss: int | None = None
        peak_hydration_samples = 0
        peak_hydration_rss: int | None = None
        peak_hydration_rss_samples = 0
        if arguments.sample_peak_hydration_memory:
            wait_until(
                "all hydrated Panes to re-park for peak-memory sampling",
                lambda: (
                    mapping
                    if (mapping := snapshot_mappings(server.process.pid))[0]
                    == arguments.sessions
                    else None
                ),
                timeout=(arguments.parking_delay_ms / 1_000) + 10.0,
                diagnostics=server.diagnostics,
            )
            pss_sampler = PeakMemorySampler(server.process.pid, "pss")
            rss_sampler = PeakMemorySampler(server.process.pid, "rss")
            pss_sampler.start()
            rss_sampler.start()
            try:
                for index, pane in enumerate(pane_ids):
                    session_name = f"parking-{index}"
                    initial = server.command("pane", "capture", session_name, pane)
                    if initial.status == 0 or "unavailable" not in initial.output:
                        raise RuntimeError(
                            f"peak-memory capture did not request hydration: {initial}"
                        )
                    wait_until(
                        f"Pane {pane} peak-memory hydration",
                        lambda: (
                            result
                            if (
                                result := server.command(
                                    "pane", "capture", session_name, pane
                                )
                            ).status
                            == 0
                            else None
                        ),
                        timeout=10.0,
                        diagnostics=server.diagnostics,
                    )
                pss_sampler.samples.append(daemon_pss_bytes(server.process.pid))
                rss_sampler.samples.append(daemon_rss_bytes(server.process.pid))
            finally:
                pss_sampler.stop()
                rss_sampler.stop()
            peak_hydration_samples = len(pss_sampler.samples)
            peak_hydration_rss_samples = len(rss_sampler.samples)
            if pss_sampler.samples:
                peak_hydration_pss = max(pss_sampler.samples)
            if rss_sampler.samples:
                peak_hydration_rss = max(rss_sampler.samples)

        restored_pss = median_pss_bytes(server.process.pid)
        restored_rss = median_rss_bytes(server.process.pid)
        final_mapping_count, final_mapped_bytes = snapshot_mappings(server.process.pid)

    report = {
        "schema": "lemma.parking-probe/v1",
        "host": os.uname().nodename,
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "configuration": {
            "sessions": arguments.sessions,
            "rows_per_pane": arguments.rows,
            "parking_delay_ms": arguments.parking_delay_ms,
            "sample_peak_hydration_memory": arguments.sample_peak_hydration_memory,
            "server": str(Path(arguments.server).resolve()),
        },
        "measurements": {
            "active_daemon_pss_bytes": active_pss,
            "parked_daemon_pss_bytes": parked_pss,
            "restored_daemon_pss_bytes": restored_pss,
            "restored_daemon_rss_bytes": restored_rss,
            "parked_pss_saved_bytes": active_pss - parked_pss,
            "parked_pss_saved_percent": ((active_pss - parked_pss) / active_pss)
            * 100.0,
            "parked_snapshot_mappings": parked_count,
            "parked_snapshot_mapped_bytes": parked_mapped_bytes,
            "parked_snapshot_mapped_bytes_per_pane": parked_mapped_bytes
            // parked_count,
            "final_snapshot_mappings": final_mapping_count,
            "final_snapshot_mapped_bytes": final_mapped_bytes,
            "peak_hydration_daemon_pss_bytes": peak_hydration_pss,
            "peak_hydration_over_restored_pss_bytes": (
                max(0, peak_hydration_pss - restored_pss)
                if peak_hydration_pss is not None
                else None
            ),
            "peak_hydration_samples": peak_hydration_samples,
            "peak_hydration_sampling_interval_ns": 500_000,
            "peak_hydration_daemon_rss_bytes": peak_hydration_rss,
            "peak_hydration_rss_over_restored_rss_bytes": (
                max(0, peak_hydration_rss - restored_rss)
                if peak_hydration_rss is not None
                else None
            ),
            "peak_hydration_rss_samples": peak_hydration_rss_samples,
            "peak_hydration_rss_sampling_interval_ns": 50_000,
            "capture_ready_ack_latency_ns": capture_ready_latencies_ns,
            "capture_ready_ack_latency_p50_ns": int(
                statistics.median(capture_ready_latencies_ns)
            ),
            "capture_ready_ack_latency_p95_ns": percentile(
                capture_ready_latencies_ns, 0.95
            ),
            "capture_ready_ack_scope": (
                "fresh legacy CLI process start through daemon wake and Ghostty READY, "
                "ending at the retryable unavailable response"
            ),
            "capture_full_wake_latency_ns": capture_wake_latencies_ns,
            "capture_full_wake_latency_p50_ns": int(
                statistics.median(capture_wake_latencies_ns)
            ),
            "capture_full_wake_latency_p95_ns": percentile(
                capture_wake_latencies_ns, 0.95
            ),
            "attach_full_wake_latency_ns": attach_wake_latencies_ns,
            "attach_full_wake_latency_p50_ns": (
                int(statistics.median(attach_wake_latencies_ns))
                if attach_wake_latencies_ns
                else None
            ),
            "attach_full_wake_latency_p95_ns": (
                percentile(attach_wake_latencies_ns, 0.95)
                if attach_wake_latencies_ns
                else None
            ),
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
