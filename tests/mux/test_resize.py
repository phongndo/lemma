from __future__ import annotations

import json
import os
import signal
import sys
import unittest

from tests.support.mux_harness import LemmaServer, wait_until


class ResizeMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def test_in_band_geometry_overrides_stale_proxy_size_without_typing_reports(
        self,
    ) -> None:
        report = self.server.root / "geometry.json"
        captured = self.server.root / "input.bin"
        script = f"""
import fcntl, json, os, signal, struct, termios, tty
from pathlib import Path
report = Path({str(report)!r})
captured = Path({str(captured)!r})
def resized(*_):
    size = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\\0' * 8))
    temporary = report.with_suffix('.tmp')
    temporary.write_text(json.dumps(size))
    temporary.replace(report)
signal.signal(signal.SIGWINCH, resized)
tty.setraw(0)
resized()
os.write(1, b'GEOMETRY_READY')
data = b''
while True:
    data += os.read(0, 4096)
    captured.write_bytes(data)
"""
        session = self.server.create_session(
            "in_band_geometry", command=(sys.executable, "-c", script)
        )
        client = session.require_client()
        client.expect_output("GEOMETRY_READY")
        self.assertEqual(json.loads(report.read_text()), [23, 80, 640, 368])
        # A PTY proxy still reports 80x24, but Ghostty sends its real grid and pixels in band.
        # Mouse input shares this read and must be classified against the new geometry.
        client.send(b"\x1b[48;50;160;1700;2560t\x1b[<0;114;35M\x1b[<0;114;35mZ")
        self.server.wait_for_state(
            session.name,
            lambda state: (state.columns, state.rows) == (160, 50),
            "in-band size supersedes stale PTY geometry",
        )
        wait_until(
            "only keyboard input reaches Pane",
            lambda: (
                True if captured.exists() and captured.read_bytes() == b"Z" else None
            ),
            diagnostics=client.diagnostics,
        )
        self.assertEqual(json.loads(report.read_text()), [49, 160, 2560, 1666])
        # A later SIGWINCH must not replace known native metrics with the stale proxy ioctl.
        os.killpg(client.pid, signal.SIGWINCH)
        client.send(b"Q")
        wait_until(
            "input after stale SIGWINCH",
            lambda: True if captured.read_bytes() == b"ZQ" else None,
            diagnostics=client.diagnostics,
        )
        state = session.state()
        self.assertEqual((state.columns, state.rows), (160, 50))
        self.assertEqual(json.loads(report.read_text()), [49, 160, 2560, 1666])

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
        # from the split transaction, not from a later keystroke or PTY read. This test asserts the
        # cell geometry of an 80x24 client minus status; terminal-boundary tests cover pixel metrics.
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
