"""Deterministic real-process harness for Lemma mux behavior."""

from __future__ import annotations

import os
import re
import select
import signal
import socket
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

from tests.support.pty_process import PtyProcess

ALT_SCREEN = b"\x1b[?1049h"
LEMMA_OUTER_TERMINAL_RESTORE = (
    b"\x1b[0m\x1b[?2026l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l"
    b"\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l"
    b"\x1b[?2004l\x1b]112\x1b\\\x1b[0 q\x1b[?25h\x1b[?7h\x1b[<u\x1b[?1049l"
)
_LISTING = re.compile(
    r'^lemma session "(?P<name>[^"]+)": (?P<tabs>\d+) tab\(s\), '
    r"(?P<panes>\d+) pane\(s\), focused pid (?P<pid>\d+), "
    r"(?P<attached>attached|detached), (?P<columns>\d+)x(?P<rows>\d+),",
)
T = TypeVar("T")


class MuxTimeout(TimeoutError):
    """A deadline expired with bounded process and topology diagnostics."""


@dataclass(frozen=True)
class CommandResult:
    status: int
    output: str
    arguments: tuple[str, ...]


@dataclass(frozen=True)
class SessionState:
    name: str
    tabs: int
    panes: int
    focused_pid: int
    columns: int
    rows: int
    attached: bool
    raw: str


def process_exists(process: int) -> bool:
    if process <= 0:
        return False
    try:
        os.kill(process, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_until(
    description: str,
    observe: Callable[[], T | None],
    *,
    timeout: float = 5.0,
    diagnostics: Callable[[], str] | None = None,
) -> T:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = observe()
        if value is not None:
            return value
        # Polling is bounded and observes state on every turn; this is not test synchronization.
        select.select([], [], [], min(0.002, max(0.0, deadline - time.monotonic())))
    detail = f"timed out after {timeout:.3f}s waiting for {description}"
    if diagnostics is not None:
        detail += "\n" + diagnostics()
    raise MuxTimeout(detail)


def wait_for_process_exit(
    process: int, *, timeout: float = 5.0, diagnostics: Callable[[], str] | None = None
) -> None:
    wait_until(
        f"process {process} to exit",
        lambda: True if not process_exists(process) else None,
        timeout=timeout,
        diagnostics=diagnostics,
    )


class Client:
    def __init__(
        self, server: LemmaServer, session: str, columns: int, rows: int
    ) -> None:
        self.server = server
        self.session = session
        self.columns = columns
        self.rows = rows
        self.process = PtyProcess(
            [
                str(server.cli_path),
                str(server.socket_path),
                "attach",
                session,
            ],
            server.environment,
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        if (columns, rows) != (80, 24):
            self.process.resize(columns, rows)
        try:
            self.process.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        except BaseException:
            self.close()
            raise

    @property
    def pid(self) -> int:
        return self.process.pid

    @property
    def running(self) -> bool:
        return self.process.running

    def send(self, data: str | bytes, *, timeout: float = 2.0) -> None:
        encoded = data.encode() if isinstance(data, str) else data
        try:
            self.process.write_all(encoded, timeout)
        except BaseException as error:
            raise RuntimeError(
                f"failed to send {encoded!r} to session {self.session!r}\n{self.diagnostics()}"
            ) from error

    def prefix(self, command: str) -> None:
        if len(command.encode()) != 1:
            raise ValueError("a mux command must be one byte")
        self.send(b"\x02" + command.encode())

    def expect_output(self, marker: str | bytes, *, timeout: float = 5.0) -> None:
        encoded = marker.encode() if isinstance(marker, str) else marker
        if self.process.screen.contains(encoded):
            return
        try:
            self.process.read_until(encoded, timeout, visible_text=True)
        except BaseException as error:
            raise MuxTimeout(
                f"did not observe visible output {encoded!r}\n{self.diagnostics()}\n"
                f"server:\n{self.server.logs()}"
            ) from error

    def expect_raw(self, marker: str | bytes, *, timeout: float = 5.0) -> None:
        encoded = marker.encode() if isinstance(marker, str) else marker
        if encoded in self.process.output_tail:
            return
        try:
            self.process.read_until(encoded, timeout)
        except BaseException as error:
            raise MuxTimeout(
                f"did not observe raw output {encoded!r}\n{self.diagnostics()}\n"
                f"server:\n{self.server.logs()}"
            ) from error

    def resize(self, columns: int, rows: int) -> None:
        self.process.resize(columns, rows)
        self.columns = columns
        self.rows = rows

    def drain(self, duration: float = 0.02) -> int:
        return self.process.drain(duration)

    def wait_for_exit(self, timeout: float = 5.0) -> None:
        self.process.wait_for_exit(timeout)

    def screen_text(self) -> str:
        return self.process.screen.text()

    def diagnostics(self) -> str:
        return (
            f"client pid={self.pid} running={self.running} geometry={self.columns}x{self.rows}\n"
            f"screen:\n{self.screen_text()}\n"
            f"raw tail:\n{self.process.output_tail[-4096:]!r}"
        )

    def close(self) -> None:
        self.process.close()


class LemmaServer:
    def __init__(self, server: str | Path, cli: str | Path, peer: str | Path) -> None:
        self.server_path = Path(server).resolve()
        self.cli_path = Path(cli).resolve()
        self.peer_path = Path(peer).resolve()
        for binary in (self.server_path, self.cli_path, self.peer_path):
            if not binary.is_file():
                raise FileNotFoundError(binary)
        self.temporary = tempfile.TemporaryDirectory(prefix="lemma-mux-test-")
        self.root = Path(self.temporary.name)
        self.socket_path = self.root / "daemon.sock"
        self.log_path = self.root / "server.log"
        home = self.root / "home"
        config = self.root / "config"
        zdot = self.root / "zdot"
        for directory in (home, config, zdot):
            directory.mkdir(mode=0o700)
        self.environment = {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(config),
            "ZDOTDIR": str(zdot),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TERM": "xterm-256color",
            "LANG": "C",
            "LC_ALL": "C",
            "TMPDIR": str(self.root),
        }
        for variable in ("ASAN_OPTIONS", "UBSAN_OPTIONS"):
            if variable in os.environ:
                self.environment[variable] = os.environ[variable]
        self.clients: list[Client] = []
        self._log = self.log_path.open("wb")
        self.process = subprocess.Popen(
            [str(self.server_path), str(self.socket_path)],
            env=self.environment,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            self._wait_ready()
        except BaseException:
            self.close()
            raise

    @classmethod
    def from_environment(cls) -> LemmaServer:
        required = ("LEMMA_TEST_SERVER", "LEMMA_TEST_CLI", "LEMMA_TEST_PTY_PEER")
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise RuntimeError(
                f"missing mux test binary environment: {', '.join(missing)}"
            )
        return cls(*(os.environ[name] for name in required))

    def __enter__(self) -> LemmaServer:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def _wait_ready(self) -> None:
        def connect() -> bool | None:
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"Lemma server exited during startup with {self.process.returncode}\n{self.logs()}"
                )
            peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                peer.connect(str(self.socket_path))
            except OSError:
                return None
            finally:
                peer.close()
            return True

        wait_until("Lemma daemon socket", connect, diagnostics=self.logs)

    def command(self, *arguments: str, timeout: float = 5.0) -> CommandResult:
        completed = subprocess.run(
            [str(self.cli_path), str(self.socket_path), *arguments],
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return CommandResult(
            status=completed.returncode,
            output=completed.stdout + completed.stderr,
            arguments=arguments,
        )

    def require_command(self, *arguments: str) -> CommandResult:
        result = self.command(*arguments)
        if result.status != 0:
            raise RuntimeError(
                f"command {result.arguments!r} failed with {result.status}:\n{result.output}\n"
                f"server:\n{self.logs()}"
            )
        return result

    def session_state(self, name: str) -> SessionState | None:
        # Keep the outer PTY flowing while observing daemon state. The attached client may be
        # emitting setup or frame bytes, and a test observer must not accidentally become a slow
        # client merely because it is polling topology.
        for client in self.clients:
            if client.session == name and client.running:
                client.drain(0.002)
        result = self.command("inspect", name)
        if result.status != 0:
            return None
        match = _LISTING.match(result.output)
        if match is None:
            raise RuntimeError(f"could not parse session listing:\n{result.output}")
        return SessionState(
            name=match.group("name"),
            tabs=int(match.group("tabs")),
            panes=int(match.group("panes")),
            focused_pid=int(match.group("pid")),
            columns=int(match.group("columns")),
            rows=int(match.group("rows")),
            attached=match.group("attached") == "attached",
            raw=result.output,
        )

    def wait_for_state(
        self,
        name: str,
        predicate: Callable[[SessionState], bool],
        description: str,
        *,
        timeout: float = 5.0,
    ) -> SessionState:
        return wait_until(
            description,
            lambda: (
                state
                if (state := self.session_state(name)) is not None and predicate(state)
                else None
            ),
            timeout=timeout,
            diagnostics=lambda: self.diagnostics(name),
        )

    def create_session(
        self, name: str, *, attach: bool = True, columns: int = 80, rows: int = 24
    ) -> Session:
        self.require_command("start", name)
        session = Session(self, name)
        if attach:
            session.attach(columns=columns, rows=rows)
        return session

    def attach(self, name: str, *, columns: int = 80, rows: int = 24) -> Client:
        client = Client(self, name, columns, rows)
        self.clients.append(client)
        return client

    def logs(self) -> str:
        self._log.flush()
        try:
            return self.log_path.read_text(encoding="utf-8", errors="replace")[-16_384:]
        except OSError:
            return "<server log unavailable>"

    def diagnostics(self, session: str | None = None) -> str:
        state = self.session_state(session) if session is not None else None
        clients = "\n\n".join(
            client.diagnostics() for client in self.clients if client.running
        )
        return (
            f"server pid={self.process.pid} status={self.process.poll()} socket={self.socket_path}\n"
            f"session={state.raw.strip() if state is not None else '<unavailable>'}\n"
            f"clients:\n{clients or '<none>'}\nserver log:\n{self.logs()}"
        )

    def close(self) -> None:
        for client in self.clients:
            client.close()
        self.clients.clear()
        if hasattr(self, "process") and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=1.0)
        if hasattr(self, "_log") and not self._log.closed:
            self._log.close()
        if hasattr(self, "temporary"):
            self.temporary.cleanup()


class Session:
    def __init__(self, server: LemmaServer, name: str) -> None:
        self.server = server
        self.name = name
        self.client: Client | None = None
        self.observed_pids: set[int] = set()

    def state(self) -> SessionState:
        state = self.server.session_state(self.name)
        if state is None:
            raise RuntimeError(
                f"session {self.name!r} does not exist\n{self.server.diagnostics()}"
            )
        self.observed_pids.add(state.focused_pid)
        return state

    def attach(self, *, columns: int = 80, rows: int = 24) -> Client:
        if self.client is not None and self.client.running:
            raise RuntimeError(f"session {self.name!r} is already attached")
        self.client = self.server.attach(self.name, columns=columns, rows=rows)
        self.server.wait_for_state(
            self.name,
            lambda state: state.attached,
            f"session {self.name!r} to attach",
        )
        self.observed_pids.add(self.state().focused_pid)
        return self.client

    def require_client(self) -> Client:
        if self.client is None or not self.client.running:
            raise RuntimeError(f"session {self.name!r} has no live client")
        return self.client

    def pane(self) -> Pane:
        return Pane(self, self.state().focused_pid)

    def focus_pid(self, process: int) -> Pane:
        client = self.require_client()
        for _ in range(self.state().panes):
            current = self.state()
            if current.focused_pid == process:
                return Pane(self, process)
            previous = current.focused_pid
            client.prefix("o")
            self.server.wait_for_state(
                self.name,
                lambda state: state.focused_pid != previous,
                f"focus to leave pane pid {previous}",
            )
        raise RuntimeError(
            f"pane pid {process} is not focusable\n{self.server.diagnostics(self.name)}"
        )

    def split(self, axis: str = "right") -> Pane:
        client = self.require_client()
        before = self.state()
        command = {"right": "%", "down": '"'}.get(axis)
        if command is None:
            raise ValueError(f"unsupported split axis {axis!r}")
        client.prefix(command)
        state = self.server.wait_for_state(
            self.name,
            lambda value: (
                value.panes == before.panes + 1
                and value.focused_pid != before.focused_pid
            ),
            f"{axis} split to create an independent pane",
        )
        self.observed_pids.add(state.focused_pid)
        return Pane(self, state.focused_pid)

    def detach(self) -> None:
        client = self.require_client()
        client.prefix("d")
        client.wait_for_exit()
        self.server.wait_for_state(
            self.name,
            lambda state: not state.attached,
            f"session {self.name!r} to detach",
        )
        self.client = None

    def destroy(self) -> None:
        result = self.server.command("kill", self.name)
        if result.status != 0:
            raise RuntimeError(f"failed to destroy {self.name!r}:\n{result.output}")
        wait_until(
            f"session {self.name!r} to disappear",
            lambda: True if self.server.session_state(self.name) is None else None,
            diagnostics=lambda: self.server.diagnostics(self.name),
        )


class Pane:
    def __init__(self, session: Session, process: int) -> None:
        self.session = session
        self.process = process

    def focus(self) -> Pane:
        return self.session.focus_pid(self.process)

    def split_right(self) -> Pane:
        self.focus()
        return self.session.split("right")

    def split_down(self) -> Pane:
        self.focus()
        return self.session.split("down")

    def send(self, data: str | bytes) -> None:
        self.focus()
        self.session.require_client().send(data)

    def expect_output(self, marker: str | bytes, *, timeout: float = 5.0) -> None:
        self.session.require_client().expect_output(marker, timeout=timeout)

    def expect_alive(self) -> None:
        if not process_exists(self.process):
            raise AssertionError(
                f"pane child {self.process} is not alive\n"
                f"{self.session.server.diagnostics(self.session.name)}"
            )

    def close(self) -> None:
        self.focus()
        before = self.session.state()
        if before.panes <= 1:
            raise RuntimeError("use Session.destroy for the final pane")
        self.session.require_client().prefix("x")
        self.session.server.wait_for_state(
            self.session.name,
            lambda state: (
                state.panes == before.panes - 1 and state.focused_pid != self.process
            ),
            f"pane pid {self.process} to close without retargeting",
        )
        wait_for_process_exit(
            self.process,
            diagnostics=lambda: self.session.server.diagnostics(self.session.name),
        )
