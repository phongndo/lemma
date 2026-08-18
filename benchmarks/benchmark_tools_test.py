#!/usr/bin/env python3
"""Focused tests for benchmark-only buffering and statistics."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import f5_soak
from check_regression import (
    BudgetError,
    checked_samples,
    require_completed_process_workloads,
    require_scope,
    statistic,
    validate_comparative_check,
)
from latency_trace import input_paths
from mux_benchmark import (
    INTERACTION_LABEL_CODES,
    LEMMA_OUTER_TERMINAL_RESTORE,
    AnsiScreenTracker,
    PtyProcess,
    install_attach_shell_startup,
    interaction_marker,
    interaction_visible_token,
    open_descriptor_snapshot,
    percentile,
)


class BenchmarkStatisticsTest(unittest.TestCase):
    def test_uses_nearest_rank_percentiles(self) -> None:
        samples = list(range(1, 21))
        self.assertEqual(percentile(samples, 0.50), 10)
        self.assertEqual(percentile(samples, 0.95), 19)
        self.assertEqual(statistic([float(value) for value in samples], "p99"), 20)

    def test_rejects_an_insufficient_distribution(self) -> None:
        with self.assertRaisesRegex(BudgetError, "needs at least 3 samples; found 2"):
            checked_samples([1, 2], "sample gate", 3)


class RegressionWorkloadTest(unittest.TestCase):
    def test_validates_a_bounded_loaded_to_baseline_ratio(self) -> None:
        check = {
            "id": "blocked_client_ratio",
            "statistic": "p95",
            "maximum_ratio": 1.10,
            "baseline_samples_path": ["workloads", "blocked", "idle", "samples_ns"],
            "loaded_samples_path": ["workloads", "blocked", "loaded", "samples_ns"],
        }

        self.assertIs(validate_comparative_check(check, "ratio"), check)
        with self.assertRaisesRegex(BudgetError, "at least 1"):
            validate_comparative_check({**check, "maximum_ratio": 0.99}, "ratio")

    def test_rejects_samples_from_a_failed_workload(self) -> None:
        checks = [{"samples_path": ["workloads", "interactive", "samples_ns"]}]
        report = {
            "workloads": {"interactive": {"status": "failed", "samples_ns": [1, 2, 3]}}
        }

        with self.assertRaisesRegex(BudgetError, "interactive did not complete"):
            require_completed_process_workloads(report, checks)


class RegressionScopeTest(unittest.TestCase):
    def test_rejects_a_different_host_with_the_same_cpu_count(self) -> None:
        approved = {
            "host_name": "pinned.example",
            "model_identifier": "Mac16,5",
            "cpu_model": "Apple M4 Max",
            "physical_cpu_count": 16,
            "memory_bytes": 68_719_476_736,
        }
        budgets = {
            "scope": {
                "approved_host": approved,
                "process_report_requirements": {"system": "Darwin"},
                "micro_context_requirements": {"num_cpus": 16},
            }
        }
        micro_report = {
            "context": {
                "host_name": "other.example",
                "num_cpus": 16,
                "host_model_identifier": "Mac16,5",
                "host_cpu_model": "Apple M4 Max",
                "host_physical_cpu_count": "16",
                "host_memory_bytes": "68719476736",
            }
        }
        process_report = {
            "system": "Darwin",
            "host": "other.example",
            "host_fingerprint": {**approved, "host_name": "other.example"},
            "commit": "abc",
        }
        profile_report = dict(process_report)

        with self.assertRaisesRegex(BudgetError, "approved pinned host"):
            require_scope(budgets, micro_report, process_report, profile_report)


class DescriptorSnapshotTest(unittest.TestCase):
    def test_rejects_a_zero_byte_darwin_descriptor_census(self) -> None:
        class ProcPidInfo:
            def __call__(self, *arguments: object) -> int:
                del arguments
                return 0

        class Libproc:
            proc_pidinfo = ProcPidInfo()

        with (
            mock.patch("mux_benchmark.platform.system", return_value="Darwin"),
            mock.patch("mux_benchmark.ctypes.CDLL", return_value=Libproc()),
        ):
            snapshot = open_descriptor_snapshot(42)

        self.assertFalse(snapshot["available"])
        self.assertIn("proc_pidinfo", snapshot["reason"])


class LatencyTraceCorrelationTest(unittest.TestCase):
    @staticmethod
    def complete_path() -> list[dict[str, object]]:
        stages = (
            "client_physical_input_read",
            "daemon_input_message_received",
            "daemon_pty_write_progress",
            "daemon_pty_output_read",
            "frame_composition_started",
            "ghostty_damage_reported",
            "frame_composition_finished",
            "daemon_socket_write_progress",
            "client_socket_read",
            "client_outer_terminal_write_started",
            "client_outer_terminal_write_finished",
        )
        client_stages = {
            "client_physical_input_read",
            "client_socket_read",
            "client_outer_terminal_write_started",
            "client_outer_terminal_write_finished",
        }
        return [
            {
                "timestamp_ns": 100 + index,
                "sequence": index + 1,
                "correlation": 1234,
                "process": 41 if stage in client_stages else 10,
                "stage": stage,
                "subject": 0,
                "value": 29 if index == 0 else 1,
            }
            for index, stage in enumerate(stages)
        ]

    def test_correlates_only_a_complete_ordered_marker_path(self) -> None:
        events = self.complete_path()

        paths, rejected = input_paths(events, {29})

        self.assertEqual(rejected, [])
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0]["correlation"], 1234)
        self.assertEqual(paths[0]["total_ns"], len(events) - 1)

    def test_ignores_interleaved_events_with_an_unrelated_token(self) -> None:
        events = self.complete_path()
        events.append(
            {
                "timestamp_ns": 104,
                "sequence": 99,
                "correlation": 9876,
                "process": 10,
                "stage": "daemon_pty_output_read",
                "subject": 0,
                "value": 1,
            }
        )

        paths, rejected = input_paths(events, {29})

        self.assertEqual(rejected, [])
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0]["correlation"], 1234)

    def test_rejects_a_marker_token_with_a_missing_stage(self) -> None:
        events = self.complete_path()[:1]

        paths, rejected = input_paths(events, {29})

        self.assertEqual(paths, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("daemon_input_message_received", rejected[0]["reason"])

    def test_rejects_an_unmatched_stage_token(self) -> None:
        events = self.complete_path()
        pty_output = next(
            event for event in events if event["stage"] == "daemon_pty_output_read"
        )
        pty_output["correlation"] = 9876

        paths, rejected = input_paths(events, {29})

        self.assertEqual(paths, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("daemon_pty_output_read", rejected[0]["reason"])

    def test_rejects_an_uncorrelated_socket_read_without_timestamp_matching(
        self,
    ) -> None:
        events = self.complete_path()
        socket_read = next(
            event for event in events if event["stage"] == "client_socket_read"
        )
        socket_read["correlation"] = 0

        paths, rejected = input_paths(events, {29})

        self.assertEqual(paths, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("client_socket_read", rejected[0]["reason"])

    def test_rejects_a_reused_physical_input_token(self) -> None:
        events = self.complete_path()
        events.append({**events[0], "timestamp_ns": 200, "sequence": 12})

        paths, rejected = input_paths(events, {29})

        self.assertEqual(paths, [])
        self.assertEqual(len(rejected), 2)
        self.assertTrue(all("reused" in rejection["reason"] for rejection in rejected))


class MuxFixtureTest(unittest.TestCase):
    def test_interaction_markers_are_unique_for_all_allowed_repetitions(self) -> None:
        markers = [
            interaction_marker(label, index)
            for label in INTERACTION_LABEL_CODES
            for index in range(1_000)
        ]
        visible_tokens = [
            interaction_visible_token(label, index)
            for label in INTERACTION_LABEL_CODES
            for index in range(1_000)
        ]
        self.assertEqual(len(markers), len(set(markers)))
        self.assertEqual(len(visible_tokens), len(set(visible_tokens)))
        self.assertTrue(all(len(token) == 8 for token in visible_tokens))

    def test_installs_the_fixture_in_the_active_fish_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {
                "SHELL": "/opt/homebrew/bin/fish",
                "HOME": str(root / "home"),
                "XDG_CONFIG_HOME": str(root / "config"),
                "ZDOTDIR": str(root / "zdot"),
            }
            peer = root / "peer"

            install_attach_shell_startup(environment, peer)

            startup = root / "config" / "fish" / "config.fish"
            self.assertTrue(startup.is_file())
            self.assertIn(str(peer), startup.read_text(encoding="utf-8"))

    def test_installs_both_login_and_interactive_zsh_startup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {
                "SHELL": "/bin/zsh",
                "HOME": str(root / "home"),
                "XDG_CONFIG_HOME": str(root / "config"),
                "ZDOTDIR": str(root / "zdot"),
            }

            install_attach_shell_startup(environment, root / "peer")

            self.assertTrue((root / "zdot" / ".zprofile").is_file())
            self.assertTrue((root / "zdot" / ".zshrc").is_file())

    def test_rejects_an_unknown_login_shell_explicitly(self) -> None:
        environment = {
            "SHELL": "/bin/unknown-shell",
            "HOME": "/tmp/home",
            "XDG_CONFIG_HOME": "/tmp/config",
            "ZDOTDIR": "/tmp/zdot",
        }
        with self.assertRaisesRegex(
            RuntimeError, "does not support account login shell"
        ):
            install_attach_shell_startup(environment, Path("/tmp/peer"))


class F5SoakReportTest(unittest.TestCase):
    class Clock:
        def __init__(self) -> None:
            self.now_ns = 0

        def monotonic_ns(self) -> int:
            return self.now_ns

        def advance(self, seconds: float) -> None:
            self.now_ns += round(seconds * 1_000_000_000)

    def run_soak(
        self, output: Path, *, interrupt_background: bool
    ) -> tuple[int, dict[str, object]]:
        clock = self.Clock()

        class Client:
            terminal_state_restored = True

            def __init__(self) -> None:
                self.drain_calls = 0

            def write_all(self, data: bytes, timeout: float) -> None:
                del data, timeout

            def read_until(self, marker: bytes, timeout: float) -> None:
                del marker, timeout

            def resize(self, columns: int, rows: int) -> None:
                del columns, rows

            def drain(self, duration: float = 0.05) -> int:
                self.drain_calls += 1
                if self.drain_calls == 1:
                    clock.advance(2.0)
                    return 0
                if interrupt_background:
                    raise InterruptedError("test interruption during background drain")
                clock.advance(duration)
                return 17

        client = Client()

        class Runtime:
            def __init__(self, server: Path, cli: Path, peer: Path) -> None:
                del server, cli
                self.peer_path = peer
                self.receipt_path = output.parent / "receipt"

            def start_and_attach(self, session: str) -> Client:
                del session
                return client

            def attach(self, session: str) -> Client:
                del session
                return client

            def detach(self, attached: Client, session: str) -> None:
                del attached, session

            def close(self) -> None:
                pass

        class Receipts:
            def __init__(self, path: Path) -> None:
                del path

            def close(self) -> None:
                pass

        def sample_latency(*args: object, **kwargs: object) -> dict[str, object]:
            del args, kwargs
            clock.advance(0.1)
            return {
                "key_to_pty": {"samples_ns": [10]},
                "key_to_visible": {"samples_ns": [20]},
                "client_bytes": [30],
            }

        executable = Path(sys.executable)
        argv = [
            "f5_soak.py",
            "--duration-seconds",
            "1",
            "--interaction-interval-seconds",
            "1",
            "--reattach-every",
            "100",
            "--resource-interval-seconds",
            "60",
            "--server",
            str(executable),
            "--cli",
            str(executable),
            "--peer",
            str(executable),
            "--output",
            str(output),
        ]
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(f5_soak, "LemmaRuntime", Runtime),
            mock.patch.object(f5_soak, "PtyReceiptChannel", Receipts),
            mock.patch.object(f5_soak, "latency_samples", sample_latency),
            mock.patch.object(
                f5_soak, "resource_sample", return_value={"elapsed_ns": 0}
            ),
            mock.patch.object(f5_soak, "git_provenance", return_value=("test", True)),
            mock.patch.object(f5_soak, "host_fingerprint", return_value={}),
            mock.patch.object(f5_soak.signal, "signal"),
            mock.patch.object(f5_soak.time, "monotonic_ns", clock.monotonic_ns),
        ):
            status = f5_soak.main()
        return status, json.loads(output.read_text(encoding="utf-8"))

    def test_interruption_during_background_drain_retains_a_failed_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "soak.json"
            status, report = self.run_soak(output, interrupt_background=True)

        self.assertEqual(status, 1)
        self.assertEqual(report["status"], "failed")
        self.assertIn("InterruptedError", str(report["failure"]))
        self.assertEqual(report["interactions"], [])

    def test_active_duration_excludes_setup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "soak.json"
            status, report = self.run_soak(output, interrupt_background=False)

        self.assertEqual(status, 0)
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["setup_elapsed_ns"], 2_000_000_000)
        self.assertEqual(report["elapsed_ns"], 1_000_000_000)
        self.assertEqual(report["total_elapsed_ns"], 3_000_000_000)
        interactions = report["interactions"]
        if not isinstance(interactions, list):
            self.fail("soak report interactions must be a list")
        self.assertEqual(len(interactions), 1)


class AnsiScreenTrackerTest(unittest.TestCase):
    def test_finds_marker_across_fragmented_incremental_cell_updates(self) -> None:
        tracker = AnsiScreenTracker(80, 24)
        for fragment in (
            b"\x1b[23;1H__LEMMA_DONE",
            b"\x1b]0;ignored\x1b\\",
            b"\x1b[23;13H__",
        ):
            tracker.feed(fragment)

        self.assertTrue(tracker.contains(b"__LEMMA_DONE__"))
        self.assertFalse(tracker.contains(b"ignored"))


class PtyProcessBufferingTest(unittest.TestCase):
    def test_wait_for_exit_drains_child_output(self) -> None:
        script = (
            "import os\n"
            "data = b'x' * (256 * 1024)\n"
            "while data:\n"
            "    data = data[os.write(1, data):]\n"
        )
        process = PtyProcess([sys.executable, "-c", script], dict(os.environ))
        try:
            process.wait_for_exit(5.0)
            self.assertEqual(process.pid, -1)
            self.assertTrue(process.terminal_state_restored)
        finally:
            process.close()

    def test_requires_configured_terminal_mode_cleanup(self) -> None:
        process = PtyProcess(
            [sys.executable, "-c", "pass"],
            dict(os.environ),
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        try:
            process.wait_for_exit(5.0)
            self.assertFalse(process.terminal_modes_restored)
            self.assertFalse(process.terminal_state_restored)
        finally:
            process.close()

    def test_retains_configured_terminal_mode_cleanup(self) -> None:
        script = f"import os; os.write(1, {LEMMA_OUTER_TERMINAL_RESTORE!r})"
        process = PtyProcess(
            [sys.executable, "-c", script],
            dict(os.environ),
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        try:
            process.wait_for_exit(5.0)
            self.assertTrue(process.terminal_modes_restored)
            self.assertTrue(process.terminal_state_restored)
            self.assertIn(LEMMA_OUTER_TERMINAL_RESTORE, process.final_output)
        finally:
            process.close()

    def test_handshake_preserves_bytes_from_the_same_read(self) -> None:
        read_descriptor, write_descriptor = os.pipe()
        process = object.__new__(PtyProcess)
        process.descriptor = read_descriptor
        process.pending_read = b""
        process.screen = AnsiScreenTracker(80, 24)
        handshake = b"\x1b[?1049h"
        marker = b"__VISIBLE__"
        suffix = marker + b"tail"
        try:
            os.write(write_descriptor, b"prefix" + handshake + suffix)
            _, handshake_bytes = process.read_until(
                handshake, 1.0, preserve_suffix=True
            )
            self.assertEqual(handshake_bytes, len(b"prefix" + handshake))
            self.assertEqual(process.pending_read, suffix)

            _, visible_bytes = process.read_until(marker, 1.0)
            self.assertEqual(visible_bytes, len(suffix))
            self.assertEqual(process.pending_read, b"")
        finally:
            os.close(read_descriptor)
            os.close(write_descriptor)


if __name__ == "__main__":
    unittest.main()
