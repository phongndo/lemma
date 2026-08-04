#!/usr/bin/env python3
"""Bounded process-level benchmarks for Lemma's warm mux and PTY backpressure paths."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import platform
import pty
import select
import shlex
import signal
import socket
import struct
import subprocess
import tempfile
import time
from typing import Any

ALT_SCREEN = b"\x1b[?1049h"
WARM_MARKER = b"__LEMMA_WARM_SCROLL_DONE__"
BLOCK_READY = b"__LEMMA_PTY_READY__"
BLOCK_DONE = b"__LEMMA_PTY_DONE__ bytes=2097152 digest=d939b04ca2c22325"
LATENCY_READY = b"__LEMMA_LATENCY_READY__"
PAYLOAD_SIZE = 2 * 1024 * 1024


def percentile(samples: list[int], quantile: float) -> int:
    ordered = sorted(samples)
    index = max(0, min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


def summary(samples: list[int]) -> dict[str, Any]:
    return {
        "samples_ns": samples,
        "p50_ns": percentile(samples, 0.50),
        "p95_ns": percentile(samples, 0.95),
        "p99_ns": percentile(samples, 0.99),
    }


class PtyProcess:
    def __init__(self, arguments: list[str], environment: dict[str, str]) -> None:
        release_read, release_write = os.pipe()
        try:
            pid, descriptor = pty.fork()
        except BaseException:
            os.close(release_read)
            os.close(release_write)
            raise
        if pid == 0:
            os.close(release_write)
            try:
                released = os.read(release_read, 1)
            finally:
                os.close(release_read)
            if released != b"\0":
                os._exit(127)
            os.execve(arguments[0], arguments, environment)

        os.close(release_read)
        self.pid = pid
        self.descriptor = descriptor
        try:
            fcntl.ioctl(descriptor, termios_tiocswinsz(), struct.pack("HHHH", 24, 80, 0, 0))
            flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
            fcntl.fcntl(descriptor, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            os.write(release_write, b"\0")
        except BaseException:
            os.close(release_write)
            self.close()
            raise
        os.close(release_write)

    def close(self) -> None:
        if self.pid <= 0:
            return
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            waited, _ = os.waitpid(self.pid, os.WNOHANG)
            if waited == self.pid:
                self.pid = -1
                break
            time.sleep(0.01)
        if self.pid > 0:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
            self.pid = -1
        try:
            os.close(self.descriptor)
        except OSError:
            pass

    def write_all(self, data: bytes, timeout: float) -> None:
        offset = 0
        deadline = time.monotonic() + timeout
        while offset < len(data):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"PTY write timed out after {offset}/{len(data)} bytes")
            try:
                offset += os.write(self.descriptor, data[offset:])
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"PTY write timed out after {offset}/{len(data)} bytes")
                select.select([], [self.descriptor], [], min(remaining, 0.02))
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"PTY write timed out after {offset}/{len(data)} bytes")

    def fill_until_stalled(self, data: bytes, stall_seconds: float = 0.25) -> int:
        offset = 0
        last_progress = time.monotonic()
        deadline = last_progress + 5.0
        while offset < len(data) and time.monotonic() < deadline:
            try:
                written = os.write(self.descriptor, data[offset:])
            except BlockingIOError:
                written = 0
            if written:
                offset += written
                last_progress = time.monotonic()
            elif time.monotonic() - last_progress >= stall_seconds:
                break
            else:
                time.sleep(0.001)
        return offset

    def read_until(
        self, marker: bytes, timeout: float, *, started_ns: int | None = None
    ) -> tuple[int, int]:
        if started_ns is None:
            started_ns = time.monotonic_ns()
        deadline = time.monotonic() + timeout
        total = 0
        retained = b""
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            readable, _, _ = select.select([self.descriptor], [], [], min(remaining, 0.02))
            if not readable:
                continue
            try:
                data = os.read(self.descriptor, 64 * 1024)
            except BlockingIOError:
                continue
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            total += len(data)
            retained = (retained + data)[-(len(marker) + 64 * 1024) :]
            if marker in retained:
                return time.monotonic_ns() - started_ns, total
        raise TimeoutError(f"did not observe {marker!r}; tail={retained[-4096:]!r}")

    def drain(self, duration: float = 0.05) -> int:
        deadline = time.monotonic() + duration
        total = 0
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.descriptor], [], [], 0.005)
            if not readable:
                continue
            try:
                data = os.read(self.descriptor, 64 * 1024)
            except (BlockingIOError, OSError):
                break
            if not data:
                break
            total += len(data)
        return total


class PtyReceiptChannel:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.descriptor = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            self.descriptor.bind(str(path))
        except BaseException:
            self.descriptor.close()
            raise
        self.descriptor.setblocking(False)

    def read_latency(self, marker: bytes, timeout: float, started_ns: int) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            readable, _, _ = select.select([self.descriptor], [], [], min(remaining, 0.02))
            if not readable:
                continue
            received = self.descriptor.recv(4 * 1024)
            if received != marker:
                raise RuntimeError(f"unexpected PTY receipt: expected={marker!r} actual={received!r}")
            return time.monotonic_ns() - started_ns
        raise TimeoutError(f"did not receive PTY receipt for {marker!r}")

    def close(self) -> None:
        self.descriptor.close()
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def termios_tiocswinsz() -> int:
    # TIOCSWINSZ is stable on the supported Darwin and Linux hosts.
    import termios

    return termios.TIOCSWINSZ


class LemmaRuntime:
    def __init__(self, server: Path, cli: Path, peer: Path) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="lemma-benchmark-")
        root = Path(self.temporary.name)
        for name in ("home", "config", "zdot"):
            (root / name).mkdir(mode=0o700)
        self.socket_path = root / "daemon.sock"
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.server_path = server.resolve()
        self.cli_path = cli.resolve()
        self.peer_path = peer.resolve()
        self.environment = {
            "HOME": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "ZDOTDIR": str(root / "zdot"),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TERM": "xterm-256color",
            "LANG": "C",
            "LC_ALL": "C",
            "TMPDIR": str(root),
        }
        self.server = subprocess.Popen(
            [str(self.server_path), str(self.socket_path)],
            env=self.environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.clients: list[PtyProcess] = []
        try:
            self._wait_ready()
        except BaseException:
            self.close()
            raise

    def _wait_ready(self) -> None:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.connect(str(self.socket_path))
                connection.close()
                return
            except OSError:
                time.sleep(0.005)
        raise TimeoutError("Lemma benchmark server did not become ready")

    def command(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.cli_path), str(self.socket_path), *arguments],
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=5.0,
        )

    def attach(self, session: str) -> PtyProcess:
        client = PtyProcess(
            [str(self.cli_path), str(self.socket_path), "attach", session], self.environment
        )
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        self.command("start", session)
        return self.attach(session)

    def close(self) -> None:
        for client in self.clients:
            client.close()
        self.clients.clear()
        if self.server.poll() is None:
            try:
                os.killpg(self.server.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.server.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.server.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.server.wait(timeout=0.5)
        self.temporary.cleanup()


def warm_scroll(runtime: LemmaRuntime, repetitions: int) -> dict[str, Any]:
    client = runtime.start_and_attach("warm_scroll")
    command = f"{shlex.quote(str(runtime.peer_path))} warm-scroll\r".encode()
    client.write_all(command, 2.0)
    client.read_until(WARM_MARKER, 60.0)
    client.drain()

    latencies: list[int] = []
    client_bytes: list[int] = []
    for _ in range(repetitions):
        started_ns = time.monotonic_ns()
        client.write_all(command, 2.0)
        latency, output_bytes = client.read_until(WARM_MARKER, 60.0, started_ns=started_ns)
        latencies.append(latency)
        client_bytes.append(output_bytes)
        client.drain()
    result = summary(latencies)
    result["client_bytes"] = client_bytes
    result["median_client_bytes"] = percentile(client_bytes, 0.50)
    return result


def latency_samples(
    client: PtyProcess, receipts: PtyReceiptChannel, label: str, repetitions: int
) -> dict[str, Any]:
    key_to_pty: list[int] = []
    key_to_visible: list[int] = []
    for index in range(repetitions):
        marker = f"__LEMMA_{label}_{index:04d}__".encode()
        started_ns = time.monotonic_ns()
        client.write_all(marker + b"\n", 2.0)
        key_to_pty.append(receipts.read_latency(marker, 5.0, started_ns))
        visible_latency, _ = client.read_until(marker, 5.0, started_ns=started_ns)
        key_to_visible.append(visible_latency)
        client.drain(0.01)
    return {
        "key_to_pty": summary(key_to_pty),
        "key_to_visible": summary(key_to_visible),
    }


def blocked_pty(runtime: LemmaRuntime, repetitions: int) -> dict[str, Any]:
    receipts = PtyReceiptChannel(runtime.receipt_path)
    try:
        blocked = runtime.start_and_attach("blocked_benchmark")
        responsive = runtime.start_and_attach("responsive_benchmark")
        receipt_launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency "
            f"{shlex.quote(str(runtime.receipt_path))}\r"
        ).encode()
        responsive.write_all(receipt_launch, 2.0)
        responsive.read_until(LATENCY_READY, 5.0)
        responsive.drain(0.01)
        idle = latency_samples(responsive, receipts, "IDLE", repetitions)

        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} block "
            f"{shlex.quote(str(runtime.gate_path))} {PAYLOAD_SIZE}\r"
        ).encode()
        blocked.write_all(launch, 2.0)
        blocked.read_until(BLOCK_READY, 5.0)
        payload = b"q" * PAYLOAD_SIZE
        accepted = blocked.fill_until_stalled(payload)
        if accepted <= 0 or accepted >= len(payload):
            raise RuntimeError(f"blocked PTY did not backpressure payload: accepted={accepted}")

        under_backpressure = latency_samples(responsive, receipts, "BLOCKED", repetitions)
        runtime.gate_path.touch(mode=0o600, exist_ok=False)
        blocked.write_all(payload[accepted:], 15.0)
        blocked.read_until(BLOCK_DONE, 35.0)

        return {
            "payload_bytes": PAYLOAD_SIZE,
            "bytes_before_backpressure": accepted,
            "idle": idle,
            "blocked_other_pane": under_backpressure,
        }
    finally:
        receipts.close()


def git_provenance() -> tuple[str, bool | None]:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=normal"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout
        return commit, bool(status)
    except (OSError, subprocess.SubprocessError):
        return "unknown", None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("warm-scroll", "blocked-pty", "all"), default="all")
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--server", type=Path, default=Path("build/release/lemma_test_server"))
    parser.add_argument("--cli", type=Path, default=Path("build/release/lemma_test_cli"))
    parser.add_argument("--peer", type=Path, default=Path("build/release/lemma_test_pty_peer"))
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if arguments.repetitions < 1 or arguments.repetitions > 1_000:
        parser.error("--repetitions must be between 1 and 1000")
    for executable in (arguments.server, arguments.cli, arguments.peer):
        if not executable.is_file():
            parser.error(f"missing executable: {executable}")

    runtime = LemmaRuntime(arguments.server, arguments.cli, arguments.peer)
    try:
        workloads: dict[str, Any] = {}
        if arguments.mode in ("warm-scroll", "all"):
            workloads["warm_scroll"] = warm_scroll(runtime, arguments.repetitions)
        if arguments.mode in ("blocked-pty", "all"):
            workloads["blocked_pty"] = blocked_pty(runtime, arguments.repetitions)
        commit, worktree_dirty = git_provenance()
        report = {
            "schema": 2,
            "multiplexer": "lemma",
            "commit": commit,
            "worktree_dirty": worktree_dirty,
            "host": platform.node(),
            "system": platform.system(),
            "architecture": platform.machine(),
            "repetitions": arguments.repetitions,
            "binaries": {
                "server": str(runtime.server_path),
                "cli": str(runtime.cli_path),
                "workload": str(runtime.peer_path),
            },
            "build_profile": runtime.server_path.parent.name,
            "workloads": workloads,
        }
    finally:
        runtime.close()

    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
