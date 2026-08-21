from __future__ import annotations

import json
import select
import socket
import subprocess
import unittest
from typing import Any

from tests.support.mux_harness import LemmaServer


class AgentAutomationMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def json_command(
        self, *arguments: str, timeout: float = 5.0
    ) -> tuple[int, dict[str, Any]]:
        result = self.server.command(*arguments, timeout=timeout)
        try:
            document = json.loads(result.output)
        except json.JSONDecodeError as error:
            self.fail(
                f"command {result.arguments!r} returned invalid JSON with status "
                f"{result.status}:\n{result.output}\n{self.server.logs()}\n{error}"
            )
        return result.status, document

    def first_event(self, *arguments: str) -> dict[str, Any]:
        process = subprocess.Popen(
            [str(self.server.cli_path), str(self.server.socket_path), *arguments],
            env=self.server.environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert process.stdout is not None
        ready, _, _ = select.select([process.stdout], [], [], 2.0)
        if not ready:
            process.kill()
            stdout, stderr = process.communicate(timeout=1.0)
            self.fail(
                f"event stream produced no initial snapshot: stdout={stdout!r} stderr={stderr!r}\n"
                f"{self.server.logs()}"
            )
        line = process.stdout.readline()
        process.kill()
        process.communicate(timeout=1.0)
        return json.loads(line)

    def test_focus_preserving_creation_keeps_controller_selection(self) -> None:
        status, started = self.json_command(
            "action", "session", "start", "focus-preserve", "--", "/bin/sh"
        )
        self.assertEqual(status, 0, started)
        self.assertEqual(started["session"]["revision"], 1)
        status, daemon = self.json_command("action", "daemon", "inspect")
        self.assertEqual(status, 0, daemon)
        self.assertEqual(daemon["daemon"]["resources"]["sessions"]["used"], 1)
        status, session = self.json_command(
            "action", "session", "inspect", "--session", "focus-preserve"
        )
        self.assertEqual(status, 0, session)
        self.assertEqual(session["session_state"]["active_tab"], "0:1")

        status, tab = self.json_command(
            "action",
            "tab",
            "new",
            "--session",
            "focus-preserve",
            "--focus",
            "preserve",
            "--",
            "/bin/sh",
        )
        self.assertEqual(status, 0, tab)
        self.assertEqual(tab["tab"], "1:1")

        status, inspected = self.json_command(
            "action", "tab", "inspect", "--session", "focus-preserve", "--tab", "1:1"
        )
        self.assertEqual(status, 0, inspected)
        self.assertFalse(inspected["tab_state"]["active"])

        status, split = self.json_command(
            "action",
            "pane",
            "split",
            "--session",
            "focus-preserve",
            "--pane",
            "0:1",
            "--right",
            "--focus",
            "preserve",
            "--",
            "/bin/sh",
        )
        self.assertEqual(status, 0, split)

        status, panes = self.json_command(
            "action", "pane", "list", "--session", "focus-preserve"
        )
        self.assertEqual(status, 0, panes)
        active_tab = session["session_state"]["active_tab"]
        focused = [
            pane["id"]
            for pane in panes["panes"]
            if pane["tab"] == active_tab and pane["focused"]
        ]
        self.assertEqual(focused, ["0:1"])
        created = next(pane for pane in panes["panes"] if pane["id"] == split["pane"])
        self.assertFalse(created["focused"])
        status, pane = self.json_command(
            "action", "pane", "inspect", "--session", "focus-preserve", "--pane", "0:1"
        )
        self.assertEqual(status, 0, pane)
        self.assertEqual(pane["pane_state"]["terminal"]["screen"], "primary")

        status, conflict = self.json_command(
            "action",
            "pane",
            "kill",
            "--session",
            "focus-preserve",
            "--pane",
            split["pane"],
            "--if-session-revision",
            "1",
        )
        self.assertEqual(status, 1, conflict)
        self.assertEqual(conflict["status"], "conflict")

    def test_atomic_logical_keys_preserve_order_and_modifier_semantics(self) -> None:
        script = (
            "stty -echo -icanon min 1 time 0; printf '__READY__'; "
            "code=$(dd bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n'); "
            "stty sane; printf '__BYTES_%s__\\n' \"$code\""
        )
        status, started = self.json_command(
            "action",
            "session",
            "start",
            "logical-key",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            script,
        )
        self.assertEqual(status, 0, started)
        status, ready = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "logical-key",
            "--contains",
            "__READY__",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 0, ready)

        status, sent = self.json_command(
            "action",
            "pane",
            "input",
            "--session",
            "logical-key",
            "--pane",
            "0:1",
            "--key",
            "shift+a",
            "--key",
            "control+a",
        )
        self.assertEqual(status, 0, sent)
        status, received = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "logical-key",
            "--contains",
            "__BYTES_4101__",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 0, received)
        self.assertIn("__BYTES_4101__", received["capture"]["text"])
        status, exited = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "logical-key",
            "--exit-code",
            "0",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 0, exited)
        status, inspected = self.json_command(
            "action", "pane", "inspect", "--session", "logical-key", "--pane", "0:1"
        )
        self.assertEqual(status, 0, inspected)
        self.assertEqual(inspected["pane_state"]["process"]["state"], "exited")
        self.assertEqual(inspected["pane_state"]["process"]["code"], 0)
        self.assertFalse(inspected["pane_state"]["terminal"]["input_accepted"])
        status, capture = self.json_command(
            "action",
            "pane",
            "capture",
            "--session",
            "logical-key",
            "--pane",
            "0:1",
            "--source",
            "recent",
            "--lines",
            "20",
            "--wrap",
            "logical",
        )
        self.assertEqual(status, 0, capture)
        self.assertIn("__BYTES_4101__", capture["capture"]["text"])
        status, rejected = self.json_command(
            "action",
            "pane",
            "input",
            "--session",
            "logical-key",
            "--pane",
            "0:1",
            "--key",
            "enter",
        )
        self.assertEqual(status, 1, rejected)
        self.assertEqual(
            rejected["error"], {"reason": "input_unavailable", "retryable": False}
        )

    def test_visible_and_recent_capture_have_distinct_bounded_sources(self) -> None:
        script = "i=1; while [ $i -le 30 ]; do printf '__LINE_%02d__\\n' $i; i=$((i+1)); done"
        status, started = self.json_command(
            "action",
            "session",
            "start",
            "capture-sources",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            script,
        )
        self.assertEqual(status, 0, started)
        status, exited = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "capture-sources",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 0, exited)
        status, visible = self.json_command(
            "action",
            "pane",
            "capture",
            "--session",
            "capture-sources",
            "--pane",
            "0:1",
            "--source",
            "visible",
        )
        self.assertEqual(status, 0, visible)
        self.assertIn("__LINE_30__", visible["capture"]["text"])
        self.assertNotIn("__LINE_01__", visible["capture"]["text"])

        status, recent = self.json_command(
            "action",
            "pane",
            "capture",
            "--session",
            "capture-sources",
            "--pane",
            "0:1",
            "--source",
            "recent",
            "--lines",
            "31",
        )
        self.assertEqual(status, 0, recent)
        self.assertIn("__LINE_01__", recent["capture"]["text"])
        self.assertIn("__LINE_30__", recent["capture"]["text"])

    def test_wait_matches_semantic_prompt_with_capture_evidence(self) -> None:
        status, started = self.json_command(
            "action",
            "session",
            "start",
            "prompt-wait",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            "printf '\\033]133;A\\007$ '; sleep 1",
        )
        self.assertEqual(status, 0, started)
        status, prompted = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "prompt-wait",
            "--until-prompt",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 0, prompted)
        self.assertEqual(prompted["status"], "applied")
        self.assertIn("capture", prompted)

    def test_wait_without_target_uses_current_pane_and_process_completion(self) -> None:
        status, started = self.json_command(
            "action",
            "session",
            "start",
            "context-wait",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            "sleep .1; exit 6",
        )
        self.assertEqual(status, 0, started)
        environment = self.server.environment | {
            "LEMMA_SESSION_ID": started["session"]["id"],
            "LEMMA_TAB_ID": started["tab"],
            "LEMMA_PANE_ID": started["pane"],
        }
        completed = subprocess.run(
            [
                str(self.server.cli_path),
                str(self.server.socket_path),
                "action",
                "pane",
                "wait",
            ],
            env=environment,
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        waited = json.loads(completed.stdout)
        self.assertEqual(waited["condition"], "process-exit")
        self.assertEqual(waited["process"], {"state": "exited", "code": 6})

    def test_wait_action_preserves_persistent_control_lockstep(self) -> None:
        status, started = self.json_command(
            "action",
            "session",
            "start",
            "persistent-wait",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            "sleep .1; exit 0",
        )
        self.assertEqual(status, 0, started)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(5.0)
        connection.connect(str(self.server.socket_path))
        self.addCleanup(connection.close)
        stream = connection.makefile("r", encoding="utf-8")
        self.addCleanup(stream.close)
        connection.sendall(
            json.dumps(
                {
                    "schema": "lemma.action/v1",
                    "action": "pane.wait",
                    "session": {"name": "persistent-wait"},
                    "pane": {"id": "0:1"},
                    "timeout_ms": 2000,
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        waited = json.loads(stream.readline())
        self.assertEqual(waited["status"], "applied")
        connection.sendall(
            b'{"schema":"lemma.action/v1","action":"session.inspect",'
            b'"session":{"name":"persistent-wait"}}\n'
        )
        inspected = json.loads(stream.readline())
        self.assertEqual(inspected["status"], "applied")

    def test_wait_reports_stale_and_unexpected_exit_from_initial_state(self) -> None:
        self.server.require_command("start", "wait-state")
        status, stale = self.json_command(
            "action",
            "pane",
            "wait",
            "63:99",
            "--session",
            "wait-state",
            "--contains",
            "never",
            "--timeout",
            "100ms",
        )
        self.assertEqual(status, 1, stale)
        self.assertEqual(stale["status"], "stale")

        status, timed_out = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "wait-state",
            "--contains",
            "never",
            "--timeout",
            "10ms",
        )
        self.assertEqual(status, 1, timed_out)
        self.assertEqual(timed_out["status"], "failed")
        self.assertEqual(timed_out["error"]["reason"], "timeout")

        removed = self.server.command("wait", "0:1", "--session", "wait-state")
        self.assertEqual(removed.status, 2, removed.output)

        invalid = self.server.command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "wait-state",
            "--contains",
            "never",
            "--timeout",
            "10ms",
            "--if-session-revision",
            "1",
        )
        self.assertEqual(invalid.status, 2, invalid.output)

        status, started = self.json_command(
            "action",
            "session",
            "start",
            "wait-exit",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            "exit 3",
        )
        self.assertEqual(status, 0, started)
        status, exited = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "wait-exit",
            "--contains",
            "never",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 1, exited)
        self.assertEqual(exited["status"], "failed")
        self.assertEqual(exited["error"]["reason"], "unexpected_exit")
        self.assertEqual(exited["process"], {"state": "exited", "code": 3})

        status, started = self.json_command(
            "action",
            "session",
            "start",
            "wait-close",
            "--",
            "/bin/sh",
            "-c",
            "sleep .1; exit 4",
        )
        self.assertEqual(status, 0, started)
        status, closed = self.json_command(
            "action",
            "pane",
            "wait",
            "0:1",
            "--session",
            "wait-close",
            "--timeout",
            "2s",
        )
        self.assertEqual(status, 0, closed)
        self.assertEqual(closed["status"], "applied")
        self.assertEqual(closed["process"], {"state": "exited_unknown"})

    def test_procedure_composes_input_wait_and_inspection_actions(self) -> None:
        procedure = self.server.root / "agent-procedure.json"
        procedure.write_text(
            json.dumps(
                {
                    "schema": "lemma.proc/v1",
                    "actions": [
                        {
                            "id": "root",
                            "action": "session.start",
                            "name": "agent-procedure",
                            "hold": True,
                            "argv": ["/bin/sh"],
                        },
                        {
                            "action": "pane.input",
                            "pane": {"result": "root"},
                            "events": [
                                {"kind": "text", "text": "printf '__PROC_INPUT__\\n'"},
                                {"kind": "key", "key": "enter"},
                            ],
                        },
                        {
                            "action": "pane.wait",
                            "pane": {"result": "root"},
                            "contains": "__PROC_INPUT__",
                            "timeout_ms": 2000,
                        },
                        {"action": "pane.inspect", "pane": {"result": "root"}},
                    ],
                },
                separators=(",", ":"),
            )
        )
        status, result = self.json_command("proc", str(procedure))
        self.assertEqual(status, 0, result)
        self.assertTrue(result["ok"])
        self.assertEqual(
            [entry["result"]["status"] for entry in result["results"]], ["applied"] * 4
        )
        waited = result["results"][2]["result"]
        self.assertEqual(waited["action"], "pane.wait")
        self.assertIn("__PROC_INPUT__", waited["capture"]["text"])

    def test_multi_pane_snapshot_is_authoritative_before_staged_screens(self) -> None:
        self.server.require_command(
            "action", "session", "start", "event-baseline", "--", "/bin/sh"
        )
        self.server.require_command(
            "action",
            "pane",
            "split",
            "--session",
            "event-baseline",
            "--pane",
            "0:1",
            "--right",
            "--focus",
            "preserve",
            "--",
            "/bin/sh",
        )
        snapshot = self.first_event(
            "events",
            "--session",
            "event-baseline",
            "--pane",
            "0:1",
            "--pane",
            "1:1",
            "--screen",
        )
        self.assertEqual(snapshot["event"], "snapshot")
        self.assertEqual(snapshot["sequence"], 0)
        self.assertEqual(
            [(pane["pane"], pane["present"]) for pane in snapshot["panes"]],
            [("0:1", True), ("1:1", True)],
        )
        self.assertTrue(
            all(
                "generation" in pane and "process" in pane for pane in snapshot["panes"]
            )
        )

        missing = self.first_event(
            "events", "--session", "event-baseline", "--pane", "63:99", "--screen"
        )
        self.assertEqual(missing["event"], "snapshot")
        self.assertFalse(missing["present"])


if __name__ == "__main__":
    unittest.main()
