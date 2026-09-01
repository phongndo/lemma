#!/usr/bin/env python3
"""Focused tests for benchmark-only buffering and statistics."""

from __future__ import annotations

import json
import runpy
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

from benchmark_manifest import expected_failure, load_manifest, suite_workloads
from calibrate_regression import calibration
from check_regression import (
    BudgetError,
    checked_samples,
    process_check_samples,
    require_completed_process_workloads,
    require_scope,
    statistic,
    validate_comparative_check,
)
from compare_regression import add_comparison, profile_values, require_manifest_identity
from compare_regression import policy as paired_policy
from latency_trace import input_paths
from mux_benchmark import (
    ALT_SCREEN,
    INTERACTION_LABEL_CODES,
    LATENCY_VISIBLE_ACK,
    SHELL_READY_MARKER,
    TUI_REDRAW_READY,
    LemmaRuntime,
    PtyReceiptChannel,
    TmuxRuntime,
    ZellijRuntime,
    benchmark_environment,
    git_provenance,
    install_attach_shell_startup,
    interaction_marker,
    interaction_visible_token,
    lifecycle_sentinel_arguments,
    linux_host_metadata,
    open_descriptor_snapshot,
    parse_linux_schedstat,
    percentile,
    tui_redraw,
    wait_for_profile_shell,
)
from mux_benchmark import (
    summary as latency_summary,
)
from terminal_lab import validate_samples


class LinuxResourceTest(unittest.TestCase):
    def test_schedstat_uses_nanosecond_cpu_runtime(self) -> None:
        self.assertEqual(parse_linux_schedstat("123456789 42 7\n"), 123456789)
        with self.assertRaisesRegex(ValueError, "schedstat"):
            parse_linux_schedstat("123 invalid 7\n")


class HostFingerprintTest(unittest.TestCase):
    def test_linux_metadata_identifies_physical_cores_and_memory(self) -> None:
        cpuinfo = """processor: 0
model name: Example CPU
physical id: 0
core id: 0

processor: 1
model name: Example CPU
physical id: 0
core id: 0

processor: 2
model name: Example CPU
physical id: 0
core id: 1
"""

        self.assertEqual(
            linux_host_metadata(cpuinfo, "MemTotal: 1024 kB\n", " Test Host\n"),
            {
                "model_identifier": "Test Host",
                "cpu_model": "Example CPU",
                "physical_cpu_count": 2,
                "memory_bytes": 1024 * 1024,
            },
        )


class LemmaBenchmarkAdapterTest(unittest.TestCase):
    def test_lifecycle_sentinel_uses_the_built_quiescent_peer(self) -> None:
        peer = Path("/fixture/lemma_test_pty_peer")

        self.assertEqual(
            lifecycle_sentinel_arguments(peer),
            ("start", "lifecycle_sentinel", "--", str(peer), "idle"),
        )

    def test_profile_readiness_requires_shell_execution_not_input_echo(self) -> None:
        runtime = object.__new__(LemmaRuntime)
        client = mock.Mock()

        wait_for_profile_shell(runtime, client, 17)

        marker = b"__LEMMA_PROFILE_PANE_0017_READY__"
        command = client.write_all.call_args.args[0]
        self.assertNotIn(marker, command)
        client.read_until.assert_called_once_with(marker, 5.0, visible_text=False)
        client.drain.assert_called_once_with(0.005)

    def test_zellij_attach_waits_for_session_publication(self) -> None:
        runtime = object.__new__(ZellijRuntime)
        runtime._command = mock.Mock(
            side_effect=[
                mock.Mock(returncode=1, stdout=""),
                mock.Mock(returncode=0, stdout="another-session\n"),
                mock.Mock(returncode=0, stdout="target-session\n"),
            ]
        )

        with mock.patch("mux_benchmark.time.sleep"):
            runtime._wait_for_session("target-session")

        self.assertEqual(runtime._command.call_count, 3)

    def test_start_and_attach_waits_for_the_inner_shell(self) -> None:
        for runtime_type in (LemmaRuntime, TmuxRuntime):
            with self.subTest(runtime=runtime_type.multiplexer):
                runtime = object.__new__(runtime_type)
                runtime.start_detached = mock.Mock()
                client = mock.Mock()
                runtime.attach = mock.Mock(return_value=client)

                attached = runtime.start_and_attach("work")

                self.assertIs(attached, client)
                runtime.start_detached.assert_called_once_with("work")
                client.read_until.assert_called_once_with(
                    SHELL_READY_MARKER, 5.0, visible_text=False
                )
                client.drain.assert_called_once_with(0.005)

    def test_zellij_readiness_uses_the_rendered_screen(self) -> None:
        runtime = mock.Mock()
        runtime.multiplexer = "zellij"
        runtime.peer_path = Path("/fixture/peer")
        client = mock.Mock()
        runtime.start_and_attach.return_value = client

        with tempfile.TemporaryDirectory() as directory:
            runtime.receipt_path = Path(directory) / "receipt.sock"
            with mock.patch("mux_benchmark.latency_samples", return_value={}):
                result = tui_redraw(runtime, 1)

        self.assertEqual(result["status"], "completed")
        client.read_until.assert_called_once_with(
            TUI_REDRAW_READY, 5.0, visible_text=True
        )

    def test_zellij_start_and_attach_owns_session_creation_lifetime(self) -> None:
        runtime = object.__new__(ZellijRuntime)
        runtime.session_prefix = "lb-7-"
        runtime.environment = {"TERM": "xterm-256color"}
        runtime.sessions = []
        runtime.clients = []
        runtime._arguments = mock.Mock(return_value=["zellij", "attach", "target"])
        client = mock.Mock()

        with mock.patch("mux_benchmark.PtyProcess", return_value=client) as process:
            attached = runtime.start_and_attach("tui_redraw")

        self.assertIs(attached, client)
        runtime._arguments.assert_called_once_with(
            "attach", "--create", "lb-7-tui-redraw"
        )
        process.assert_called_once_with(
            ["zellij", "attach", "target"], runtime.environment
        )
        self.assertEqual(
            client.read_until.call_args_list,
            [
                mock.call(ALT_SCREEN, 5.0, preserve_suffix=True),
                mock.call(SHELL_READY_MARKER, 5.0, visible_text=True),
            ],
        )
        client.drain.assert_called_once_with(0.005)
        self.assertEqual(runtime.sessions, ["lb-7-tui-redraw"])
        self.assertEqual(runtime.clients, [client])

    def test_maps_generic_lifecycle_commands_to_the_canonical_cli(self) -> None:
        runtime = object.__new__(LemmaRuntime)
        runtime.cli_path = Path("/tmp/lemma-test-cli")
        runtime.socket_path = Path("/tmp/lemma-test.sock")
        runtime.environment = {}

        with mock.patch("mux_benchmark.subprocess.run") as run:
            runtime.command("kill", "work")

        self.assertEqual(
            run.call_args.args[0],
            [
                "/tmp/lemma-test-cli",
                "/tmp/lemma-test.sock",
                "kill",
                "work",
            ],
        )


class BenchEntrypointTest(unittest.TestCase):
    def test_mux_forwards_the_selected_profile_probe(self) -> None:
        entrypoint = runpy.run_path("bench", run_name="benchmark_entrypoint_test")
        build = mock.Mock()
        run = mock.Mock()
        mux = entrypoint["mux"]
        with mock.patch.dict(
            mux.__globals__,
            {
                "BUILD": Path("/tmp/lemma-custom-profile"),
                "build": build,
                "run": run,
            },
        ):
            mux()

        arguments = run.call_args.args[0]
        probe_index = arguments.index("--probe")
        self.assertEqual(
            arguments[probe_index + 1],
            "/tmp/lemma-custom-profile/lemma_benchmark_probe",
        )


class BenchmarkProvenanceTest(unittest.TestCase):
    def test_preserves_resolved_commit_when_dirty_diff_times_out(self) -> None:
        with mock.patch(
            "mux_benchmark.subprocess.run",
            side_effect=[
                mock.Mock(stdout="abc123\n"),
                mock.Mock(stdout=" M benchmarks/mux_benchmark.py\n"),
                subprocess.TimeoutExpired("git diff", 2.0),
            ],
        ):
            provenance = git_provenance()

        self.assertEqual(provenance, ("abc123", True, None))


class OptionalProcessMetricTest(unittest.TestCase):
    CHECK: ClassVar[dict[str, Any]] = {
        "id": "wakeups",
        "samples_path": ["workloads", "idle", "wakeups", "samples_count"],
        "availability": "when_supported",
        "statistic": "max",
    }

    def test_accepts_explicitly_unsupported_metric(self) -> None:
        report = {
            "workloads": {
                "idle": {
                    "wakeups": {
                        "available": False,
                        "reason": "platform has no reviewed counter",
                        "samples_count": [],
                    }
                }
            }
        }

        self.assertIsNone(process_check_samples(report, self.CHECK, 10))

    def test_requires_samples_when_metric_is_supported(self) -> None:
        report = {
            "workloads": {
                "idle": {
                    "wakeups": {
                        "available": True,
                        "samples_count": [],
                    }
                }
            }
        }

        with self.assertRaisesRegex(BudgetError, "needs at least 10 samples"):
            process_check_samples(report, self.CHECK, 10)


class PerformanceCalibrationTest(unittest.TestCase):
    def test_reports_unchanged_revision_noise_outside_reviewed_policy(self) -> None:
        result = calibration(
            "metric",
            [100.0, 112.0],
            "ns",
            "microbenchmarks",
            {"maximum_ratio": 1.1, "absolute_noise_floor": {"ns": 1}},
        )

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["minimum_floor_required_by_observations"], 2)


class PairedRegressionTest(unittest.TestCase):
    def test_rejects_reports_from_a_stale_manifest(self) -> None:
        reports = (
            {"context": {"manifest_sha256": "old"}},
            {"manifest": {"sha256": "new"}},
            {"manifest": {"sha256": "new"}},
        )

        with self.assertRaisesRegex(BudgetError, "selected workload manifest"):
            require_manifest_identity(reports, "new")

    def test_blocks_candidate_regression_but_keeps_absolute_target_separate(
        self,
    ) -> None:
        results: list[dict[str, object]] = []
        add_comparison(
            results,
            "latency",
            1_000_000,
            1_250_001,
            "ns",
            {"maximum_ratio": 1.1, "absolute_noise_floor": {"ns": 100_000}},
        )
        self.assertEqual(results[0]["status"], "failed")

    def test_noisy_tail_metric_remains_diagnostic(self) -> None:
        results: list[dict[str, object]] = []
        add_comparison(
            results,
            "tail",
            100.0,
            1000.0,
            "ns",
            {"maximum_ratio": 1.1, "absolute_noise_floor": {"ns": 0}},
            diagnostic=True,
        )

        self.assertEqual(results[0]["status"], "diagnostic")

    def test_metric_noise_floor_overrides_the_unit_default(self) -> None:
        results: list[dict[str, object]] = []
        add_comparison(
            results,
            "quantized_cpu",
            30_000_000,
            40_000_000,
            "ns",
            {
                "maximum_ratio": 1.1,
                "absolute_noise_floor": {"ns": 100_000},
                "absolute_noise_floor_by_id": {"quantized_cpu": 10_000_000},
            },
        )

        self.assertEqual(results[0]["status"], "passed")
        self.assertEqual(results[0]["absolute_noise_floor"], 10_000_000)

    def test_manifest_defines_reviewed_paired_policy(self) -> None:
        configured = paired_policy(load_manifest())
        self.assertEqual(configured["status"], "reviewed")
        self.assertGreaterEqual(configured["process_workloads"]["maximum_ratio"], 1.0)

    def test_profile_comparison_uses_every_profile_present_in_the_report(self) -> None:
        samples = list(range(1, 21))
        measurement = {
            "status": "completed",
            "resources": {
                "rss": {"samples_bytes": samples},
                "cpu_time": {"samples_ns": samples},
            },
            "interaction": {
                "key_to_pty": {"samples_ns": samples},
                "key_to_outer_bytes": {"samples_ns": samples},
            },
        }
        report = {
            "pane_profiles": {
                profile: {"idle": measurement, "active": measurement}
                for profile in ("P2", "P8")
            }
        }

        identifiers = {
            identifier for identifier, _, _ in profile_values(report, len(samples))
        }

        self.assertEqual(
            {value.split(".", 1)[0] for value in identifiers}, {"P2", "P8"}
        )
        self.assertEqual(len(identifiers), 20)


class BenchmarkStatisticsTest(unittest.TestCase):
    def test_uses_nearest_rank_percentiles(self) -> None:
        samples = list(range(1, 21))
        self.assertEqual(percentile(samples, 0.50), 10)
        self.assertEqual(percentile(samples, 0.95), 19)
        self.assertEqual(statistic([float(value) for value in samples], "p99"), 20)

    def test_rejects_an_insufficient_distribution(self) -> None:
        with self.assertRaisesRegex(BudgetError, "needs at least 3 samples; found 2"):
            checked_samples([1, 2], "sample gate", 3)

    def test_marks_sparse_tail_statistics_as_non_authoritative(self) -> None:
        sparse = latency_summary(list(range(5)))
        p95_ready = latency_summary(list(range(20)))
        p99_ready = latency_summary(list(range(100)))

        self.assertFalse(sparse["p95_valid"])
        self.assertFalse(sparse["p99_valid"])
        self.assertTrue(p95_ready["p95_valid"])
        self.assertFalse(p95_ready["p99_valid"])
        self.assertTrue(p99_ready["p99_valid"])


class BenchmarkManifestTest(unittest.TestCase):
    def test_comparison_suite_is_the_single_complete_workload_authority(self) -> None:
        manifest = load_manifest()
        workloads = suite_workloads(manifest, "comparison")

        self.assertEqual(manifest["schema"], 4)
        self.assertEqual(
            [workload["id"] for workload in workloads],
            manifest["suites"]["comparison"],
        )
        self.assertIn("direct", workloads[0]["subjects"])
        self.assertEqual(
            manifest["terminal_lab"]["terminals"],
            ["ghostty", "kitty", "wezterm"],
        )
        self.assertTrue(
            all(
                "key_to_visible" not in metric
                for workload in workloads
                for metric in workload["metrics"]
            )
        )
        schema = json.loads(
            Path("benchmarks/terminal_lab.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(schema["properties"]["schema"]["const"], 1)
        self.assertIn("input_to_photon_ns", str(schema))

    def test_extended_profiles_cover_every_scaling_knee(self) -> None:
        manifest = load_manifest()

        self.assertEqual(
            [profile["panes"] for profile in manifest["pane_profiles"]],
            [1, 2, 4, 8, 16, 32, 64],
        )
        self.assertEqual(
            [profile["sessions"] for profile in manifest["session_profiles"]],
            [1, 2, 4, 8, 16],
        )
        self.assertEqual(
            [profile["workspaces"] for profile in manifest["workspace_profiles"]],
            [1, 2, 4, 8, 16],
        )
        self.assertEqual(manifest["deterministic_budgets"]["status"], "reviewed")

    def test_only_reviewed_subject_failures_are_expected(self) -> None:
        manifest = load_manifest()

        reviewed = expected_failure(
            manifest,
            "herdr",
            "blocked_pty",
            "peer emitted __LEMMA_PTY_FAILED__ after input loss",
        )
        reviewed_stall = expected_failure(
            manifest,
            "herdr",
            "blocked_pty",
            "PTY write timed out after 1167360/1902592 bytes",
        )
        reviewed_disconnect = expected_failure(
            manifest,
            "zellij",
            "blocked_pty",
            "Received empty unknown from server",
        )
        unreviewed = expected_failure(
            manifest,
            "herdr",
            "tui_redraw",
            "native probe failed",
        )

        self.assertEqual(
            reviewed["classification"] if reviewed is not None else None,
            "subject_input_loss_under_backpressure",
        )
        self.assertEqual(
            reviewed_stall["classification"] if reviewed_stall is not None else None,
            "subject_input_stall_under_backpressure",
        )
        self.assertEqual(
            reviewed_disconnect["classification"]
            if reviewed_disconnect is not None
            else None,
            "subject_backpressure_disconnect",
        )
        self.assertIsNone(unreviewed)


class TerminalLabContractTest(unittest.TestCase):
    def test_requires_capture_jitter_to_avoid_refresh_lockstep(self) -> None:
        samples = [
            {"sequence": 1, "input_jitter_ns": 0, "input_to_photon_ns": 10},
            {"sequence": 2, "input_jitter_ns": 1, "input_to_photon_ns": 11},
        ]
        self.assertEqual(validate_samples(samples), samples)
        with self.assertRaisesRegex(ValueError, "jitter"):
            validate_samples(
                [
                    {"sequence": 1, "input_jitter_ns": 0, "input_to_photon_ns": 10},
                    {"sequence": 2, "input_jitter_ns": 0, "input_to_photon_ns": 11},
                ]
            )


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


class LatencyReceiptTest(unittest.TestCase):
    def test_acknowledges_visibility_over_the_peer_control_socket(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            receipt = PtyReceiptChannel(Path(directory) / "receipt.sock")
            peer = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            try:
                peer.bind(str(receipt.peer_path))
                receipt.acknowledge_visible()
                self.assertEqual(peer.recv(4 * 1024), LATENCY_VISIBLE_ACK)
            finally:
                peer.close()
                receipt.close()


class MuxFixtureTest(unittest.TestCase):
    def test_benchmark_environment_installs_a_shell_readiness_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch(
                "mux_benchmark.account_login_shell", return_value="/bin/bash"
            ):
                benchmark_environment(root)

            startup = root / "home" / ".bashrc"
            self.assertIn(
                SHELL_READY_MARKER.decode(), startup.read_text(encoding="utf-8")
            )

    def test_interaction_markers_are_unique_for_all_allowed_repetitions(self) -> None:
        markers = [
            interaction_marker(label, index)
            for label in INTERACTION_LABEL_CODES
            for index in range(10_000)
        ]
        visible_tokens = [
            interaction_visible_token(label, index)
            for label in INTERACTION_LABEL_CODES
            for index in range(10_000)
        ]
        self.assertEqual(len(markers), len(set(markers)))
        self.assertEqual(len(visible_tokens), len(set(visible_tokens)))
        self.assertTrue(all(len(token) == 6 for token in visible_tokens))

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


if __name__ == "__main__":
    unittest.main()
