from __future__ import annotations

import os
import sys
import unittest

from tests.support.pty_process import AnsiScreenTracker, PtyProcess

LEMMA_OUTER_TERMINAL_RESTORE = (
    b"\x1b[0m\x1b[?2026l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l"
    b"\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l"
    b"\x1b[?2004l\x1b]112\x1b\\\x1b[0 q\x1b[?25h\x1b[?7h\x1b[<u\x1b[?1049l"
)


class AnsiScreenTrackerTest(unittest.TestCase):
    def test_finds_marker_across_fragmented_incremental_cell_updates(self) -> None:
        tracker = AnsiScreenTracker(80, 24)
        for fragment in (
            b"\x1b[23;1H__LEMMA_DONE",
            b"\x1b]0;ignored\x1b\\",
            b"\x1b[23;13H__",
        ):
            tracker.feed(fragment)

        self.assertTrue(tracker.contains(b"__LEMMA_DONE__"))
        self.assertFalse(tracker.contains(b"ignored"))

    def test_reports_a_sparse_marker_overwritten_later_in_the_same_feed(self) -> None:
        tracker = AnsiScreenTracker(80, 24)
        tracker.feed(b"\x1b[23;1HS0030X")

        observed = tracker.feed_observing(b"\x1b[23;5H2\x1b[23;1H      ", b"S0032X")

        self.assertTrue(observed)
        self.assertFalse(tracker.contains(b"S0032X"))


class PtyProcessBufferingTest(unittest.TestCase):
    def test_wait_for_exit_drains_child_output(self) -> None:
        script = (
            "import os\n"
            "data = b'x' * (256 * 1024)\n"
            "while data:\n"
            "    data = data[os.write(1, data):]\n"
        )
        process = PtyProcess([sys.executable, "-c", script], dict(os.environ))
        try:
            process.wait_for_exit(5.0)
            self.assertEqual(process.pid, -1)
            self.assertTrue(process.terminal_state_restored)
        finally:
            process.close()

    def test_requires_configured_terminal_mode_cleanup(self) -> None:
        process = PtyProcess(
            [sys.executable, "-c", "pass"],
            dict(os.environ),
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        try:
            process.wait_for_exit(5.0)
            self.assertFalse(process.terminal_modes_restored)
            self.assertFalse(process.terminal_state_restored)
        finally:
            process.close()

    def test_retains_configured_terminal_mode_cleanup(self) -> None:
        script = f"import os; os.write(1, {LEMMA_OUTER_TERMINAL_RESTORE!r})"
        process = PtyProcess(
            [sys.executable, "-c", script],
            dict(os.environ),
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        try:
            process.wait_for_exit(5.0)
            self.assertTrue(process.terminal_modes_restored)
            self.assertTrue(process.terminal_state_restored)
            self.assertIn(LEMMA_OUTER_TERMINAL_RESTORE, process.final_output)
        finally:
            process.close()

    def test_handshake_preserves_bytes_from_the_same_read(self) -> None:
        read_descriptor, write_descriptor = os.pipe()
        process = object.__new__(PtyProcess)
        process.descriptor = read_descriptor
        process.pending_read = b""
        process.output_tail = b""
        process.screen = AnsiScreenTracker(80, 24)
        handshake = b"\x1b[?1049h"
        marker = b"__VISIBLE__"
        suffix = marker + b"tail"
        try:
            os.write(write_descriptor, b"prefix" + handshake + suffix)
            _, handshake_bytes = process.read_until(
                handshake, 1.0, preserve_suffix=True
            )
            self.assertEqual(handshake_bytes, len(b"prefix" + handshake))
            self.assertEqual(process.pending_read, suffix)

            _, visible_bytes = process.read_until(marker, 1.0)
            self.assertEqual(visible_bytes, len(suffix))
            self.assertEqual(process.pending_read, b"")
        finally:
            os.close(read_descriptor)
            os.close(write_descriptor)


if __name__ == "__main__":
    unittest.main()
