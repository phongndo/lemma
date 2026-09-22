from __future__ import annotations

import json
import os
import signal
import sys
import unittest

from tests.mux.test_extension_runtime import (
    EVENT,
    HELLO,
    PROC,
    PROC_RESULT,
    ExtensionPeer,
)
from tests.support.mux_harness import LemmaServer, wait_for_process_exit, wait_until


class UserExtensionsMuxTest(unittest.TestCase):
    def server(self, config: str | None = None) -> LemmaServer:
        server = LemmaServer.from_environment(config_text=config)
        self.addCleanup(server.close)
        return server

    def test_invalid_configuration_falls_back_to_the_shipped_user_layer(self) -> None:
        server = self.server('require("lemma").extension.set("invalid", {})')
        session = server.create_session("fallback", command=("cat",))
        client = session.require_client()
        client.expect_output("fallback  |")
        self.assertIn("configuration rejected", server.logs())
        client.prefix("s")
        client.expect_output("Sessions")
        client.send("q")
        client.expect_output("fallback  |")

    def test_status_is_replaceable_and_pane_uses_the_released_row(self) -> None:
        server = self.server('require("lemma").extension.set("statusline", false)')
        session = server.create_session("bare", command=("cat",))
        session.require_client().send("__NATIVE_INPUT__\r")
        session.require_client().expect_output("__NATIVE_INPUT__")
        state = json.loads(session.state().raw)
        self.assertEqual(state["panes"][0]["row"], 0)
        self.assertEqual(state["panes"][0]["rows"], 24)
        self.assertNotIn("bare  |", session.require_client().screen_text())

    def test_status_mouse_selects_creates_and_reorders_tabs(self) -> None:
        server = self.server()
        session = server.create_session("mouse", command=("cat",))
        client = session.require_client()
        first = session.state().active_tab
        server.require_command(
            "proc", "tab", "rename", "--session", "mouse", "--tab", first, "alpha"
        )
        client.expect_output("alpha")

        def column(label: str) -> int:
            client.drain()
            return client.screen_text().splitlines()[0].index(label) + 1

        plus = column("+")
        client.send(f"\x1b[<0;{plus};1M\x1b[<0;{plus};1m")
        second = server.wait_for_state(
            "mouse", lambda state: state.tabs == 2, "status plus creates tab"
        ).active_tab
        self.assertNotEqual(first, second)
        server.require_command(
            "proc", "tab", "rename", "--session", "mouse", "--tab", second, "beta"
        )
        client.expect_output("beta")
        alpha = column("alpha")
        client.send(f"\x1b[<0;{alpha};1M\x1b[<0;{alpha};1m")
        server.wait_for_state(
            "mouse", lambda state: state.active_tab == first, "status selects tab"
        )
        beta = column("beta")
        client.send(f"\x1b[<0;{alpha};1M\x1b[<32;{beta};1M\x1b[<0;{beta};1m")

        def order() -> bool | None:
            response = server.require_command(
                "proc", "tab", "list", "--session", "mouse"
            )
            tabs = json.loads(response.output)["results"][0]["result"]["tabs"]
            return True if [tab["id"] for tab in tabs] == [second, first] else None

        wait_until("status drag commits tab order", order)
        client.send("__AFTER_DRAG__\r")
        client.expect_output("__AFTER_DRAG__")

    def test_status_recovers_after_tiny_resize_and_reattach(self) -> None:
        server = self.server()
        session = server.create_session("geometry", command=("cat",))
        client = session.require_client()
        client.expect_output("geometry  |")
        client.resize(10, 1)
        tiny = server.wait_for_state(
            "geometry", lambda state: state.rows == 1, "single row terminal"
        )
        self.assertEqual(json.loads(tiny.raw)["panes"][0]["rows"], 1)
        client.resize(100, 30)
        server.wait_for_state(
            "geometry", lambda state: state.rows == 30, "restored terminal"
        )
        client.expect_output("geometry  |")
        self.assertEqual(json.loads(session.state().raw)["panes"][0]["rows"], 29)
        session.detach()
        reattached = session.attach(columns=60, rows=12)
        reattached.expect_output("geometry  |")
        self.assertEqual(json.loads(session.state().raw)["panes"][0]["rows"], 11)
        reattached.send("__REATTACHED__\r")
        reattached.expect_output("__REATTACHED__")

    def test_global_discovery_and_presentation_do_not_require_screen_observation(
        self,
    ) -> None:
        server = self.server()
        global_peer = ExtensionPeer(str(server.socket_path))
        self.addCleanup(global_peer.close)
        global_peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "global-observer",
                "capabilities": ["observe"],
                "events": {"schema": "lemma.events/v1"},
            },
        )
        welcome = global_peer.receive_matching(2, 1)
        self.assertNotIn("attachment", welcome)
        self.assertEqual(global_peer.receive_matching(EVENT)["sessions"], [])
        session = server.create_session("observed", command=("cat",))
        self.assertEqual(
            global_peer.receive_matching(EVENT)["sessions"][0]["name"], "observed"
        )
        peer = ExtensionPeer(str(server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "presentation-observer",
                "capabilities": ["observe", "proc"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": session.state().id},
                    "presentation": True,
                },
            },
        )
        peer.receive_matching(2, 1)
        initial = peer.receive_matching(EVENT)
        self.assertEqual(initial["presentation"]["name"], "observed")
        self.assertNotIn("capture", initial)
        client = session.require_client()
        client.expect_output("observed  |")
        client.prefix(":")
        client.send("tab list")
        for _ in range(32):
            event = peer.receive_matching(EVENT)
            self.assertNotIn("capture", event)
            prompt = event.get("presentation", {}).get("prompt", {})
            if prompt.get("value") == "tab list":
                self.assertEqual(prompt["kind"], "command")
                break
        else:
            self.fail("editor state was not observed")
        client.send(b"\x03__AFTER_EDITOR__\r")
        client.expect_output("__AFTER_EDITOR__")

    def test_session_manager_switches_creates_and_respects_busy_attachments(
        self,
    ) -> None:
        server = self.server()
        first = server.create_session("first", command=("cat",))
        target = server.create_session("second", attach=False, command=("cat",))
        client = first.require_client()
        client.prefix("s")
        client.expect_output("Sessions")
        client.send("j\r")
        server.wait_for_state(
            target.name, lambda state: state.attached, "session manager switch"
        )
        client.expect_output("second  |")
        client.prefix("s")
        client.expect_output("Sessions")
        client.send("n")
        client.expect_output("New session:")
        client.send("third\r")
        server.wait_for_state(
            "third", lambda state: state.attached, "session manager creation"
        )
        client.expect_output("third  |")
        busy = server.create_session("busy", command=("cat",))
        client.prefix("s")
        client.expect_output("Sessions")
        # Current session is retained as the selection; the next entry is busy.
        client.send("j\r")
        client.expect_output("Cannot switch:")
        self.assertTrue(busy.state().attached)
        third = server.session_state("third")
        assert third is not None
        self.assertTrue(third.attached)
        client.send("q")
        client.expect_output("third  |")

    def test_status_survives_command_host_failure_and_has_bounded_restart(self) -> None:
        code = (
            "import os,sys; "
            "f=open(os.path.join(os.environ['HOME'],'status-pids'),'a'); "
            "f.write(str(os.getpid())+'\\n'); f.close(); "
            "os.execv(sys.argv[1],[sys.argv[1],'status'])"
        )
        config = f"""
local lemma = require('lemma')
lemma.extension.set('statusline', {{{json.dumps(sys.executable)}, '-c', {json.dumps(code)}, lemma.bundled_ui}})
lemma.command.register('test.crash', {{description='crash', handler=function() os.exit(0) end}})
"""
        server = self.server(config)
        session = server.create_session("recovery", command=("cat",))
        client = session.require_client()
        client.expect_output("recovery  |")
        client.prefix(":")
        client.send("test.crash\r")
        client.expect_output("Error:")
        client.prefix("r")
        client.send(b"\x15alive\r")
        client.expect_output("alive")
        path = server.root / "home" / "status-pids"

        def pids() -> list[int]:
            return [int(value) for value in path.read_text().splitlines()]

        for count in range(1, 5):
            wait_until(
                "managed status launch", lambda: True if len(pids()) == count else None
            )
            process = pids()[-1]
            os.kill(process, signal.SIGKILL)
            wait_for_process_exit(process)
            if count < 4:
                wait_until(
                    "managed status restart",
                    lambda: True if len(pids()) == count + 1 else None,
                )
                client.expect_output("recovery  |")
        wait_until(
            "dock removed after restart budget",
            lambda: (
                True
                if json.loads(session.state().raw)["panes"][0]["rows"] == 24
                else None
            ),
        )
        client.send("__AFTER_CRASH_LOOP__\r")
        client.expect_output("__AFTER_CRASH_LOOP__")
        self.assertEqual(len(pids()), 4)

    def test_disabling_surface_focus_returns_input_to_pane(self) -> None:
        server = self.server()
        session = server.create_session("focus", command=("cat",))
        peer = ExtensionPeer(str(server.socket_path))
        self.addCleanup(peer.close)
        peer.send(
            HELLO,
            1,
            {
                "schema": "lemma.extension/v1",
                "name": "focusable",
                "capabilities": ["proc", "surface"],
                "events": {
                    "schema": "lemma.events/v1",
                    "session": {"id": session.state().id},
                },
            },
        )
        peer.receive_matching(2, 1)
        placement = {"kind": "float", "column": 0, "row": 2, "columns": 10, "rows": 1}
        peer.send(
            PROC,
            2,
            {
                "schema": "lemma.proc/v1",
                "commands": [{"command": "surface.create", "placement": placement}],
            },
        )
        surface = peer.receive_matching(PROC_RESULT, 2)["results"][0]["result"][
            "surface"
        ]
        peer.send(
            PROC,
            3,
            {
                "schema": "lemma.proc/v1",
                "commands": [
                    {"command": "surface.focus", "surface": {"id": surface}},
                    {
                        "command": "surface.configure",
                        "surface": {"id": surface},
                        "placement": placement,
                        "focusable": False,
                    },
                ],
            },
        )
        self.assertTrue(peer.receive_matching(PROC_RESULT, 3)["ok"])
        session.require_client().send("__PANE_FOCUS__\r")
        session.require_client().expect_output("__PANE_FOCUS__")


if __name__ == "__main__":
    unittest.main()
