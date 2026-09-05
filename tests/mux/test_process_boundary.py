from __future__ import annotations

import errno
import os
import shlex
import socket
import unittest
from pathlib import Path

from tests.support.mux_harness import LemmaServer, Session, process_exists, wait_until


def release_fifo(path: Path) -> None:
    def release() -> bool | None:
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        except OSError as error:
            if error.errno == errno.ENXIO:
                return None
            raise
        try:
            os.write(descriptor, b"go\n")
        finally:
            os.close(descriptor)
        return True

    wait_until(f"fixture reader for {path.name}", release)


class ProcessBoundaryMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment()
        self.addCleanup(self.server.close)

    def test_final_pty_output_precedes_structured_process_exit(self) -> None:
        release = self.server.root / "final-output.fifo"
        os.mkfifo(release)
        script = (
            f"IFS= read -r _ < {shlex.quote(str(release))}; "
            "printf '__FINAL_BEFORE_EXIT__\\n'; exit 7"
        )
        session = self.server.create_session(
            "final_output",
            hold=True,
            command=("/bin/sh", "-c", script),
        )
        pane = session.pane()
        child = pane.process
        self.assertGreater(child, 0)

        release_fifo(release)
        session.require_client().expect_output("__FINAL_BEFORE_EXIT__")
        exited = self.server.wait_for_state(
            session.name,
            lambda state: state.pane(pane.id).process_state == "exited",
            "held pane to publish its process exit",
        )
        self.assertEqual(exited.pane(pane.id).pid, 0)
        self.assertFalse(process_exists(child))

    def test_create_context_funds_a_long_working_directory_only_for_setup(self) -> None:
        working_directory = (
            self.server.root
            / ("directory-a-" + ("x" * 48))
            / ("directory-b-" + ("y" * 48))
        )
        working_directory.mkdir(parents=True)
        name = b"long_working_directory"
        encoded_directory = os.fsencode(working_directory)
        request = b"".join(
            (
                b"C",
                bytes((len(name),)),
                name,
                b"\0",
                len(encoded_directory).to_bytes(2, "big"),
                encoded_directory,
                b"\0\0",
                b"\0\0",
            )
        )
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as control:
            control.settimeout(2.0)
            control.connect(str(self.server.socket_path))
            control.sendall(request)
            self.assertEqual(control.recv(1), b"Y", self.server.diagnostics())

        session = Session(self.server, name.decode())
        client = session.attach()
        client.send(
            f'test "$PWD" = {shlex.quote(str(working_directory))} '
            "&& printf '__LONG_CWD_OK__\\n'\r"
        )
        client.expect_output("__LONG_CWD_OK__")

    def test_resize_delivers_sigwinch_to_the_real_child(self) -> None:
        session = self.server.create_session(
            "sigwinch",
            command=(str(self.server.peer_path), "winch"),
        )
        pane = session.pane()
        client = session.require_client()
        client.expect_output("__LEMMA_WINCH_READY__")

        client.resize(100, 30)
        client.expect_output("__LEMMA_WINCH_29_100__")
        resized = session.state()
        self.assertEqual(resized.focused_pane, pane.id)
        self.assertEqual((resized.columns, resized.rows), (100, 30))
        client.send("q")


if __name__ == "__main__":
    unittest.main()
