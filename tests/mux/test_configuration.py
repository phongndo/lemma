from __future__ import annotations

import json
import unittest
from pathlib import Path

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

    def test_copy_search_does_not_capture_input_without_a_status_line(self) -> None:
        session = self.server.create_session("configured_hidden_search")
        client = session.require_client()
        pane = session.pane()
        client.expect_output("CONFIGURED_PROGRAM:/tmp")

        client.send(b"\x1bfprintf '__VISIBLE_AFTER_SEARCH__\\n'\r")

        pane.expect_output("__VISIBLE_AFTER_SEARCH__")
        pane.expect_alive()


class DocumentedConfigurationMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.examples = Path(__file__).resolve().parents[2] / "examples"
        self.server = LemmaServer.from_environment(
            config_text=(self.examples / "configuration.lua").read_text()
            + "\n"
            + (self.examples / "command.lua").read_text()
        )
        self.addCleanup(self.server.close)

    def test_all_lua_examples_pass_native_configuration_validation(self) -> None:
        examples = sorted(self.examples.glob("*.lua"))
        self.assertTrue(examples)
        for example in examples:
            with self.subTest(example=example.name):
                result = self.server.command("config", "check", str(example))
                self.assertEqual(result.status, 0, result.output)

    def test_documented_keymap_splits_a_real_pane(self) -> None:
        session = self.server.create_session("example-config")
        session.require_client().send(b"\x1bd")
        self.server.wait_for_state(
            session.name,
            lambda state: state.panes == 2,
            "documented Meta-d binding to split a pane",
        )

    def test_documented_command_opens_a_named_shell_tab(self) -> None:
        session = self.server.create_session("example-command")
        client = session.require_client()
        client.prefix(":")
        client.send("work.sh\t")
        client.expect_output("work.shell")
        client.send("'example shell'\r")
        self.server.wait_for_state(
            session.name,
            lambda state: state.tabs == 2,
            "documented command to open a shell tab",
        )
        result = self.server.require_command(
            "proc", "tab", "list", "--session", session.name
        )
        tabs = json.loads(result.output)["results"][0]["result"]["tabs"]
        self.assertIn("example shell", [tab["title"] for tab in tabs])


if __name__ == "__main__":
    unittest.main()
