from __future__ import annotations

import unittest

from tests.support.mux_harness import LemmaServer


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


if __name__ == "__main__":
    unittest.main()
