from __future__ import annotations

import shlex
import unittest

from tests.support.mux_harness import LemmaServer, wait_until


class TerminalBoundaryMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def test_application_cursor_mode_changes_bytes_delivered_to_child(self) -> None:
        session = self.server.create_session("application_cursor")
        pane = session.pane()
        pane.send(
            "stty -echo -icanon min 1 time 0; r='__APP_CURSOR_'; "
            "printf '\\033[?1h%s\\n' \"${r}READY__\"; "
            "code=$(dd bs=1 count=3 2>/dev/null | od -An -tx1 | tr -d ' \\n'); "
            "printf '\\033[?1l'; stty sane; "
            'printf \'%s%s__\\n\' "$r" "$code"\r'
        )
        pane.expect_output("__APP_CURSOR_READY__")

        # One typed outer Up press. Lemma must query Ghostty's canonical DECCKM state and encode SS3.
        session.require_client().send(b"\x1b[1;1:1A")

        pane.expect_output("__APP_CURSOR_1b4f41__")

    def test_default_copy_mode_keys_use_the_compiled_policy(self) -> None:
        session = self.server.create_session("compiled_copy_policy")
        client = session.require_client()
        pane = session.pane()
        pane.send("printf '__COPY_POLICY_LINE__\\n'\r")
        pane.expect_output("__COPY_POLICY_LINE__")

        def copy_mode_visible(expected: bool) -> bool | None:
            client.drain()
            return True if ("COPY\n" in client.screen_text()) == expected else None

        client.prefix("[")
        wait_until(
            "compiled copy mode to become visible",
            lambda: copy_mode_visible(True),
        )
        client.send(b"h")
        client.send(b"\x07")
        wait_until(
            "compiled copy leave binding to restore normal input",
            lambda: copy_mode_visible(False),
        )
        pane.expect_alive()

    def test_default_rename_editing_uses_the_compiled_policy(self) -> None:
        session = self.server.create_session("compiled_rename_policy")
        client = session.require_client()

        client.prefix("$")
        client.send(b"\x15renamed-policy\r")
        client.expect_output("renamed-policy")
        session.pane().expect_alive()

    def test_styled_output_is_confined_to_its_composed_pane(self) -> None:
        session = self.server.create_session("styled_output")
        left = session.pane()
        left.send("printf '\\033[2J\\033[H__LEFT_NEIGHBOR__\\n'\r")
        left.expect_output("__LEFT_NEIGHBOR__")
        right = left.split_right()

        right.send("printf '\\033[1;31m__RIGHT_STYLED__\\033[0m\\n'\r")
        right.expect_output("__RIGHT_STYLED__")
        session.require_client().expect_output("__LEFT_NEIGHBOR__")
        session.require_client().expect_raw("38;5;1")
        left.expect_alive()
        right.expect_alive()

    def test_synchronized_output_holds_one_pane_while_sibling_progresses(self) -> None:
        session = self.server.create_session("synchronized_output")
        left = session.pane()
        right = left.split_right()
        start_gate = self.server.root / "synchronized-output-start.gate"
        started = self.server.root / "synchronized-output-started"
        release_gate = self.server.root / "synchronized-output-release.gate"
        left.send(
            "r='__SYNC_'; h='__HELD_'; x='__RELEASE_'; "
            'printf "${r}READY__\\n"; '
            f"while [ ! -e {shlex.quote(str(start_gate))} ]; do sleep 0.01; done; "
            f"printf '\\033[?2026h%s' \"${{h}}A__\"; : > {shlex.quote(str(started))}; "
            f"while [ ! -e {shlex.quote(str(release_gate))} ]; do sleep 0.01; done; "
            "printf '%s\\033[?2026l\\n' \"${x}A__\"\r"
        )
        left.expect_output("__SYNC_READY__")
        right.focus()

        start_gate.touch()
        wait_until(
            "pane A to enter synchronized output",
            lambda: True if started.exists() else None,
        )
        session.require_client().send("v='__LIVE_'; printf \"${v}B__\\n\"\r")
        session.require_client().expect_output("__LIVE_B__")
        self.assertNotIn("__HELD_A__", session.require_client().screen_text())

        release_gate.touch()
        session.require_client().expect_output("__HELD_A__")
        session.require_client().expect_output("__RELEASE_A__")
        left.expect_alive()
        right.expect_alive()


if __name__ == "__main__":
    unittest.main()
