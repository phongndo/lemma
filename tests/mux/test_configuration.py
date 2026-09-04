from __future__ import annotations

import os
import signal
import unittest
from pathlib import Path

from tests.support.mux_harness import LemmaServer, process_exists, wait_until


class ConfigurationMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment(
            config_text="""
local lemma = require("lemma")
lemma.setup({
  input = { preset = "none", prefix = false },
  terminal = { scrollback_lines = 1234 },
  ui = { status_line = false },
  launch = {
    default_cwd = "/tmp",
    default_program = {
      "/bin/sh", "-c", [=[printf 'CONFIGURED_PROGRAM:%s\\n' "$PWD"; exec /bin/sh]=]
    },
  },
})
lemma.context.set("copy", { label = " COPY ", unbound = "consume" })
lemma.keymap.set("normal", "M-c", "enter_copy_mode")
lemma.keymap.set("copy", "x", "copy_leave")
lemma.keymap.set("normal", "M-s", "split_left_right")
lemma.keymap.set("normal", "M-f", "enter_copy_search_forward")
lemma.keymap.del("normal", "C-b")
"""
        )
        self.addCleanup(self.server.close)

    def test_compiled_lua_keymap_is_active_for_new_sessions(self) -> None:
        session = self.server.create_session("configured_input")
        client = session.require_client()
        self.assertEqual(session.state().panes, 1)
        client.expect_output("CONFIGURED_PROGRAM:/tmp")
        self.assertNotIn("configured_input", client.screen_text())

        # This copy mode and its leave key both come from the blank user policy.
        client.send(b"\x1bcx")
        client.send(b"\x1bs")

        state = self.server.wait_for_state(
            session.name,
            lambda current: current.panes == 2,
            "configured split key to create a second pane",
        )
        self.assertEqual(state.panes, 2)

    def test_compiled_policy_survives_extension_host_crash(self) -> None:
        session = self.server.create_session("configured_host_crash")
        client = session.require_client()
        client.expect_output("CONFIGURED_PROGRAM:/tmp")
        children_path = Path(
            f"/proc/{self.server.process.pid}/task/{self.server.process.pid}/children"
        )
        if not children_path.exists():
            self.skipTest("extension-host process isolation probe requires Linux /proc")
        children = [int(value) for value in children_path.read_text().split()]
        hosts = []
        for child in children:
            command_path = Path(f"/proc/{child}/cmdline")
            if not command_path.exists():
                continue
            command = command_path.read_bytes().split(b"\0", maxsplit=1)[0]
            if command == os.fsencode(self.server.server_path):
                hosts.append(child)
        self.assertEqual(len(hosts), 1, self.server.diagnostics())
        os.kill(hosts[0], signal.SIGKILL)
        wait_until(
            "extension host crash cleanup",
            lambda: not process_exists(hosts[0]) or None,
            diagnostics=self.server.diagnostics,
        )

        client.send(b"\x1bs")
        self.server.wait_for_state(
            session.name,
            lambda current: current.panes == 2,
            "compiled policy after extension host crash",
        )
        client.send("printf '__HOST_CRASH_ISOLATED__\\n'\r")
        session.pane().expect_output("__HOST_CRASH_ISOLATED__")

    def test_copy_search_does_not_capture_input_without_a_status_line(self) -> None:
        session = self.server.create_session("configured_hidden_search")
        client = session.require_client()
        pane = session.pane()
        client.expect_output("CONFIGURED_PROGRAM:/tmp")

        client.send(b"\x1bfprintf '__VISIBLE_AFTER_SEARCH__\\n'\r")

        pane.expect_output("__VISIBLE_AFTER_SEARCH__")
        pane.expect_alive()


if __name__ == "__main__":
    unittest.main()
