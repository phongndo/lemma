from __future__ import annotations

import json
import socket
import struct
import unittest
from typing import Any

from tests.support.mux_harness import LemmaServer, wait_until

MAGIC = b"\x8aLME"
HEADER = struct.Struct(">4sBBBBII")
HELLO = 1
PROC = 3
PROC_RESULT = 4
SURFACE_UPDATE = 5
EVENT = 6


class ExtensionPeer:
    def __init__(self, path: str) -> None:
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(3.0)
        self.socket.connect(path)

    def close(self) -> None:
        self.socket.close()

    def send(self, kind: int, sequence: int, document: dict[str, Any]) -> None:
        payload = json.dumps(document, separators=(",", ":")).encode()
        self.socket.sendall(
            HEADER.pack(MAGIC, 1, 0, kind, 0, len(payload), sequence) + payload
        )

    def receive(self) -> tuple[int, int, dict[str, Any]]:
        header = bytearray()
        while len(header) < HEADER.size:
            chunk = self.socket.recv(HEADER.size - len(header))
            if not chunk:
                raise EOFError("extension peer closed while reading a record header")
            header.extend(chunk)
        magic, major, minor, kind, flags, size, sequence = HEADER.unpack(header)
        if (magic, major, minor, flags) != (MAGIC, 1, 0, 0):
            raise AssertionError("invalid extension response header")
        payload = bytearray()
        while len(payload) < size:
            chunk = self.socket.recv(size - len(payload))
            if not chunk:
                raise EOFError("extension peer closed while reading a record payload")
            payload.extend(chunk)
        return kind, sequence, json.loads(payload)

    def receive_matching(
        self, kind: int, sequence: int | None = None
    ) -> dict[str, Any]:
        for _ in range(16):
            received_kind, received_sequence, document = self.receive()
            if received_kind == kind and (
                sequence is None or received_sequence == sequence
            ):
                return document
        raise AssertionError(f"did not receive record kind={kind} sequence={sequence}")

    def receive_proc_before_surface_event(
        self, sequence: int, event_name: str, surface: str | None = None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        result: dict[str, Any] | None = None
        for _ in range(32):
            kind, received_sequence, document = self.receive()
            if kind == PROC_RESULT and received_sequence == sequence:
                result = document
                continue
            if (
                kind == EVENT
                and document.get("event") == event_name
                and (surface is None or document.get("surface") == surface)
            ):
                if result is None:
                    raise AssertionError(f"{event_name} preceded ProcResult {sequence}")
                return result, document
        raise AssertionError(
            f"did not receive ProcResult {sequence} followed by {event_name}"
        )


class ExtensionRuntimeMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def test_docked_surface_input_proc_and_generation_cleanup(self) -> None:
        session = self.server.create_session(
            "extension-runtime", attach=True, command=("/bin/cat",)
        )
        client = self.server.clients[0]
        initial = self.server.session_state(session.name)
        assert initial is not None
        pane = initial.focused

        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "runtime-test",
                "capabilities": ["observe", "proc", "surface"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": initial.id},
                },
            },
        )
        welcome_kind, welcome_sequence, welcome = peer.receive()
        self.assertEqual((welcome_kind, welcome_sequence), (2, 1))
        self.assertEqual(welcome["schema"], "lemma.extension-welcome/v1")
        snapshot_kind, snapshot_sequence, snapshot = peer.receive()
        self.assertEqual((snapshot_kind, snapshot_sequence), (EVENT, 1))
        self.assertEqual(snapshot["event"], "snapshot")

        peer.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.create",
                        "placement": {"kind": "dock.right", "size": 20},
                    }
                ],
            },
        )
        created, resized = peer.receive_proc_before_surface_event(2, "surface.resized")
        surface = created["results"][0]["result"]["surface"]
        self.assertTrue(created["ok"])
        self.assertEqual(resized["surface"], surface)
        self.assertEqual((resized["columns"], resized["rows"]), (20, 23))

        peer.send(
            SURFACE_UPDATE,
            3,
            {
                "schema": "lemma.surface-update/v1",
                "surface": surface,
                "rows": [
                    {
                        "row": 0,
                        "runs": [
                            {"column": 0, "text": "extension surface", "style": 0}
                        ],
                    }
                ],
            },
        )
        client.expect_output("extension surface")

        peer.send(
            PROC,
            4,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.configure",
                        "surface": {"id": surface},
                        "placement": {"kind": "dock.right", "size": 18},
                    }
                ],
            },
        )
        configured, configured_event = peer.receive_proc_before_surface_event(
            4, "surface.resized", surface
        )
        self.assertTrue(configured["ok"])
        self.assertEqual(
            (configured_event["columns"], configured_event["rows"]), (18, 23)
        )

        peer.send(
            PROC,
            5,
            {
                "schema": "lemma.proc/v1",
                "commands": [{"command": "surface.focus", "surface": {"id": surface}}],
            },
        )
        focused, focused_event = peer.receive_proc_before_surface_event(
            5, "surface.focused", surface
        )
        self.assertTrue(focused["ok"])
        self.assertEqual(focused_event["surface"], surface)
        client.drain(0.2)
        client.send("XYZ")
        client.drain(0.2)
        key_event = peer.receive_matching(EVENT)
        while key_event.get("event") != "surface.key":
            key_event = peer.receive_matching(EVENT)
        self.assertEqual(key_event["surface"], surface)
        self.assertEqual(key_event["text"], "XYZ")

        client.send(b"\x1b[<0;70;2M")
        mouse_press = peer.receive_matching(EVENT)
        while mouse_press.get("event") != "surface.mouse":
            mouse_press = peer.receive_matching(EVENT)
        self.assertEqual(mouse_press["surface"], surface)
        self.assertEqual((mouse_press["column"], mouse_press["row"]), (7, 0))
        client.send(b"\x1b[<0;10;2m")
        mouse_release = peer.receive_matching(EVENT)
        while mouse_release.get("event") != "surface.mouse":
            mouse_release = peer.receive_matching(EVENT)
        self.assertEqual(mouse_release["surface"], surface)
        self.assertEqual((mouse_release["column"], mouse_release["row"]), (-53, 0))

        client.send(b"\x1b[200~pasted\x1b[201~")
        paste_event = peer.receive_matching(EVENT)
        while paste_event.get("event") != "surface.paste":
            paste_event = peer.receive_matching(EVENT)
        self.assertEqual(paste_event["surface"], surface)
        self.assertEqual(paste_event["text"], "pasted")

        peer.send(
            PROC,
            6,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "pane.send",
                        "session": {"id": initial.id},
                        "pane": {"id": pane.id},
                        "text": "P",
                    }
                ],
            },
        )
        pane_proc = peer.receive_matching(PROC_RESULT, 6)
        self.assertTrue(pane_proc["ok"])

        peer.close()

        def restored() -> bool | None:
            result = self.server.command(
                "proc", "pane", "list", "--session", session.name
            )
            if result.status != 0:
                return None
            document = json.loads(result.output)["results"][0]["result"]
            current = document["panes"][0]
            return (
                True
                if current["columns"] == 80
                and current["rows"] == 23
                and current["process"]["pid"] == pane.pid
                else None
            )

        wait_until(
            "extension disconnect to restore pane viewport",
            restored,
            diagnostics=lambda: self.server.diagnostics(session.name),
        )
        client.send("alive")
        client.expect_output("alive")


if __name__ == "__main__":
    unittest.main()
