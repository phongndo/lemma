from __future__ import annotations

import signal
import unittest
from unittest import mock

from tests.support.mux_harness import LemmaServer


class ServerCleanupTest(unittest.TestCase):
    def test_group_permission_error_after_daemon_exit_is_reaped(self) -> None:
        server = object.__new__(LemmaServer)
        server.clients = []
        server.process = mock.Mock(pid=123, poll=mock.Mock(side_effect=[None, 0]))
        with mock.patch(
            "tests.support.mux_harness.os.killpg", side_effect=PermissionError
        ) as killpg:
            server.close()
        killpg.assert_called_once_with(123, signal.SIGTERM)
        server.process.wait.assert_called_once_with(timeout=2.0)

    def test_group_permission_error_for_live_daemon_is_not_hidden(self) -> None:
        server = object.__new__(LemmaServer)
        server.clients = []
        server.process = mock.Mock(pid=123, poll=mock.Mock(return_value=None))
        with (
            mock.patch(
                "tests.support.mux_harness.os.killpg", side_effect=PermissionError
            ),
            self.assertRaises(PermissionError),
        ):
            server.close()
        server.process.wait.assert_not_called()


if __name__ == "__main__":
    unittest.main()
