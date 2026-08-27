from __future__ import annotations

import unittest

from tests.support.mux_harness import LemmaServer


class ResizeMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def test_nested_resize_reaches_each_real_child_pty(self) -> None:
        session = self.server.create_session("nested_resize")
        left = session.pane()
        top_right = left.split_right()
        bottom_right = top_right.split_down()
        client = session.require_client()

        client.resize(100, 30)
        self.server.wait_for_state(
            session.name,
            lambda state: state.columns == 100 and state.rows == 30,
            "settled 100x30 outer resize",
        )

        left.send("m='__LEFT_'; printf \"${m}GEOMETRY__ \"; stty size\r")
        left.expect_output("__LEFT_GEOMETRY__ 29 50")
        top_right.send("m='__TOP_'; printf \"${m}GEOMETRY__ \"; stty size\r")
        top_right.expect_output("__TOP_GEOMETRY__ 14 49")
        bottom_right.send("m='__BOTTOM_'; printf \"${m}GEOMETRY__ \"; stty size\r")
        bottom_right.expect_output("__BOTTOM_GEOMETRY__ 14 49")

        left.expect_alive()
        top_right.expect_alive()
        bottom_right.expect_alive()

    def test_split_delivers_in_band_size_without_another_keystroke(self) -> None:
        # After this Ghostty pin, resize itself emits CSI 48. That reply must reach the child PTY
        # from the split transaction, not from a later keystroke or PTY read. Pixel fields follow
        # the pane terminal's current cell metrics; the attach protocol does not transport host
        # cell size, so this test asserts only the cell geometry of an 80x24 client minus status.
        session = self.server.create_session("in_band_split")
        pane = session.pane()
        pane.send(
            "stty -echo -icanon min 1 time 0; "
            "esc=$(printf '\\033'); "
            "printf '%s[?2048h' \"$esc\"; "
            "buf=; "
            "while :; do "
            "c=$(dd bs=1 count=1 2>/dev/null) || exit 1; "
            'buf="${buf}${c}"; '
            'case $buf in *"${esc}[48;"*t) break ;; esac; '
            "done; "
            "armed='__2048_''ARMED__'; "
            "printf '%s\\n' \"$armed\"; "
            "buf=; "
            "while :; do "
            "c=$(dd bs=1 count=1 2>/dev/null) || exit 1; "
            'buf="${buf}${c}"; '
            'case $buf in *"${esc}[48;"*t) '
            'report=${buf#*"${esc}[48;"}; '
            "report=${report%%t*}; "
            "rows=${report%%;*}; "
            "rest=${report#*;}; "
            "cols=${rest%%;*}; "
            'printf \'__2048_SPLIT_%s_%s__\\n\' "$rows" "$cols"; '
            "break ;; esac; "
            "done\r"
        )
        pane.expect_output("__2048_ARMED__")

        pane.split_down()
        pane.expect_output("__2048_SPLIT_11_80__")
        pane.expect_alive()


if __name__ == "__main__":
    unittest.main()
