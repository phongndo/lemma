#!/usr/bin/env python3
"""Measure passive screen-observer scaling, including one stalled observer."""

from __future__ import annotations

import argparse
import json
import os
import select
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import IO, Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.support.mux_harness import LemmaServer  # noqa: E402

VIEWER_COUNTS = (1, 2, 4, 8, 16, 32, 64)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--peer", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--warmup-updates", type=int, default=100)
    parser.add_argument(
        "--viewer-counts",
        default=",".join(str(count) for count in VIEWER_COUNTS),
    )
    return parser.parse_args()


def percentile(values: list[int], fraction: float) -> int:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def daemon_memory_bytes(process: int, field: str) -> int:
    for line in Path(f"/proc/{process}/smaps_rollup").read_text().splitlines():
        if line.startswith(field + ":"):
            return int(line.split()[1]) * 1_024
    raise RuntimeError(f"{field} missing from smaps_rollup")


def median_daemon_memory_bytes(process: int, field: str) -> int:
    samples = []
    for _ in range(5):
        samples.append(daemon_memory_bytes(process, field))
        time.sleep(0.01)
    return int(statistics.median(samples))


def daemon_cpu_ns(process: int) -> int:
    return int(Path(f"/proc/{process}/schedstat").read_text().split()[0])


def read_json(stream: IO[Any], timeout: float) -> dict[str, Any]:
    ready, _, _ = select.select([stream], [], [], timeout)
    if not ready:
        raise TimeoutError("observer did not produce an Event")
    value = json.loads(stream.readline())
    if not isinstance(value, dict):
        raise RuntimeError("observer Event is not an object")
    return value


def wait_for_screen(
    stream: IO[Any], marker: str, timeout: float = 5.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        event = read_json(stream, max(0.0, deadline - time.monotonic()))
        if event.get("event") != "pane.screen":
            continue
        capture = event.get("capture")
        if isinstance(capture, dict) and marker in str(capture.get("text", "")):
            return event
    raise TimeoutError(f"observer did not reach screen marker {marker!r}")


def launch_observer(
    server: LemmaServer, session: str, pane: str
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            str(server.cli_path),
            str(server.socket_path),
            "events",
            "--session",
            session,
            "--pane",
            pane,
            "--screen",
        ],
        env=server.environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def run_profile(arguments: argparse.Namespace, viewers: int) -> dict[str, Any]:
    with LemmaServer(arguments.server, arguments.cli, arguments.peer) as server:
        session = server.create_session(
            f"viewers-{viewers}",
            command=(str(server.peer_path), "observer-echo"),
        )
        pane = session.pane()
        pane.expect_output("__LEMMA_OBSERVER_READY__")
        time.sleep(0.2)
        baseline_pss = median_daemon_memory_bytes(server.process.pid, "Pss")
        baseline_private_dirty = median_daemon_memory_bytes(
            server.process.pid, "Private_Dirty"
        )
        observers = [
            launch_observer(server, session.name, pane.id) for _ in range(viewers)
        ]
        try:
            streams: list[IO[Any]] = []
            for observer in observers:
                stream = observer.stdout
                if stream is None:
                    raise RuntimeError("observer stdout is unavailable")
                initial = read_json(stream, 5.0)
                if initial.get("event") != "snapshot":
                    raise RuntimeError("observer did not begin with a snapshot")
                streams.append(stream)

            observed_pss = median_daemon_memory_bytes(server.process.pid, "Pss")
            observed_private_dirty = median_daemon_memory_bytes(
                server.process.pid, "Private_Dirty"
            )
            # At scales above one, the final observer is intentionally never read again. Its
            # bounded pending output must not delay any of the active observers.
            active_streams = streams if viewers == 1 else streams[:-1]
            stalled_viewers = 0 if viewers == 1 else 1

            for update in range(arguments.warmup_updates):
                marker = f"__VIEWER_WARM_{viewers:02d}_{update:04d}__"
                pane.send(marker + "\n")
                for viewer_index, stream in enumerate(active_streams):
                    try:
                        wait_for_screen(stream, marker)
                    except TimeoutError as error:
                        raise TimeoutError(
                            f"V{viewers} warmup {update} viewer {viewer_index} missed {marker}"
                        ) from error

            cpu_before = daemon_cpu_ns(server.process.pid)
            latencies_ns: list[int] = []
            generations_per_update: list[int] = []
            for update in range(arguments.repetitions):
                marker = f"__VIEWER_MEASURE_{viewers:02d}_{update:04d}__"
                started = time.monotonic_ns()
                pane.send(marker + "\n")
                generations: list[int] = []
                for viewer_index, stream in enumerate(active_streams):
                    try:
                        event = wait_for_screen(stream, marker)
                    except TimeoutError as error:
                        raise TimeoutError(
                            f"V{viewers} measurement {update} viewer {viewer_index} missed {marker}"
                        ) from error
                    generation = event.get("generation")
                    if not isinstance(generation, int):
                        raise RuntimeError("screen Event has no integer generation")
                    generations.append(generation)
                if len(set(generations)) != 1:
                    raise RuntimeError("observers disagreed on the terminal generation")
                generations_per_update.append(generations[0])
                latencies_ns.append(time.monotonic_ns() - started)
            cpu_after = daemon_cpu_ns(server.process.pid)
            final_pss = median_daemon_memory_bytes(server.process.pid, "Pss")
            final_private_dirty = median_daemon_memory_bytes(
                server.process.pid, "Private_Dirty"
            )
            if any(observer.poll() is not None for observer in observers):
                raise RuntimeError("an observer exited during the scale workload")
            return {
                "viewers": viewers,
                "active_viewers": len(active_streams),
                "stalled_viewers": stalled_viewers,
                "updates": arguments.repetitions,
                "warmup_updates": arguments.warmup_updates,
                "daemon_cpu_ns": cpu_after - cpu_before,
                "daemon_cpu_ns_per_update": (cpu_after - cpu_before)
                // arguments.repetitions,
                "baseline_daemon_pss_bytes": baseline_pss,
                "observed_daemon_pss_bytes": observed_pss,
                "final_daemon_pss_bytes": final_pss,
                "observer_daemon_pss_delta_bytes": observed_pss - baseline_pss,
                "observer_daemon_pss_delta_per_viewer_bytes": (
                    observed_pss - baseline_pss
                )
                // viewers,
                "baseline_daemon_private_dirty_bytes": baseline_private_dirty,
                "observed_daemon_private_dirty_bytes": observed_private_dirty,
                "final_daemon_private_dirty_bytes": final_private_dirty,
                "observer_daemon_private_dirty_delta_bytes": (
                    observed_private_dirty - baseline_private_dirty
                ),
                "observer_daemon_private_dirty_delta_per_viewer_bytes": (
                    observed_private_dirty - baseline_private_dirty
                )
                // viewers,
                "visibility_latency_ns": latencies_ns,
                "visibility_latency_p50_ns": int(statistics.median(latencies_ns)),
                "visibility_latency_p95_ns": percentile(latencies_ns, 0.95),
                "first_generation": generations_per_update[0],
                "last_generation": generations_per_update[-1],
                "stalled_observer_alive": stalled_viewers == 0
                or observers[-1].poll() is None,
            }
        finally:
            for observer in observers:
                observer.kill()
                observer.communicate(timeout=1.0)


def main() -> int:
    arguments = parse_arguments()
    if arguments.repetitions < 20:
        raise ValueError("repetitions must be at least 20 for p95")
    if arguments.warmup_updates <= 0:
        raise ValueError("warmup-updates must be positive")
    viewer_counts = tuple(int(value) for value in arguments.viewer_counts.split(","))
    if not viewer_counts or any(count not in VIEWER_COUNTS for count in viewer_counts):
        raise ValueError("viewer-counts must select values from 1,2,4,8,16,32,64")
    load_before = os.getloadavg()
    profiles = {
        f"V{viewers}": run_profile(arguments, viewers) for viewers in viewer_counts
    }
    report = {
        "schema": "lemma.viewer-scale/v1",
        "host": os.uname().nodename,
        "cpu_affinity": sorted(os.sched_getaffinity(0)),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "configuration": {
            "server": str(Path(arguments.server).resolve()),
            "repetitions": arguments.repetitions,
            "warmup_updates": arguments.warmup_updates,
            "viewer_counts": viewer_counts,
        },
        "profiles": profiles,
    }
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
