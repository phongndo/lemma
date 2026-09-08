"""Exercise the real native probe against bounded command/reply streams."""

import json
import socket
import subprocess
import sys
import unittest
from pathlib import Path


class CommandProbeTest(unittest.TestCase):
    probe: Path
    peer: Path

    def run_probe(self, last_reply: bytes) -> subprocess.CompletedProcess[str]:
        outer, fixture = socket.socketpair()
        with outer, fixture:
            outer.setblocking(False)
            fixture.settimeout(5)
            with subprocess.Popen(
                [str(self.probe), "command", str(outer.fileno()), "2", "\n", "DONE"],
                pass_fds=(outer.fileno(),),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ) as process:
                try:
                    self.assertEqual(fixture.recv(1), b"\n")
                    fixture.sendall(b"DONE0|")
                    self.assertEqual(fixture.recv(1), b"\n")
                    # EOF makes rejection deterministic; no timing threshold or sleep is needed.
                    fixture.sendall(last_reply)
                    fixture.shutdown(socket.SHUT_WR)
                    stdout, stderr = process.communicate(timeout=5)
                    return subprocess.CompletedProcess(
                        process.args, process.returncode, stdout, stderr
                    )
                finally:
                    if process.poll() is None:
                        process.kill()

    def test_stale_completion_cannot_finish_the_next_command(self) -> None:
        result = self.run_probe(b"DONE0|")
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_longer_sequence_is_not_a_prefix_match(self) -> None:
        result = self.run_probe(b"DONE10|")
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_current_completion_can_follow_a_stale_redraw(self) -> None:
        result = self.run_probe(b"DONE0|DONE\x1b[2;1H1|")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["latency"]["samples_ns"]), 2)

    def test_fixture_numbers_each_completed_burst(self) -> None:
        result = subprocess.run(
            [str(self.peer), "warm-scroll-loop"],
            input=b"\n\n",
            capture_output=True,
            timeout=10,
            check=True,
        )
        marker = b"__LEMMA_WARM_SCROLL_DONE__"
        self.assertEqual(result.stdout.count(marker), 2)
        self.assertTrue(marker + b"0|\r\n" in result.stdout, "missing completion 0")
        self.assertTrue(result.stdout.endswith(marker + b"1|\r\n"))


if __name__ == "__main__":
    CommandProbeTest.probe = Path(sys.argv[1]).resolve()
    CommandProbeTest.peer = Path(sys.argv[2]).resolve()
    unittest.main(argv=[sys.argv[0]])
