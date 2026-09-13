#!/usr/bin/env python3
"""Focused tests for benchmark-only buffering and statistics."""

from __future__ import annotations

import json
import runpy
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

from annotate_micro_report import git_metadata
from benchmark_manifest import expected_failure, load_manifest, suite_workloads
from calibrate_regression import calibration
from check_regression import (
    BudgetError,
    budgets_from_manifest,
    checked_samples,
    process_check_samples,
    require_completed_process_workloads,
    require_scope,
    statistic,
    validate_comparative_check,
)
from compare_regression import (
    add_comparison,
    profile_values,
    require_manifest_identity,
    require_same_capture_scope,
)
from compare_regression import policy as paired_policy
from latency_trace import input_paths
from mux_benchmark import (
    ALT_SCREEN,
    ATTACH_VISIBLE_MARKER,
    INTERACTION_LABEL_CODES,
    LATENCY_VISIBLE_ACK,
    SHELL_READY_MARKER,
    TUI_REDRAW_READY,
    LemmaRuntime,
    PtyReceiptChannel,
    TmuxRuntime,
    ZellijRuntime,
    benchmark_environment,
    build_profile,
    git_provenance,
    install_attach_shell_startup,
    interaction_marker,
    interaction_visible_token,
    lifecycle_sentinel_arguments,
    linux_cpu_snapshot,
    linux_host_metadata,
    open_descriptor_snapshot,
    parse_linux_schedstat,
    percentile,
    resource_snapshot,
    tui_redraw,
    wait_for_profile_shell,
    workload_cpu,
)
from mux_benchmark import (
    summary as latency_summary,
)
from performance_host import validate as validate_host
from terminal_lab import validate_samples


class LinuxResourceTest(unittest.TestCase):
    def test_schedstat_uses_nanosecond_cpu_runtime(self) -> None:
        self.assertEqual(parse_linux_schedstat("123456789 42 7\n"), 123456789)
        with self.assertRaisesRegex(ValueError, "schedstat"):
            parse_linux_schedstat("123 invalid 7\n")


class EfficiencyAccountingTest(unittest.TestCase):
    def test_cpu_includes_worker_threads(self) -> None:
        with (
            mock.patch("mux_benchmark.platform.system", return_value="Linux"),
            mock.patch.object(
                Path,
                "iterdir",
                return_value=iter([Path("/proc/10/task/10"), Path("/proc/10/task/11")]),
            ),
            mock.patch.object(Path, "read_text", side_effect=["100 0 1", "900 0 1"]),
        ):
            self.assertEqual(linux_cpu_snapshot({10})["cpu_time_ns"], 1000)

    def test_two_pane_profile_really_splits(self) -> None:
        runtime = mock.Mock(spec=TmuxRuntime)
        client = mock.Mock()
        with (
            mock.patch("mux_benchmark.wait_for_profile_shell"),
            mock.patch("mux_benchmark.wait_for_profile_panes") as wait,
            mock.patch("mux_benchmark.send_prefix") as send,
        ):
            build_profile(runtime, client, 2)
        send.assert_called_once_with(client, b"%")
        wait.assert_called_once_with(runtime, client, "profile", 2)

    def test_client_guardian_is_not_pane_memory(self) -> None:
        with (
            mock.patch(
                "mux_benchmark.subprocess.run",
                return_value=mock.Mock(
                    stdout="10 20 100 0:00\n11 10 200 0:00\n20 1 300 0:00\n21 20 400 0:00\n"
                ),
            ),
            mock.patch(
                "mux_benchmark.process_group_snapshot",
                side_effect=lambda pids, processes: {
                    "available": True,
                    "pids": sorted(pids),
                },
            ),
        ):
            result = resource_snapshot(
                [10, 20], {"daemon": [10], "attached_client": [20]}
            )
        self.assertEqual(result["roles"]["attached_client"]["pids"], [20, 21])
        self.assertEqual(result["roles"]["pane_or_mux_children"]["pids"], [11])

    def test_zellij_profile_creates_panes_and_tabs(self) -> None:
        runtime = mock.Mock(spec=ZellijRuntime)
        client = mock.Mock()
        with (
            mock.patch("mux_benchmark.wait_for_profile_shell"),
            mock.patch("mux_benchmark.wait_for_profile_panes") as wait,
        ):
            build_profile(runtime, client, 8)
        self.assertEqual(runtime.session_command.call_count, 7)
        runtime.session_command.assert_any_call("profile", "new-tab")
        wait.assert_called_with(runtime, client, "profile", 8)

    def test_workload_cpu_rejects_incomparable_endpoints(self) -> None:
        start = {
            "available": True,
            "pids": [10],
            "cpu_time_source": "native",
            "cpu_time_ns": 100,
        }
        for changes in (
            {"pids": [11]},
            {"cpu_time_source": "ps time"},
            {"cpu_time_ns": 99},
            {"available": False},
        ):
            with (
                self.subTest(changes=changes),
                mock.patch(
                    "mux_benchmark.runtime_resource_snapshot",
                    return_value={"roles": {"daemon": {**start, **changes}}},
                ),
            ):
                result = workload_cpu(mock.Mock(), {"roles": {"daemon": start}}, 2)
                self.assertFalse(result["roles"]["daemon"]["available"])
        with mock.patch(
            "mux_benchmark.runtime_resource_snapshot",
            return_value={"roles": {"daemon": {**start, "cpu_time_ns": 300}}},
        ):
            result = workload_cpu(mock.Mock(), {"roles": {"daemon": start}}, 2)
        self.assertEqual(result["roles"]["daemon"]["cpu_ns_per_operation"], 100)


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
    def test_disabled_extension_fixture_is_not_part_of_binary_provenance(self) -> None:
        runtime = object.__new__(LemmaRuntime)
        runtime.server_path = Path("/server")
        runtime.cli_path = Path("/cli")
        runtime.peer_path = Path("/peer")
        runtime.probe_path = Path("/probe")
        runtime.extension_fixture_mode = None
        runtime.extension_fixture_path = Path("/baseline/without/fixture.py")

        with mock.patch(
            "mux_benchmark.executable_provenance", side_effect=lambda path: str(path)
        ) as provenance:
            result = runtime.binary_provenance()

        self.assertIsNone(result["extension_fixture"])
        self.assertEqual(provenance.call_count, 4)

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

    def test_zellij_attach_fixture_owns_creation_until_marker_is_retained(self) -> None:
        runtime = object.__new__(ZellijRuntime)
        runtime.session_prefix = "lb-7-"
        runtime.environment = {"TERM": "xterm-256color"}
        runtime.peer_path = Path("/fixture/peer")
        runtime.sessions = []
        runtime.clients = []
        runtime._arguments = mock.Mock(return_value=["zellij", "attach", "target"])
        runtime._command = mock.Mock()
        runtime.detach = mock.Mock()
        client = mock.Mock()

        with (
            mock.patch("mux_benchmark.PtyProcess", return_value=client),
            mock.patch("mux_benchmark.install_attach_shell_startup") as install,
        ):
            runtime.start_detached_with_attach_marker("attach_visible")

        install.assert_called_once_with(runtime.environment, runtime.peer_path)
        runtime._command.assert_not_called()
        runtime._arguments.assert_called_once_with(
            "attach", "--create", "lb-7-attach-visible"
        )
        self.assertEqual(
            client.read_until.call_args_list,
            [
                mock.call(ALT_SCREEN, 5.0, preserve_suffix=True),
                mock.call(ATTACH_VISIBLE_MARKER, 5.0, visible_text=True),
            ],
        )
        runtime.detach.assert_called_once_with(client, "attach_visible")
        self.assertEqual(runtime.sessions, ["lb-7-attach-visible"])
        self.assertEqual(runtime.clients, [client])

    def test_zellij_detach_waits_for_session_mode_before_sending_its_key(self) -> None:
        runtime = object.__new__(ZellijRuntime)
        client = mock.Mock()

        runtime.detach(client, "work")

        self.assertEqual(
            client.mock_calls,
            [
                mock.call.write_all(b"\x0f", 2.0),
                mock.call.read_until(b"SESSION", 5.0, visible_text=True),
                mock.call.write_all(b"d", 2.0),
                mock.call.wait_for_exit(5.0),
            ],
        )

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
    def test_slow_git_status_retains_source_identity(self) -> None:
        run = subprocess.run

        def slow_git(arguments: list[str], **kwargs: Any) -> Any:
            if arguments[1] == "status":
                return run(
                    [
                        sys.executable,
                        "-c",
                        "import time; time.sleep(2.1); print(' M tracked-file')",
                    ],
                    **kwargs,
                )
            return mock.Mock(stdout="abc123\n" if kwargs.get("text") else b"diff")

        with mock.patch("subprocess.run", side_effect=slow_git):
            self.assertEqual(
                git_metadata(), {"source_commit": "abc123", "worktree_dirty": True}
            )
            commit, dirty, digest = git_provenance()
        self.assertEqual((commit, dirty), ("abc123", True))
        self.assertIsNotNone(digest)

    def test_micro_metadata_does_not_hide_a_status_failure(self) -> None:
        with (
            mock.patch(
                "subprocess.run",
                side_effect=[
                    mock.Mock(stdout="abc123\n"),
                    subprocess.TimeoutExpired("git status", 30.0),
                ],
            ),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            git_metadata()

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
    def setUp(self) -> None:
        self.budgets = budgets_from_manifest(load_manifest())
        self.policy = json.loads(
            Path("benchmarks/performance_hosts.json").read_text(encoding="utf-8")
        )["hosts"]["box"]
        self.fingerprint = {
            field: self.policy[field]
            for field in (
                "host_name",
                "model_identifier",
                "cpu_model",
                "physical_cpu_count",
            )
        }
        # Linux MemTotal changed by one page from the original exact manifest pin.
        self.fingerprint["memory_bytes"] = 32_641_343_488 + 4096
        self.micro: dict[str, Any] = {
            "context": {
                "host_name": self.fingerprint["host_name"],
                "num_cpus": self.policy["logical_cpu_count"],
                "library_build_type": "release",
                "host_model_identifier": self.fingerprint["model_identifier"],
                "host_cpu_model": self.fingerprint["cpu_model"],
                "host_physical_cpu_count": str(self.fingerprint["physical_cpu_count"]),
                "host_memory_bytes": str(self.fingerprint["memory_bytes"]),
                "load_avg": [0.0],
                "source_commit": "abc",
                "executable_sha256": "a" * 64,
                "manifest_sha256": "b" * 64,
            }
        }
        self.process: dict[str, Any] = {
            "system": self.policy["system"],
            "architecture": self.policy["architecture"],
            "build_profile": "release",
            "host": self.fingerprint["host_name"],
            "host_fingerprint": dict(self.fingerprint),
            "host_load_average": [0.0],
            "commit": "abc",
            "manifest": {"sha256": "b" * 64},
            "environment_valid": True,
            "run_intent": "gate",
        }
        self.profile: dict[str, Any] = {
            **self.process,
            "host_fingerprint": dict(self.fingerprint),
        }

    def test_preflight_and_reports_accept_the_same_approved_memory(self) -> None:
        snapshot = {
            **self.policy,
            "fingerprint": self.fingerprint,
            "load_average": [0.0],
        }
        self.assertEqual(validate_host(snapshot, self.policy), [])
        require_scope(self.budgets, self.micro, self.process, self.profile)

    def test_rejects_a_different_host_with_the_same_cpu_count(self) -> None:
        for report in (self.process, self.profile):
            for field in ("host_name", "model_identifier", "cpu_model"):
                with self.subTest(report=report, field=field):
                    original = report["host_fingerprint"][field]
                    report["host_fingerprint"][field] = "other"
                    with self.assertRaisesRegex(BudgetError, "approved pinned host"):
                        require_scope(
                            self.budgets, self.micro, self.process, self.profile
                        )
                    report["host_fingerprint"][field] = original

    def test_manifest_selects_only_an_approved_host_policy(self) -> None:
        manifest = load_manifest()
        manifest["regression_budgets"]["scope"]["approved_host"] = "unapproved"
        with self.assertRaisesRegex(BudgetError, "not approved"):
            budgets_from_manifest(manifest)

    def test_report_identity_comes_from_the_host_policy(self) -> None:
        for field, value in (("physical_cpu_count", 8), ("physical_cpu_count", True)):
            with self.subTest(field=field, value=value):
                self.process["host_fingerprint"][field] = value
                with self.assertRaisesRegex(BudgetError, "approved pinned host"):
                    require_scope(self.budgets, self.micro, self.process, self.profile)
        self.process["host_fingerprint"] = dict(self.fingerprint)
        for field in ("system", "architecture"):
            with self.subTest(field=field):
                original = self.process[field]
                self.process[field] = "other"
                with self.assertRaisesRegex(BudgetError, "outside the reviewed scope"):
                    require_scope(self.budgets, self.micro, self.process, self.profile)
                self.process[field] = original

    def test_native_identity_comes_from_the_host_policy(self) -> None:
        for field, value in (
            ("host_name", "other"),
            ("host_model_identifier", "other"),
            ("host_cpu_model", "other"),
            ("host_physical_cpu_count", "8"),
            ("host_memory_bytes", str(self.policy["minimum_memory_bytes"] - 1)),
            ("num_cpus", 8),
        ):
            with self.subTest(field=field):
                original = self.micro["context"][field]
                self.micro["context"][field] = value
                with self.assertRaises(BudgetError):
                    require_scope(self.budgets, self.micro, self.process, self.profile)
                self.micro["context"][field] = original

    def test_rejects_insufficient_or_malformed_report_memory(self) -> None:
        for memory in (
            self.policy["minimum_memory_bytes"] - 1,
            None,
            True,
            "32000000000",
        ):
            with self.subTest(memory=memory):
                self.process["host_fingerprint"]["memory_bytes"] = memory
                snapshot = {
                    **self.policy,
                    "fingerprint": self.process["host_fingerprint"],
                    "load_average": [0.0],
                }
                self.assertTrue(validate_host(snapshot, self.policy))
                with self.assertRaisesRegex(BudgetError, "approved pinned host"):
                    require_scope(self.budgets, self.micro, self.process, self.profile)

    def test_requires_exact_fingerprints_within_a_capture(self) -> None:
        self.profile["host_fingerprint"]["memory_bytes"] += 4096
        with self.assertRaisesRegex(BudgetError, "different host fingerprints"):
            require_scope(self.budgets, self.micro, self.process, self.profile)

    def test_requires_exact_native_and_process_fingerprints(self) -> None:
        self.micro["context"]["host_memory_bytes"] = str(
            self.fingerprint["memory_bytes"] + 4096
        )
        with self.assertRaisesRegex(BudgetError, "different host fingerprints"):
            require_scope(self.budgets, self.micro, self.process, self.profile)

    def test_requires_exact_fingerprints_across_paired_captures(self) -> None:
        candidate = {
            **self.process,
            "host_fingerprint": {
                **self.fingerprint,
                "memory_bytes": self.fingerprint["memory_bytes"] + 4096,
            },
        }
        with self.assertRaisesRegex(BudgetError, "differ in host_fingerprint"):
            require_same_capture_scope(self.process, candidate, "process")


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
    def test_shell_marker_does_not_share_the_rendered_fixture_prefix(self) -> None:
        self.assertNotEqual(SHELL_READY_MARKER[:1], TUI_REDRAW_READY[:1])

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
