from __future__ import annotations

import unittest

from tests.support.mux_harness import LemmaServer, process_exists


class PaneLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def test_closing_one_split_kills_only_its_child(self) -> None:
        session = self.server.create_session("pane_close")
        left = session.pane()
        right = left.split_right()

        self.assertNotEqual(left.process, right.process)
        left.expect_alive()
        right.expect_alive()
        right.send("printf '__RIGHT_BEFORE_CLOSE__\\n'\r")
        right.expect_output("__RIGHT_BEFORE_CLOSE__")

        left.close()

        self.assertFalse(process_exists(left.process))
        right.expect_alive()
        right.send("printf '__RIGHT_AFTER_CLOSE__\\n'\r")
        right.expect_output("__RIGHT_AFTER_CLOSE__")

    def test_swap_changes_layout_position_not_child_ownership(self) -> None:
        session = self.server.create_session("pane_swap")
        left = session.pane()
        right = left.split_right()
        right.focus()
        focused_before = session.state().focused_pid

        session.require_client().prefix("H")
        focused_after = self.server.wait_for_state(
            session.name,
            lambda state: state.focused_pid == focused_before,
            "focused child identity to survive pane swap",
        )
        self.assertEqual(focused_after.focused_pid, right.process)

        left.send("printf '__LEFT_AFTER_SWAP__\\n'\r")
        left.expect_output("__LEFT_AFTER_SWAP__")
        right.send("printf '__RIGHT_AFTER_SWAP__\\n'\r")
        right.expect_output("__RIGHT_AFTER_SWAP__")
        left.expect_alive()
        right.expect_alive()


if __name__ == "__main__":
    unittest.main()
