#!/usr/bin/env python3
"""Focused tests for benchmark-only buffering and statistics."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

from check_regression import (
    BudgetError,
    checked_samples,
    require_completed_process_workloads,
    require_scope,
    statistic,
)
from latency_trace import input_paths
from mux_benchmark import (
    INTERACTION_LABEL_CODES,
    PtyProcess,
    install_attach_shell_startup,
    interaction_marker,
    interaction_visible_token,
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
    def test_rejects_samples_from_a_failed_workload(self) -> None:
        checks = [{"samples_path": ["workloads", "interactive", "samples_ns"]}]
        report = {
            "workloads": {
                "interactive": {"status": "failed", "samples_ns": [1, 2, 3]}
            }
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
        with self.assertRaisesRegex(RuntimeError, "does not support account login shell"):
            install_attach_shell_startup(environment, Path("/tmp/peer"))


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
        finally:
            process.close()

    def test_handshake_preserves_bytes_from_the_same_read(self) -> None:
        read_descriptor, write_descriptor = os.pipe()
        process = object.__new__(PtyProcess)
        process.descriptor = read_descriptor
        process.pending_read = b""
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
