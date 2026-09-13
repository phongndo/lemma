from __future__ import annotations

import json
import os
import socket
import struct
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
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
        self.input = bytearray()

    def close(self) -> None:
        self.socket.close()

    @staticmethod
    def encode(kind: int, sequence: int, document: dict[str, Any]) -> bytes:
        payload = json.dumps(document, separators=(",", ":")).encode()
        return HEADER.pack(MAGIC, 1, 0, kind, 0, len(payload), sequence) + payload

    def send(self, kind: int, sequence: int, document: dict[str, Any]) -> None:
        self.socket.sendall(self.encode(kind, sequence, document))

    def send_batch(self, records: list[tuple[int, int, dict[str, Any]]]) -> None:
        self.socket.sendall(
            b"".join(
                self.encode(kind, sequence, document)
                for kind, sequence, document in records
            )
        )

    def receive(self) -> tuple[int, int, dict[str, Any]]:
        # Preserve partial records across bounded waits, including handshake-drain probes.
        def fill(size: int) -> None:
            while len(self.input) < size:
                chunk = self.socket.recv(size - len(self.input))
                if not chunk:
                    raise EOFError("extension peer closed while reading a record")
                self.input.extend(chunk)

        fill(HEADER.size)
        magic, major, minor, kind, flags, size, sequence = HEADER.unpack(
            self.input[: HEADER.size]
        )
        if (
            (magic, major, minor, flags) != (MAGIC, 1, 0, 0)
            or not 0 < sequence <= 0xFFFFFFFF
            or size > 1024 * 1024
        ):
            raise AssertionError("invalid extension response header")
        fill(HEADER.size + size)
        payload = bytes(self.input[HEADER.size : HEADER.size + size])
        del self.input[: HEADER.size + size]
        return kind, sequence, json.loads(payload.decode("utf-8"))

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

    def test_independent_surface_update_conformance_corpus(self) -> None:
        session = self.server.create_session(
            "conformance", attach=False, command=("/bin/cat",)
        )
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "conformance",
                "capabilities": ["proc", "surface"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": session.state().id},
                },
            },
        )
        peer.receive_matching(2, 1)
        peer.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.create",
                        "placement": {
                            "kind": "overlay",
                            "column": 0,
                            "row": 0,
                            "columns": 20,
                            "rows": 2,
                        },
                    }
                ],
            },
        )
        result, _ = peer.receive_proc_before_surface_event(2, "surface.resized")
        surface = result["results"][0]["result"]["surface"]
        corpus = json.loads(
            (
                Path(__file__).parent / "fixtures" / "extension_conformance.json"
            ).read_text()
        )
        for index, case in enumerate(corpus):
            with self.subTest(case=case["name"]):
                sequence = index * 2 + 3
                peer.send(
                    SURFACE_UPDATE,
                    sequence,
                    {
                        "schema": "lemma.surface-update/v1",
                        "surface": surface,
                        **case["patch"],
                    },
                )
                # A following Proc is a record-order barrier, not a sleep or a guessed response end.
                peer.send(
                    PROC,
                    sequence + 1,
                    {
                        "schema": "lemma.proc/v1",
                        "commands": [{"command": "session.list"}],
                    },
                )
                errors = []
                while True:
                    kind, received_sequence, document = peer.receive()
                    if kind == 7:
                        self.assertEqual(received_sequence, sequence)
                        errors.append(document)
                    if kind == PROC_RESULT:
                        self.assertEqual(received_sequence, sequence + 1)
                        self.assertTrue(document["ok"], document)
                        break
                self.assertEqual(not errors, case["accepted"], errors)

    def test_semantic_focus_handoff_is_consistent(self) -> None:
        session = self.server.create_session("focus-handoff", command=("/bin/cat",))
        first = session.state()
        self.server.require_command(
            "proc", "tab", "new", "--session", first.id, "--", "/bin/cat"
        )
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "focus-handoff",
                "capabilities": ["proc", "surface"],
                "events": {"schema": "lemma.events/v1", "session": {"id": first.id}},
            },
        )
        peer.receive_matching(2, 1)
        peer.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.create",
                        "placement": {
                            "kind": "overlay",
                            "column": 0,
                            "row": 0,
                            "columns": 1,
                            "rows": 1,
                        },
                    }
                ],
            },
        )
        result, _ = peer.receive_proc_before_surface_event(2, "surface.resized")
        surface = result["results"][0]["result"]["surface"]
        sequence = 2
        client = session.require_client()
        client.drain(0.2)

        def focus() -> None:
            nonlocal sequence
            sequence += 1
            peer.send(
                PROC,
                sequence,
                {
                    "schema": "lemma.proc/v1",
                    "commands": [
                        {"command": "surface.focus", "surface": {"id": surface}}
                    ],
                },
            )
            focused = peer.receive_matching(PROC_RESULT, sequence)
            self.assertTrue(focused["ok"], focused)
            # Drain owner focus Events, without requiring a duplicate focused Event on no_effect.
            peer.socket.settimeout(0.05)
            try:
                while True:
                    peer.receive()
            except TimeoutError:
                pass
            peer.socket.settimeout(3.0)

        for command in [
            b"\x021",
            b"\x02n",
            b"\x02p",
            b"\x02:tab select 1\r",
            f"\x02:pane focus {first.focused.id}\r".encode(),
        ]:
            with self.subTest(command=command):
                focus()
                client.send(command)
                client.drain(0.2)
                client.send(b"marker\n")
                client.drain(0.2)
                event = peer.receive_matching(EVENT)
                self.assertEqual(event["event"], "surface.blurred", event)

        for command in [
            (
                "proc",
                "tab",
                "new",
                "--session",
                first.id,
                "--focus",
                "preserve",
                "--",
                "/bin/cat",
            ),
            ("proc", "pane", "focus", "--session", first.id, "--pane", "0:999999"),
        ]:
            with self.subTest(proc=command):
                focus()
                result = self.server.command(*command)
                self.assertEqual(
                    result.status == 0, "preserve" in command, result.output
                )
                client.send(b"preserved")
                client.drain(0.1)
                event = peer.receive_matching(EVENT)
                self.assertEqual(
                    (event["event"], event["text"]), ("surface.key", "preserved")
                )
        for command in ["tab new --focus preserve -- /bin/cat", "pane focus 0:999999"]:
            with self.subTest(prompt=command):
                focus()
                client.prefix(":")
                client.send(command + "\r")
                client.drain(0.2)
                client.send("prompt-preserved")
                client.drain(0.1)
                event = peer.receive_matching(EVENT)
                self.assertEqual(
                    (event["event"], event["text"]), ("surface.key", "prompt-preserved")
                )

        # A failed native split must not hand off semantic focus just because parsing succeeded.
        focus()
        client.resize(2, 3)
        self.server.wait_for_state(
            session.name, lambda value: value.columns == 2, "tiny focus viewport"
        )
        client.send(b"\x02%rejected")
        event = peer.receive_matching(EVENT)
        self.assertEqual(event["event"], "surface.key", event)
        self.assertEqual(event["text"], "rejected")

    def test_surface_paste_preserves_opaque_bytes_with_strict_json(self) -> None:
        session = self.server.create_session("opaque-paste", command=("/bin/cat",))
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "opaque-input",
                "capabilities": ["proc", "surface"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": session.state().id},
                },
            },
        )
        peer.receive_matching(2, 1)
        peer.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.create",
                        "placement": {
                            "kind": "overlay",
                            "column": 0,
                            "row": 0,
                            "columns": 2,
                            "rows": 1,
                        },
                    }
                ],
            },
        )
        result, _ = peer.receive_proc_before_surface_event(2, "surface.resized")
        surface = result["results"][0]["result"]["surface"]
        peer.send(
            PROC,
            3,
            {
                "schema": "lemma.proc/v1",
                "commands": [{"command": "surface.focus", "surface": {"id": surface}}],
            },
        )
        peer.receive_proc_before_surface_event(3, "surface.focused")
        client = session.require_client()
        client.drain(0.2)
        for data in [
            b"\xff\x00\xc0\xaf\xed\xa0\x80",
            b"\xe2",
            b"\x82\xac",
            "hé🙂".encode(),
            (b'\x00\x01"\\\n' * 4096),
            b"\x00" * (1024 * 1024),
        ]:
            with self.subTest(size=len(data), prefix=data[:8]):
                with ThreadPoolExecutor(max_workers=1) as sender:
                    sent = sender.submit(
                        client.send, b"\x1b[200~" + data + b"\x1b[201~", timeout=5.0
                    )
                    received = bytearray()
                    while len(received) < len(data):
                        event = peer.receive_matching(EVENT)
                        if event.get("event") != "surface.paste":
                            continue
                        # Python's strict UTF-8/JSON decoder and bytes.fromhex are independent
                        # of Lemma's parser, serializer, and framing implementation.
                        self.assertNotIn("text", event)
                        chunk = bytes.fromhex(event["bytes_hex"])
                        self.assertLessEqual(len(chunk), 4096)
                        received.extend(chunk)
                    sent.result(timeout=5.0)
                    self.assertEqual(received, data)
        peer.send(
            PROC,
            4,
            {"schema": "lemma.proc/v1", "commands": [{"command": "session.list"}]},
        )
        self.assertTrue(peer.receive_matching(PROC_RESULT, 4)["ok"])

    def test_global_extension_service_is_fair_across_buffered_structural_work(
        self,
    ) -> None:
        session = self.server.create_session("global-fairness", command=("/bin/cat",))
        state = session.state()
        client = session.require_client()
        peers: list[ExtensionPeer] = []
        surfaces: list[str] = []
        for index in range(32):
            peer = ExtensionPeer(str(self.server.socket_path))
            peers.append(peer)
            self.addCleanup(peer.close)
            peer.send(
                HELLO,
                1,
                {
                    "schema": "lemma.extension/v1",
                    "name": f"fair-{index}",
                    "capabilities": ["observe", "proc", "surface"],
                    "events": {
                        "schema": "lemma.events/v1",
                        "session": {"id": state.id},
                        "panes": [{"id": state.focused.id}],
                        "screen": True,
                    },
                },
            )
            peer.receive_matching(2, 1)
            peer.receive_matching(EVENT)
            placement = (
                {"kind": "dock.right", "size": 2}
                if index == 0
                else {
                    "kind": "overlay",
                    "column": index % 8,
                    "row": index % 4,
                    "columns": 8,
                    "rows": 1,
                }
            )
            peer.send(
                PROC,
                2,
                {
                    "schema": "lemma.proc/v1",
                    "commands": [
                        {
                            "command": "surface.create",
                            "placement": placement,
                            "opaque": index % 2 == 0,
                        }
                    ],
                },
            )
            result, _ = peer.receive_proc_before_surface_event(2, "surface.resized")
            self.assertTrue(result["ok"], result)
            surfaces.append(result["results"][0]["result"]["surface"])

        for index, (peer, surface) in enumerate(zip(peers, surfaces, strict=True)):
            updates = []
            for sequence in range(10, 14):
                document: dict[str, Any] = {
                    "schema": "lemma.surface-update/v1",
                    "surface": surface,
                    "rows": [
                        {
                            "row": 0,
                            "runs": [{"column": 0, "text": f"{index:02d}-{sequence}"}],
                        }
                    ],
                }
                if index == 0 and sequence == 10:
                    # One near-limit complete record pays the global parse/validation budget and
                    # is rejected without preventing small records on other peers from progressing.
                    document = {
                        "schema": "lemma.surface-update/v1",
                        "surface": surface,
                        "padding": "x" * 900_000,
                    }
                updates.append((SURFACE_UPDATE, sequence, document))
            updates.append(
                (
                    PROC,
                    14,
                    {
                        "schema": "lemma.proc/v1",
                        "commands": [{"command": "session.list"}],
                    },
                )
            )
            peer.send_batch(updates)

        marker = "GLOBAL_FAIRNESS_PTY"
        client.send((marker + "\n").encode())
        session.pane().expect_output(marker)
        for index, peer in enumerate(peers):
            barrier = False
            observed = False
            rejected = False
            for _ in range(64):
                kind, sequence, document = peer.receive()
                barrier = barrier or (
                    kind == PROC_RESULT
                    and sequence == 14
                    and document.get("ok") is True
                )
                rejected = rejected or (kind == 7 and sequence == 10)
                observed = observed or (
                    kind == EVENT
                    and document.get("event") == "pane.screen"
                    and marker in json.dumps(document)
                )
                if barrier and observed and (index != 0 or rejected):
                    break
            self.assertTrue(barrier, f"peer {index} did not cross its Proc barrier")
            self.assertTrue(observed, f"peer {index} did not observe terminal progress")
            self.assertEqual(rejected, index == 0)

        for peer in peers:
            peer.close()

        def restored() -> bool | None:
            panes = self.server.require_command(
                "proc", "pane", "list", "--session", session.name
            )
            pane = json.loads(panes.output)["results"][0]["result"]["panes"][0]
            return True if pane["columns"] == 80 else None

        wait_until("global extension cleanup repair", restored)

    def test_blocked_paste_owner_does_not_starve_other_peers_or_pane(self) -> None:
        session = self.server.create_session("blocked-extension", command=("/bin/cat",))
        state = session.state()
        client = session.require_client()
        blocked = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(blocked.close)
        blocked.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "blocked",
                "capabilities": ["proc", "surface"],
                "events": {"schema": "lemma.events/v1", "session": {"id": state.id}},
            },
        )
        blocked.receive_matching(2, 1)
        blocked.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.create",
                        "placement": {"kind": "dock.right", "size": 8},
                    }
                ],
            },
        )
        created, _ = blocked.receive_proc_before_surface_event(2, "surface.resized")
        surface = created["results"][0]["result"]["surface"]
        blocked.send(
            PROC,
            3,
            {
                "schema": "lemma.proc/v1",
                "commands": [{"command": "surface.focus", "surface": {"id": surface}}],
            },
        )
        blocked.receive_proc_before_surface_event(3, "surface.focused")

        others: list[ExtensionPeer] = []
        for index in range(4):
            peer = ExtensionPeer(str(self.server.socket_path))
            others.append(peer)
            self.addCleanup(peer.close)
            peer.send(
                HELLO,
                1,
                {
                    "schema": "lemma.extension/v1",
                    "name": f"other-{index}",
                    "capabilities": ["proc"],
                },
            )
            peer.receive_matching(2, 1)

        data = b"x" * (1024 * 1024)
        with ThreadPoolExecutor(max_workers=1) as sender:
            paste = sender.submit(
                client.send, b"\x1b[200~" + data + b"\x1b[201~", timeout=5.0
            )
            for sequence in range(2, 10):
                for peer in others:
                    peer.send(
                        PROC,
                        sequence,
                        {
                            "schema": "lemma.proc/v1",
                            "commands": [{"command": "session.list"}],
                        },
                    )
                    result = peer.receive_matching(PROC_RESULT, sequence)
                    self.assertTrue(result["ok"], result)
                # Keep the independent physical client writable; only the extension reader is
                # intentionally blocked in this fixture.
                client.drain(0.01)
            paste.result(timeout=5.0)
            client.drain(0.01)

        # The peer has not drained any paste Event. Its kernel socket may still absorb the bounded
        # daemon queue, so disconnect explicitly rather than relying on platform buffer size.
        blocked.close()

        marker = "AFTER_BLOCKED_EXTENSION"
        client.send((marker + "\n").encode())
        session.pane().expect_output(marker)

        def restored() -> bool | None:
            panes = self.server.require_command(
                "proc", "pane", "list", "--session", session.name
            )
            pane = json.loads(panes.output)["results"][0]["result"]["panes"][0]
            return True if pane["columns"] == 80 else None

        wait_until("blocked extension cleanup repair", restored)

    def test_process_exit_and_pane_closure_are_observed(self) -> None:
        self.server.require_command(
            "proc", "session", "start", "process-events", "--hold", "--", "/bin/sh"
        )
        state = self.server.session_state("process-events")
        assert state is not None
        # Keep the Session alive when the selected held Pane is explicitly removed.
        self.server.require_command(
            "proc",
            "pane",
            "split",
            "--session",
            state.id,
            "--pane",
            state.focused.id,
            "--right",
            "--",
            "/bin/cat",
        )
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "process-events",
                "capabilities": ["observe"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": state.id},
                    "pane": {"id": state.focused.id},
                },
            },
        )
        peer.receive_matching(2, 1)
        peer.receive_matching(EVENT)
        self.server.require_command(
            "proc",
            "pane",
            "input",
            "--session",
            state.id,
            "--pane",
            state.focused.id,
            "--text",
            "exit 7\r",
        )
        while True:
            event = peer.receive_matching(EVENT)
            if (
                event.get("event") == "pane.process"
                and event.get("process", {}).get("state") == "exited"
            ):
                self.assertEqual(event["process"]["code"], 7)
                break
        self.server.require_command(
            "proc", "pane", "kill", "--session", state.id, "--pane", state.focused.id
        )
        while True:
            event = peer.receive_matching(EVENT)
            if event.get("event") == "pane.closed":
                self.assertEqual(event["pane"], state.focused.id)
                break

    def test_later_observed_pane_delivers_without_unrelated_daemon_activity(
        self,
    ) -> None:
        session = self.server.create_session(
            "quiescent", attach=False, command=("/bin/cat",)
        )
        first = session.state().focused
        gate = self.server.root / "observation-gate"
        os.mkfifo(gate)
        # A FIFO write wakes only this child. No Proc, client input, or periodic daemon probe
        # supplies extra reactor turns after the one terminal invalidation.
        result = self.server.require_command(
            "proc",
            "pane",
            "split",
            "--session",
            session.name,
            "--pane",
            first.id,
            "--right",
            "--",
            "/bin/sh",
            "-c",
            f'while read -r token; do printf "\\n%s\\n" "$token"; done < "{gate}"',
        )
        second = json.loads(result.output)["results"][0]["result"]["pane"]
        panes = [{"id": first.id}]
        for _ in range(2):
            result = self.server.require_command(
                "proc",
                "pane",
                "split",
                "--session",
                session.name,
                "--pane",
                first.id,
                "--down",
                "--",
                "/bin/cat",
            )
            panes.append(
                {"id": json.loads(result.output)["results"][0]["result"]["pane"]}
            )
        panes.append({"id": second})
        writer = os.open(gate, os.O_WRONLY)
        self.addCleanup(os.close, writer)
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "quiescent",
                "capabilities": ["observe"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": session.state().id},
                    "panes": panes,
                    "screen": True,
                },
            },
        )
        peer.receive_matching(2, 1)
        peer.receive_matching(EVENT)
        peer.socket.settimeout(1.0)
        try:
            while True:
                peer.receive()
        except TimeoutError:
            pass
        peer.socket.settimeout(0.3)
        for index in range(3):
            marker = f"QUIESCENT_{index}"
            os.write(writer, (marker + "\n").encode())
            while True:
                _, _, event = peer.receive()
                if (
                    event.get("event") == "pane.screen"
                    and event.get("pane") == second
                    and marker in json.dumps(event)
                ):
                    break

    def test_capability_combinations_through_listener(self) -> None:
        session = self.server.create_session(
            "capabilities", attach=False, command=("/bin/cat",)
        )
        state = session.state()
        for mask in range(1, 8):
            capabilities = [
                name
                for bit, name in enumerate(["observe", "proc", "surface"])
                if mask & (1 << bit)
            ]
            for scoped in [False, True]:
                with self.subTest(capabilities=capabilities, scoped=scoped):
                    peer = ExtensionPeer(str(self.server.socket_path))
                    try:
                        hello: dict[str, Any] = {
                            "schema": "lemma.extension/v1",
                            "name": "capabilities",
                            "capabilities": capabilities,
                        }
                        if scoped:
                            hello["events"] = {
                                "schema": "lemma.events/v1",
                                "session": {"id": state.id},
                            }
                        peer.send(HELLO, 1, hello)
                        if not scoped and mask != 2:
                            with self.assertRaises(EOFError):
                                peer.receive()
                            continue
                        welcome = peer.receive_matching(2, 1)
                        self.assertEqual(welcome["capabilities"], capabilities)
                        self.assertEqual(
                            {
                                key: welcome["limits"][key]
                                for key in [
                                    "peers",
                                    "surfaces_aggregate",
                                    "input_bytes_aggregate",
                                    "output_bytes_aggregate",
                                    "read_bytes_per_turn",
                                    "record_work_bytes_per_turn",
                                    "records_per_turn",
                                    "write_bytes_per_turn",
                                ]
                            },
                            {
                                "peers": 32,
                                "surfaces_aggregate": 128,
                                "input_bytes_aggregate": 33_554_944,
                                "output_bytes_aggregate": 67_108_864,
                                "read_bytes_per_turn": 262_144,
                                "record_work_bytes_per_turn": 1_048_832,
                                "records_per_turn": 16,
                                "write_bytes_per_turn": 524_288,
                            },
                        )
                        if scoped:
                            self.assertRegex(
                                welcome["attachment"], r"^[0-9]+:[1-9][0-9]*$"
                            )
                        else:
                            self.assertNotIn("attachment", welcome)
                        if "observe" in capabilities:
                            kind, sequence, event = peer.receive()
                            self.assertEqual(
                                (kind, sequence, event["event"]), (EVENT, 1, "snapshot")
                            )
                        if "proc" in capabilities:
                            peer.send(
                                PROC,
                                2,
                                {
                                    "schema": "lemma.proc/v1",
                                    "commands": [{"command": "session.list"}],
                                },
                            )
                            if "observe" in capabilities:
                                result = peer.receive_matching(PROC_RESULT, 2)
                            else:
                                kind, sequence, result = peer.receive()
                                self.assertEqual((kind, sequence), (PROC_RESULT, 2))
                            self.assertTrue(result["ok"], result)
                    finally:
                        peer.close()

    def test_surface_recovery_after_shrink_reaches_real_pty(self) -> None:
        session = self.server.create_session("shrink-surfaces")
        state = session.state()
        client = session.require_client()
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "shrink",
                "capabilities": ["proc", "surface"],
                "events": {"schema": "lemma.events/v1", "session": {"id": state.id}},
            },
        )
        peer.receive_matching(2, 1)
        sequence = 1

        def proc(command: dict[str, Any]) -> dict[str, Any]:
            nonlocal sequence
            sequence += 1
            peer.send(
                PROC, sequence, {"schema": "lemma.proc/v1", "commands": [command]}
            )
            return peer.receive_matching(PROC_RESULT, sequence)

        surfaces = []
        for placement in [
            {"kind": "dock.right", "size": 35},
            {"kind": "dock.left", "size": 35},
            {"kind": "float", "column": 60, "row": 15, "columns": 10, "rows": 2},
        ]:
            result = proc({"command": "surface.create", "placement": placement})
            self.assertTrue(result["ok"], result)
            surfaces.append(result["results"][0]["result"]["surface"])
        self.assertTrue(
            proc({"command": "surface.focus", "surface": {"id": surfaces[2]}})["ok"]
        )
        client.resize(30, 10)
        self.server.wait_for_state(
            session.name,
            lambda value: value.columns == 30 and value.rows == 10,
            "small viewport",
        )
        # Closing one dock must not be rejected because another dock and the float no longer fit.
        closed = proc({"command": "surface.close", "surface": {"id": surfaces[0]}})
        self.assertTrue(closed["ok"], closed)
        repaired = proc(
            {
                "command": "surface.configure",
                "surface": {"id": surfaces[1]},
                "placement": {"kind": "dock.left", "size": 5},
            }
        )
        self.assertTrue(repaired["ok"], repaired)
        rejected = proc(
            {
                "command": "surface.configure",
                "surface": {"id": surfaces[1]},
                "placement": {"kind": "dock.left", "size": 100},
            }
        )
        self.assertFalse(rejected["ok"], rejected)

        def geometry(columns: int, rows: int, marker: str) -> None:
            panes = self.server.require_command(
                "proc", "pane", "list", "--session", session.name
            )
            pane = json.loads(panes.output)["results"][0]["result"]["panes"][0]
            self.assertEqual((pane["columns"], pane["rows"]), (columns, rows))
            # Query the slave PTY, not just Core's published rectangle. Hidden Surface focus must
            # have fallen back natively so physical input reaches this unchanged shell.
            client.send(
                f"m='{marker[:4]}'; printf \"${{m}}{marker[4:]} \"; stty size\r"
            )
            session.pane().expect_output(f"{marker} {rows} {columns}")
            self.assertEqual(pane["process"]["pid"], state.focused.pid)

        geometry(25, 9, "SMALL_PTY")
        client.resize(80, 24)
        self.server.wait_for_state(
            session.name,
            lambda value: value.columns == 80 and value.rows == 24,
            "recovered viewport",
        )
        geometry(75, 23, "LARGE_PTY")
        self.assertTrue(
            proc({"command": "surface.focus", "surface": {"id": surfaces[2]}})["ok"]
        )
        peer.close()

        def restored() -> bool | None:
            panes = self.server.require_command(
                "proc", "pane", "list", "--session", session.name
            )
            pane = json.loads(panes.output)["results"][0]["result"]["panes"][0]
            return True if pane["columns"] == 80 else None

        wait_until("disconnect repair", restored)
        geometry(80, 23, "CLEAN_PTY")

    def test_destroyed_surface_scope_cannot_capture_reused_attachment(self) -> None:
        session = self.server.create_session(
            "old-scope", attach=True, command=("/bin/cat",)
        )
        self.server.create_session("keep-daemon", attach=False, command=("/bin/cat",))
        original = session.state()
        client = session.require_client()
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "scope-test",
                "capabilities": ["proc", "surface"],
                "events": {"schema": "lemma.events/v1", "session": {"id": original.id}},
            },
        )
        peer.receive_matching(2, 1)
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
        created, _ = peer.receive_proc_before_surface_event(2, "surface.resized")
        surface = created["results"][0]["result"]["surface"]
        peer.send(
            PROC,
            3,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.focus",
                        "surface": {"id": surface},
                    }
                ],
            },
        )
        peer.receive_proc_before_surface_event(3, "surface.focused", surface)
        client.drain(0.2)
        client.send(b"\x1b[<0;70;2M")
        mouse = peer.receive_matching(EVENT)
        self.assertEqual(mouse["event"], "surface.mouse")
        session.destroy()
        replacement = self.server.create_session(
            "new-scope", attach=True, command=("/bin/cat",)
        )
        state = replacement.state()
        self.assertEqual(original.id.split(":")[0], state.id.split(":")[0])
        self.assertNotEqual(original.id, state.id)
        fresh = replacement.require_client()
        fresh.send("new-key\n")
        fresh.send(b"\x1b[200~new-paste\n\x1b[201~")
        fresh.send(b"\x1b[<0;70;2m")
        fresh.expect_output("new-key")
        fresh.expect_output("new-paste")
        # All owned resources are revoked, even though observe was never granted.
        with self.assertRaises(EOFError):
            peer.receive()
        panes = self.server.command(
            "proc", "pane", "list", "--session", replacement.name
        )
        pane = json.loads(panes.output)["results"][0]["result"]["panes"][0]
        self.assertEqual((pane["columns"], pane["rows"]), (80, 23))

    def test_buffered_updates_progress_after_service_budget(self) -> None:
        session = self.server.create_session(
            "extension-buffered", attach=True, command=("/bin/cat",)
        )
        client = self.server.clients[0]
        state = session.state()
        peer = ExtensionPeer(str(self.server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "buffered",
                "capabilities": ["proc", "surface"],
                "events": {"schema": "lemma.events/v1", "session": {"id": state.id}},
            },
        )
        peer.receive_matching(2, 1)
        peer.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {
                        "command": "surface.create",
                        "placement": {
                            "kind": "overlay",
                            "column": 0,
                            "row": 0,
                            "columns": 40,
                            "rows": 8,
                        },
                    }
                ],
            },
        )
        created = peer.receive_matching(PROC_RESULT, 2)
        self.assertTrue(created["ok"], created)
        surface = created["results"][0]["result"]["surface"]
        records = bytearray()
        # More than one native read, with many complete records left after the
        # four-record peer budget. Dependent row patches must all make progress.
        for index in range(512):
            payload = json.dumps(
                {
                    "schema": "lemma.surface-update/v1",
                    "surface": surface,
                    "rows": [
                        {
                            "row": index % 8,
                            "runs": [
                                {
                                    "column": 0,
                                    "text": f"row-{index % 8}-update-{index:04d}",
                                }
                            ],
                        }
                    ],
                },
                separators=(",", ":"),
            ).encode()
            records.extend(
                HEADER.pack(MAGIC, 1, 0, SURFACE_UPDATE, 0, len(payload), index + 3)
            )
            records.extend(payload)
        peer.socket.sendall(records)
        for index in range(504, 512):
            client.expect_output(f"row-{index % 8}-update-{index:04d}")
        client.send("\n" * 10 + "native-progress\n")
        client.expect_output("native-progress")

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
        self.assertEqual(bytes.fromhex(paste_event["bytes_hex"]), b"pasted")

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

        # The semantic Attachment survives ordinary detach and Session switching;
        # its Surface belongs to that Session, not to the transferred connection.
        session.detach()
        client = session.attach()
        client.drain(0.2)
        client.send("reattached")
        reattached = peer.receive_matching(EVENT)
        while reattached.get("event") != "surface.key":
            reattached = peer.receive_matching(EVENT)
        self.assertEqual(reattached["surface"], surface)
        self.assertEqual(reattached["text"], "reattached")

        target = self.server.create_session(
            "switch-target", attach=False, command=("/bin/cat",)
        )
        client.prefix(":")
        client.send("switch switch-target\r")
        self.server.wait_for_state(
            target.name, lambda value: value.attached, "switch to target"
        )
        client.send("target-input\n")
        client.expect_output("target-input")
        client.prefix(":")
        client.send(f"switch {session.name}\r")
        self.server.wait_for_state(
            session.name, lambda value: value.attached, "switch back"
        )
        client.drain(0.2)
        client.send("returned")
        returned = peer.receive_matching(EVENT)
        while returned.get("event") != "surface.key":
            returned = peer.receive_matching(EVENT)
        self.assertEqual(returned["surface"], surface)
        self.assertEqual(returned["text"], "returned")
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
