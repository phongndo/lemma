from __future__ import annotations

import json
import select
import shlex
import subprocess
import time
import unittest
from typing import Any

from tests.support.mux_harness import (
    LemmaServer,
    process_exists,
    wait_for_process_exit,
    wait_until,
)
from tests.support.pty_process import PtyProcess


class SessionLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        # A short bounded delay deterministically exercises parking without production wait time.
        self.server = LemmaServer.from_environment(parking_delay_ms=25)
        self.addCleanup(self.server.close)

    def test_output_while_detached_is_current_on_reattach(self) -> None:
        session = self.server.create_session("detach_output")
        pane = session.pane()
        gate = self.server.root / "detached-output.gate"
        command = (
            "printf '__DETACH_READY__\\n'; "
            f"while [ ! -e {shlex.quote(str(gate))} ]; do sleep 0.01; done; "
            "printf '\\033[1;32m__OUTPUT_WHILE_DETACHED__\\033[0m\\n'\r"
        )
        pane.send(command)
        pane.expect_output("__DETACH_READY__")

        session.detach()
        self.assertTrue(process_exists(pane.process))
        detached = session.state()
        self.assertFalse(detached.attached)
        self.assertEqual(detached.focused_pane, pane.id)
        self.assertEqual(detached.focused.pid, pane.process)

        time.sleep(0.05)
        self.assertFalse(session.state().attached)
        first_capture = self.server.command("pane", "capture", session.name, pane.id)
        self.assertEqual(first_capture.status, 1, first_capture.output)
        self.assertIn("unavailable", first_capture.output)
        captured = wait_until(
            "parked Pane capture hydration",
            lambda: (
                result
                if (
                    result := self.server.command(
                        "pane", "capture", session.name, pane.id
                    )
                ).status
                == 0
                else None
            ),
            diagnostics=self.server.diagnostics,
        )
        self.assertIn("__DETACH_READY__", captured.output)
        # Let the bounded test-only quiet deadline expire, then drive a non-waking query turn.
        time.sleep(0.05)
        self.assertFalse(session.state().attached)
        public_capture = self.server.command(
            "proc", "pane", "capture", "--session", session.name, "--pane", pane.id
        )
        self.assertEqual(public_capture.status, 1, public_capture.output)
        public_result = json.loads(public_capture.output)["results"][0]["result"]
        self.assertEqual(public_result["status"], "unavailable")
        self.assertEqual(
            public_result["error"],
            {"reason": "pane_hydrating", "retryable": True},
        )
        wait_until(
            "public capture hydration",
            lambda: (
                result
                if (
                    result := self.server.command(
                        "proc",
                        "pane",
                        "capture",
                        "--session",
                        session.name,
                        "--pane",
                        pane.id,
                    )
                ).status
                == 0
                else None
            ),
            diagnostics=self.server.diagnostics,
        )
        time.sleep(0.05)
        self.assertFalse(session.state().attached)

        gate.touch()
        client = session.attach()
        client.expect_output("__OUTPUT_WHILE_DETACHED__")
        attached = session.state()
        self.assertEqual(attached.focused_pane, pane.id)
        self.assertEqual(attached.focused.pid, pane.process)
        pane.expect_alive()

    def test_disconnect_during_hydration_releases_attach_reservation(self) -> None:
        self.server.close()
        server = LemmaServer.from_environment(
            parking_delay_ms=25, hydration_steps_per_turn=0
        )
        self.addCleanup(server.close)
        session = server.create_session(
            "cancel_hydration",
            attach=False,
            command=(str(server.peer_path), "idle"),
        )
        pane = session.pane()
        time.sleep(0.05)
        wake = server.command("pane", "capture", session.name, pane.id)
        self.assertEqual(wake.status, 1, wake.output)
        self.assertIn("unavailable", wake.output)

        def start_attach() -> PtyProcess:
            return PtyProcess(
                [
                    str(server.cli_path),
                    str(server.socket_path),
                    "attach",
                    session.name,
                ],
                server.environment,
            )

        pending = start_attach()
        replacement: PtyProcess | None = None
        try:
            time.sleep(0.05)
            busy = start_attach()
            try:
                busy.read_until(b"already attached", 2.0)
            finally:
                busy.close()

            pending.close()
            time.sleep(0.05)
            replacement = start_attach()
            time.sleep(0.05)
            busy_after_cancel = start_attach()
            try:
                busy_after_cancel.read_until(b"already attached", 2.0)
            finally:
                busy_after_cancel.close()
        finally:
            pending.close()
            if replacement is not None:
                replacement.close()

    def test_corrupted_automatic_snapshot_fails_closed_without_retry(self) -> None:
        self.server.close()
        server = LemmaServer.from_environment(
            parking_delay_ms=25, corrupt_parked_snapshots=True
        )
        self.addCleanup(server.close)
        session = server.create_session(
            "corrupt_snapshot",
            attach=False,
            command=(str(server.peer_path), "idle"),
            hold=True,
        )
        pane = session.pane()
        time.sleep(0.05)
        self.assertFalse(session.state().attached)

        capture = server.command(
            "proc", "pane", "capture", "--session", session.name, "--pane", pane.id
        )
        self.assertEqual(capture.status, 1, capture.output)
        result = json.loads(capture.output)["results"][0]["result"]
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(
            result["error"],
            {"reason": "pane_restore_failed", "retryable": False},
        )
        # The failed Pane is no longer a terminal-dependent capture target, while Session
        # metadata remains queryable without attempting to consume post-snapshot PTY bytes.
        repeated = server.command(
            "proc", "pane", "capture", "--session", session.name, "--pane", pane.id
        )
        self.assertEqual(repeated.status, 1, repeated.output)
        self.assertEqual(json.loads(repeated.output)["results"], [])
        self.assertIsNone(server.session_state(session.name))

    def test_attachment_transfer_waits_for_parked_target_hydration(self) -> None:
        source = self.server.create_session("transfer_source")
        target = self.server.create_session("transfer_target", attach=False)
        client = source.require_client()
        time.sleep(0.05)
        self.assertFalse(target.state().attached)

        client.prefix(":")
        client.send("switch transfer_target\r")
        self.server.wait_for_state(
            source.name,
            lambda state: not state.attached,
            "source attachment to transfer",
        )
        self.server.wait_for_state(
            target.name,
            lambda state: state.attached,
            "parked target to hydrate and receive attachment",
        )
        self.assertTrue(client.running)
        client.send("printf '__PARKED_TRANSFER_OK__\\n'\r")
        client.expect_output("__PARKED_TRANSFER_OK__")

    def test_attachment_registry_swap_removal_preserves_remaining_clients(self) -> None:
        sessions = [
            self.server.create_session("attached_registry_first"),
            self.server.create_session("attached_registry_middle"),
            self.server.create_session("attached_registry_last"),
        ]
        clients = [session.require_client() for session in sessions]

        sessions[1].detach()
        for index in (0, 2):
            marker = f"__ATTACHED_AFTER_MIDDLE_{index}__"
            clients[index].send(f"printf '{marker}\\n'\r")
            clients[index].expect_output(marker)

        middle = sessions[1].attach()
        middle.send("printf '__ATTACHED_MIDDLE_REJOINED__\\n'\r")
        middle.expect_output("__ATTACHED_MIDDLE_REJOINED__")

        sessions[0].detach()
        for client, marker in (
            (middle, "__ATTACHED_AFTER_FIRST_MIDDLE__"),
            (clients[2], "__ATTACHED_AFTER_FIRST_LAST__"),
        ):
            client.send(f"printf '{marker}\\n'\r")
            client.expect_output(marker)

        sessions[1].detach()
        clients[2].send("printf '__ATTACHED_LAST_REMAINS__\\n'\r")
        clients[2].expect_output("__ATTACHED_LAST_REMAINS__")

    def test_public_observer_excludes_a_detached_pane_until_disconnect(self) -> None:
        session = self.server.create_session(
            "observed_detached",
            attach=False,
            command=(str(self.server.peer_path), "idle"),
        )
        pane = session.pane()
        observer = subprocess.Popen(
            [
                str(self.server.cli_path),
                str(self.server.socket_path),
                "events",
                "--session",
                session.name,
                "--pane",
                pane.id,
                "--screen",
            ],
            env=self.server.environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert observer.stdout is not None
            ready, _, _ = select.select([observer.stdout], [], [], 2.0)
            self.assertTrue(ready, self.server.diagnostics())
            snapshot = json.loads(observer.stdout.readline())
            self.assertEqual(snapshot["event"], "snapshot")
            time.sleep(0.05)
            capture = self.server.command("pane", "capture", session.name, pane.id)
            self.assertEqual(capture.status, 0, capture.output)
        finally:
            observer.kill()
            observer.communicate(timeout=1.0)

        time.sleep(0.05)
        self.assertFalse(session.state().attached)
        parked_capture = self.server.command("pane", "capture", session.name, pane.id)
        self.assertEqual(parked_capture.status, 1, parked_capture.output)
        self.assertIn("unavailable", parked_capture.output)

    def test_screen_generation_is_consistent_across_passive_observers(self) -> None:
        session = self.server.create_session(
            "shared_observer_screen",
            command=(str(self.server.peer_path), "observer-echo"),
        )
        pane = session.pane()
        pane.expect_output("__LEMMA_OBSERVER_READY__")
        observers = [
            subprocess.Popen(
                [
                    str(self.server.cli_path),
                    str(self.server.socket_path),
                    "events",
                    "--session",
                    session.name,
                    "--pane",
                    pane.id,
                    "--screen",
                ],
                env=self.server.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(4)
        ]
        try:
            initial_generations: list[int] = []
            for observer in observers:
                assert observer.stdout is not None
                ready, _, _ = select.select([observer.stdout], [], [], 2.0)
                self.assertTrue(ready, self.server.diagnostics())
                snapshot = json.loads(observer.stdout.readline())
                self.assertEqual(snapshot["event"], "snapshot")
                initial_generations.append(snapshot["generation"])
            self.assertEqual(len(set(initial_generations)), 1)

            def wait_for_observer_screen(
                observer: subprocess.Popen[str], marker: str
            ) -> dict[str, Any]:
                stream = observer.stdout
                assert stream is not None

                def screen_event() -> dict[str, Any] | None:
                    ready, _, _ = select.select([stream], [], [], 0.02)
                    if not ready:
                        return None
                    event = json.loads(stream.readline())
                    return event if event["event"] == "pane.screen" else None

                event = wait_until(
                    "shared observer screen event",
                    screen_event,
                    timeout=2.0,
                    diagnostics=self.server.diagnostics,
                )
                capture = event["capture"]
                self.assertIsInstance(capture, dict)
                assert isinstance(capture, dict)
                text = capture.get("text")
                self.assertIsInstance(text, str)
                assert isinstance(text, str)
                self.assertIn(marker, text)
                return event

            marker = "__SHARED_OBSERVER_FRAME__"
            pane.send(marker + "\n")
            pane.expect_output(marker)
            generations = [
                wait_for_observer_screen(observer, marker)["generation"]
                for observer in observers
            ]
            self.assertTrue(
                all(isinstance(generation, int) for generation in generations)
            )
            self.assertEqual(len(set(generations)), 1)
            self.assertGreater(generations[0], initial_generations[0])

            # Closing non-edge ownership slots forces dense-registry swap removal. Both retained
            # observers must remain live and converge on the same later terminal generation.
            for observer in observers[1:3]:
                observer.kill()
                observer.communicate(timeout=1.0)
            time.sleep(0.05)
            marker = "__SHARED_OBSERVER_AFTER_HOLES__"
            pane.send(marker + "\n")
            pane.expect_output(marker)
            remaining_generations = [
                wait_for_observer_screen(observer, marker)["generation"]
                for observer in (observers[0], observers[3])
            ]
            self.assertTrue(
                all(isinstance(generation, int) for generation in remaining_generations)
            )
            self.assertEqual(len(set(remaining_generations)), 1)
            self.assertGreater(remaining_generations[0], generations[0])
        finally:
            for observer in observers:
                observer.kill()
                observer.communicate(timeout=1.0)

    def test_public_input_retries_after_hydration_without_dropping_or_duplicating(
        self,
    ) -> None:
        session = self.server.create_session("parked_input")
        pane = session.pane()
        pane.send("printf '__INPUT_BASE__\\n'\r")
        pane.expect_output("__INPUT_BASE__")
        session.detach()
        time.sleep(0.05)
        self.assertFalse(session.state().attached)
        arguments = (
            "proc",
            "pane",
            "input",
            "--session",
            session.name,
            "--pane",
            pane.id,
            "--paste",
            "printf '__HYDRATED_%s__\\n' INPUT",
            "--key",
            "enter",
        )
        initial = self.server.command(*arguments)
        self.assertEqual(initial.status, 1, initial.output)
        initial_result = json.loads(initial.output)["results"][0]["result"]
        self.assertEqual(
            initial_result["error"],
            {"reason": "pane_hydrating", "retryable": True},
        )
        wait_until(
            "public input hydration",
            lambda: (
                result
                if (result := self.server.command(*arguments)).status == 0
                else None
            ),
            diagnostics=self.server.diagnostics,
        )
        client = session.attach()
        client.expect_output("__HYDRATED_INPUT__")
        self.assertEqual(client.screen_text().count("__HYDRATED_INPUT__"), 1)

    def test_blocked_post_snapshot_output_resumes_after_attach(self) -> None:
        gate = self.server.root / "parked-output.gate"
        session = self.server.create_session(
            "parked_output",
            attach=False,
            command=(str(self.server.peer_path), "active-output", str(gate)),
        )
        pane = session.pane()
        ready = wait_until(
            "output peer readiness",
            lambda: (
                result
                if (
                    result := self.server.command(
                        "pane", "capture", session.name, pane.id
                    )
                ).status
                == 0
                and "__LEMMA_ACTIVE_OUTPUT_READY__" in result.output
                else None
            ),
            diagnostics=self.server.diagnostics,
        )
        self.assertIn("__LEMMA_ACTIVE_OUTPUT_READY__", ready.output)
        time.sleep(0.05)
        self.assertFalse(session.state().attached)

        gate.touch()
        time.sleep(0.05)
        pane.expect_alive()
        client = session.attach()
        client.expect_output(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        )
        pane.expect_alive()

    def test_child_exit_wakes_a_parked_held_pane(self) -> None:
        session = self.server.create_session(
            "parked_exit",
            attach=False,
            command=(str(self.server.peer_path), "delayed-exit"),
            hold=True,
        )
        pane = session.pane()
        exited = self.server.wait_for_state(
            session.name,
            lambda state: state.pane(pane.id).process_state == "exited",
            "parked held Pane to publish its process exit",
        )
        self.assertEqual(exited.pane(pane.id).pid, 0)

    def test_destroyed_detached_session_reclaims_its_child(self) -> None:
        session = self.server.create_session("session_destroy")
        pane = session.pane()
        session.detach()
        pane.expect_alive()
        time.sleep(0.05)
        self.assertFalse(session.state().attached)

        session.destroy()

        wait_for_process_exit(pane.process, diagnostics=self.server.diagnostics)
        self.assertIsNone(self.server.session_state(session.name))


if __name__ == "__main__":
    unittest.main()
