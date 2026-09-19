"""Exercise the real native probe and PTY fixture through their process interfaces."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.support.pty_process import PtyOutputMonitor, PtyProcess  # noqa: E402


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


class BlockedPeerTest(unittest.TestCase):
    peer: Path

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.gate = Path(temporary.name) / "gate"

    def start_peer(self, size: int, idle_timeout_ms: int) -> PtyProcess:
        process = PtyProcess(
            [str(self.peer), "block", str(self.gate), str(size), str(idle_timeout_ms)],
            dict(os.environ),
        )
        self.addCleanup(process.close)
        process.read_until(b"__LEMMA_PTY_READY__", 2.0)
        self.gate.touch()
        return process

    def test_progress_can_outlive_the_receive_idle_guard(self) -> None:
        payload = b"q" * 16
        digest = 14_695_981_039_346_656_037
        for byte in payload:
            digest = ((digest ^ byte) * 1_099_511_628_211) & ((1 << 64) - 1)
        marker = f"__LEMMA_PTY_DONE__ bytes={len(payload)} digest={digest:x}".encode()
        process = self.start_peer(len(payload), 1_000)
        with PtyOutputMonitor(
            process, marker, failure_markers=(b"__LEMMA_PTY_FAILED__",)
        ) as completion:
            for index, byte in enumerate(payload):
                completion.check()
                process.write_all(bytes([byte]), 1.0)
                if index + 1 < len(payload):
                    # Deliberately span more than one idle window, while each
                    # delivery is well within it. This is fixture liveness, not
                    # a measured latency or throughput threshold.
                    time.sleep(0.1)
            completion.wait(2.0)

    def test_stalled_partial_payload_still_reports_its_received_count(self) -> None:
        process = self.start_peer(8, 300)
        process.write_all(b"qqq", 1.0)
        process.read_until(b"__LEMMA_PTY_FAILED__ received=3", 2.0)

    def test_override_cannot_disable_or_raise_the_idle_guard(self) -> None:
        for timeout in ("0", "30001", "invalid"):
            with self.subTest(timeout=timeout):
                result = subprocess.run(
                    [str(self.peer), "block", str(self.gate), "1", timeout],
                    capture_output=True,
                    timeout=2,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    CommandProbeTest.probe = Path(sys.argv[1]).resolve()
    CommandProbeTest.peer = BlockedPeerTest.peer = Path(sys.argv[2]).resolve()
    unittest.main(argv=[sys.argv[0]])
