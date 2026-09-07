from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any

from tests.support.mux_harness import Client, LemmaServer, Session, wait_until


class SnapshotWorkerMuxTest(unittest.TestCase):
    def server(self, *, stage: str, storage_failure: bool = False) -> LemmaServer:
        server = LemmaServer.from_environment(
            parking_delay_ms=100,
            snapshot_gate=stage,
            snapshot_directory=Path("/missing/lemma-snapshot-directory")
            if storage_failure
            else None,
        )
        self.addCleanup(server.close)
        return server

    def resources(self, server: LemmaServer) -> dict[str, Any]:
        result = server.require_command("proc", "daemon", "inspect")
        return json.loads(result.output)["results"][0]["result"]["daemon"]["resources"][
            "snapshot_bytes"
        ]

    def foreground(self, server: LemmaServer) -> Client:
        session = server.create_session(
            "foreground", command=(str(server.peer_path), "observer-echo")
        )
        client = session.require_client()
        client.expect_output("__LEMMA_OBSERVER_READY__")
        return client

    def interactive(self, client: Client, phase: str) -> None:
        # Raw-mode fixture echo, not local terminal echo or shell command text. Each assertion
        # requires a new outer-PTY -> client -> reactor -> child -> frame -> outer-PTY round trip.
        for index in range(4):
            marker = f"__WORKER_{phase}_{index}__"
            client.send(marker)
            client.expect_output(marker, timeout=2.0)

    def large_terminal(self, server: LemmaServer) -> Session:
        session = server.create_session(
            "large", command=(str(server.peer_path), "parking-rich", "25000", "1")
        )
        session.require_client().expect_output("__LEMMA_PARK_READY_0001__")
        session.detach()
        return session

    def entered(self, server: LemmaServer) -> None:
        marker = server.root / "snapshot-gate.entered"
        wait_until(
            "worker owns the operation and is blocked at its test boundary",
            lambda: True if marker.exists() else None,
            diagnostics=server.diagnostics,
        )

    def release(self, server: LemmaServer) -> None:
        (server.root / "snapshot-gate.released").touch()

    def test_large_snapshot_and_saturated_parking_keep_another_session_interactive(
        self,
    ) -> None:
        server = self.server(stage="parking")
        foreground = self.foreground(server)
        large = self.large_terminal(server)
        self.entered(server)
        for index in range(12):
            server.create_session(
                f"storm-{index}", attach=False, command=(str(server.peer_path), "quiet")
            )
        wait_until(
            "four admitted snapshot owners, with excess storm requests rejected",
            lambda: (
                True
                if self.resources(server)["reserved"] == 4 * 64 * 1024 * 1024
                else None
            ),
            diagnostics=server.diagnostics,
        )
        self.interactive(foreground, "PARKING_HELD")
        self.assertEqual(self.resources(server)["parked_panes"], 0)
        self.release(server)
        # Interactivity while real encoding/encryption/I/O proceeds, in addition to the held-worker
        # proof above. This is a functional isolation check, not a calibrated latency gate.
        self.interactive(foreground, "PARKING_RUNNING")
        wait_until(
            "storm drains through the bounded worker",
            lambda: True if self.resources(server)["parked_panes"] == 13 else None,
            diagnostics=server.diagnostics,
        )
        self.assertGreater(self.resources(server)["reserved"], 8 * 1024 * 1024)
        large.attach().expect_output("__LEMMA_PARK_READY_0001__")
        self.interactive(foreground, "RESTORED")

    def test_large_hydration_removal_and_slot_reuse_do_not_wait_for_worker(
        self,
    ) -> None:
        server = self.server(stage="hydrating")
        foreground = self.foreground(server)
        large = self.large_terminal(server)
        wait_until(
            "large terminal parked",
            lambda: True if self.resources(server)["parked_panes"] == 1 else None,
            diagnostics=server.diagnostics,
        )
        reserved = self.resources(server)["reserved"]
        self.assertGreater(reserved, 8 * 1024 * 1024)
        capture = server.command(
            "proc",
            "pane",
            "capture",
            "--session",
            large.name,
            "--pane",
            large.pane().id,
        )
        self.assertIn("pane_hydrating", capture.output)
        self.entered(server)
        self.interactive(foreground, "HYDRATION_HELD")
        server.require_command("kill", large.name)
        self.assertEqual(self.resources(server)["reserved"], reserved)
        replacement = server.create_session(
            large.name, command=(str(server.peer_path), "observer-echo")
        )
        replacement.require_client().expect_output("__LEMMA_OBSERVER_READY__")
        self.release(server)
        wait_until(
            "abandoned snapshot quota released after worker destruction",
            lambda: True if self.resources(server)["reserved"] == 0 else None,
            diagnostics=server.diagnostics,
        )
        self.interactive(replacement.require_client(), "REPLACEMENT")
        self.interactive(foreground, "AFTER_REMOVAL")

    def test_storage_failure_storm_preserves_live_owners_and_foreground_progress(
        self,
    ) -> None:
        server = self.server(stage="parking", storage_failure=True)
        foreground = self.foreground(server)
        large = self.large_terminal(server)
        self.entered(server)
        for index in range(8):
            server.create_session(
                f"failure-{index}",
                attach=False,
                command=(str(server.peer_path), "quiet"),
            )
        self.interactive(foreground, "FAILED_STORAGE_HELD")
        self.release(server)
        large.attach().expect_output("__LEMMA_PARK_READY_0001__")
        self.interactive(foreground, "FAILED_STORAGE_RUNNING")
        self.assertEqual(self.resources(server)["parked_panes"], 0)
        for index in range(8):
            self.assertIsNotNone(server.session_state(f"failure-{index}"))
