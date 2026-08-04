#!/usr/bin/env python3
"""Bounded process-level core-mux workloads with identical completion semantics."""

from __future__ import annotations

import argparse
from collections.abc import Callable
import ctypes
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import platform
import pwd
import pty
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
from typing import Any, Protocol

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


def metric_summary(samples: list[int], unit: str) -> dict[str, Any]:
    return {
        f"samples_{unit}": samples,
        f"p50_{unit}": percentile(samples, 0.50),
        f"p95_{unit}": percentile(samples, 0.95),
        f"p99_{unit}": percentile(samples, 0.99),
    }


def summary(samples: list[int]) -> dict[str, Any]:
    return metric_summary(samples, "ns")


def benchmark_environment(root: Path) -> dict[str, str]:
    for name in ("home", "config", "zdot", "data"):
        (root / name).mkdir(mode=0o700)
    try:
        account_shell = pwd.getpwuid(os.getuid()).pw_shell
    except (KeyError, OSError):
        account_shell = "/bin/sh"
    if not account_shell or not Path(account_shell).is_absolute():
        account_shell = "/bin/sh"
    return {
        "HOME": str(root / "home"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "ZDOTDIR": str(root / "zdot"),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "SHELL": account_shell,
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "C",
        "LC_ALL": "C",
        "TMPDIR": str(root),
    }


def parse_cpu_time(value: str) -> int:
    days = 0
    clock = value
    if "-" in clock:
        day_text, clock = clock.split("-", 1)
        days = int(day_text)
    parts = clock.split(":")
    if len(parts) == 3:
        hours, minutes, seconds = int(parts[0]), int(parts[1]), float(parts[2])
    elif len(parts) == 2:
        hours, minutes, seconds = 0, int(parts[0]), float(parts[1])
    else:
        raise ValueError(f"invalid process CPU time: {value!r}")
    return int((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000_000_000)


def darwin_resource_snapshot(pids: set[int]) -> dict[str, Any]:
    if platform.system() != "Darwin":
        return {"available": False, "reason": "not Darwin"}
    if not pids:
        return {"available": False, "reason": "no processes to sample"}

    class RusageInfoV0(ctypes.Structure):
        _fields_ = [
            ("uuid", ctypes.c_uint8 * 16),
            ("user_time", ctypes.c_uint64),
            ("system_time", ctypes.c_uint64),
            ("package_idle_wakeups", ctypes.c_uint64),
            ("interrupt_wakeups", ctypes.c_uint64),
            ("pageins", ctypes.c_uint64),
            ("wired_size", ctypes.c_uint64),
            ("resident_size", ctypes.c_uint64),
            ("physical_footprint", ctypes.c_uint64),
            ("process_start_time", ctypes.c_uint64),
            ("process_exit_time", ctypes.c_uint64),
            ("child_user_time", ctypes.c_uint64),
            ("child_system_time", ctypes.c_uint64),
            ("child_package_idle_wakeups", ctypes.c_uint64),
            ("child_interrupt_wakeups", ctypes.c_uint64),
            ("child_pageins", ctypes.c_uint64),
            ("child_elapsed_time", ctypes.c_uint64),
            ("disk_bytes_read", ctypes.c_uint64),
            ("disk_bytes_written", ctypes.c_uint64),
        ]

    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        proc_pid_rusage = libproc.proc_pid_rusage
        proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        proc_pid_rusage.restype = ctypes.c_int
        package_idle = 0
        interrupts = 0
        # rusage_info_v0 user/system fields are nanoseconds, not Mach absolute-time ticks.
        cpu_time_ns = 0
        sampled = 0
        for pid in pids:
            usage = RusageInfoV0()
            if proc_pid_rusage(pid, 0, ctypes.byref(usage)) != 0:
                continue
            package_idle += usage.package_idle_wakeups
            interrupts += usage.interrupt_wakeups
            cpu_time_ns += usage.user_time + usage.system_time
            sampled += 1
    except (AttributeError, OSError) as error:
        return {"available": False, "reason": str(error)}
    return {
        "available": sampled == len(pids),
        "source": "proc_pid_rusage RUSAGE_INFO_V0",
        "sampled_processes": sampled,
        "cpu_time_ns": cpu_time_ns,
        "package_idle": package_idle,
        "interrupt": interrupts,
        "total": package_idle + interrupts,
    }


def linux_cpu_snapshot(pids: set[int]) -> dict[str, Any]:
    if platform.system() != "Linux":
        return {"available": False, "reason": "not Linux"}
    if not pids:
        return {"available": False, "reason": "no processes to sample"}
    try:
        ticks_per_second = int(os.sysconf("SC_CLK_TCK"))
        ticks = 0
        sampled = 0
        for pid in pids:
            stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
            fields = stat[stat.rfind(")") + 2 :].split()
            ticks += int(fields[11]) + int(fields[12])
            sampled += 1
    except (IndexError, OSError, ValueError) as error:
        return {"available": False, "reason": str(error)}
    return {
        "available": sampled == len(pids),
        "source": "/proc/PID/stat utime+stime",
        "sampled_processes": sampled,
        "cpu_time_ns": ticks * 1_000_000_000 // ticks_per_second,
    }


def resource_snapshot(root_pids: list[int]) -> dict[str, Any]:
    """Capture portable process-tree RSS and consumed CPU time after the workloads."""
    try:
        output = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,rss=,time="],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout
        processes: dict[int, tuple[int, int, int]] = {}
        for line in output.splitlines():
            fields = line.split()
            if len(fields) != 4:
                continue
            pid, parent, rss_kib = (int(fields[index]) for index in range(3))
            processes[pid] = (parent, rss_kib * 1_024, parse_cpu_time(fields[3]))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"available": False, "error": str(error)}

    roots = set(root_pids)
    if not roots or any(pid <= 0 for pid in roots):
        return {"available": False, "error": "no valid root process set to sample"}
    missing_roots = roots.difference(processes)
    if missing_roots:
        return {
            "available": False,
            "error": "one or more root processes are no longer live",
            "missing_root_pids": sorted(missing_roots),
        }
    selected = set(roots)
    changed = True
    while changed:
        changed = False
        for pid, (parent, _, _) in processes.items():
            if pid not in selected and parent in selected:
                selected.add(pid)
                changed = True
    darwin_resources = darwin_resource_snapshot(selected)
    linux_cpu = linux_cpu_snapshot(selected)
    native_cpu = darwin_resources if darwin_resources.get("available") is True else linux_cpu
    wakeups = (
        {
            key: darwin_resources[key]
            for key in (
                "available",
                "source",
                "sampled_processes",
                "package_idle",
                "interrupt",
                "total",
            )
        }
        if darwin_resources.get("available") is True
        else {"available": False, "reason": "no supported OS wakeup counter"}
    )
    return {
        "available": True,
        "scope": "multiplexer client/server process trees after workloads",
        "process_count": len(selected),
        "rss_bytes": sum(processes[pid][1] for pid in selected),
        "cpu_time_ns": (
            native_cpu["cpu_time_ns"]
            if native_cpu.get("available") is True
            else sum(processes[pid][2] for pid in selected)
        ),
        "cpu_time_source": (
            native_cpu.get("source") if native_cpu.get("available") is True else "ps time"
        ),
        "wakeups": wakeups,
        "pids": sorted(selected),
    }


def idle_resources(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    cpu_samples: list[int] = []
    rss_samples: list[int] = []
    wakeup_samples: list[int] = []
    wakeups_available = True
    sample_seconds = 1.0
    for _ in range(repetitions):
        before = resource_snapshot(runtime.resource_roots())
        time.sleep(sample_seconds)
        after = resource_snapshot(runtime.resource_roots())
        if before.get("available") is not True or after.get("available") is not True:
            raise RuntimeError("idle resource snapshot is unavailable")
        cpu_samples.append(max(0, int(after["cpu_time_ns"]) - int(before["cpu_time_ns"])))
        rss_samples.append(int(after["rss_bytes"]))
        before_wakeups = before.get("wakeups")
        after_wakeups = after.get("wakeups")
        if (
            not isinstance(before_wakeups, dict)
            or not isinstance(after_wakeups, dict)
            or before_wakeups.get("available") is not True
            or after_wakeups.get("available") is not True
        ):
            wakeups_available = False
        else:
            wakeup_samples.append(
                max(0, int(after_wakeups["total"]) - int(before_wakeups["total"]))
            )
    return {
        "status": "completed",
        "sample_duration_ns": int(sample_seconds * 1_000_000_000),
        "cpu_time": summary(cpu_samples),
        "rss": metric_summary(rss_samples, "bytes"),
        "wakeups": {
            "available": wakeups_available,
            "source": "proc_pid_rusage RUSAGE_INFO_V0" if wakeups_available else None,
            **(
                metric_summary(wakeup_samples, "count")
                if wakeups_available
                else {"samples_count": []}
            ),
        },
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
            os.close(self.descriptor)
        except OSError:
            pass
        self.descriptor = -1
        try:
            os.kill(self.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                waited, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                waited = self.pid
            if waited == self.pid:
                self.pid = -1
                return
            time.sleep(0.01)
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                waited, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                waited = self.pid
            if waited == self.pid:
                self.pid = -1
                return
            time.sleep(0.01)
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        self.pid = -1

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
        self,
        marker: bytes,
        timeout: float,
        *,
        started_ns: int | None = None,
        failure_markers: tuple[bytes, ...] = (),
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
            for failure_marker in failure_markers:
                if failure_marker in retained:
                    raise RuntimeError(
                        f"observed failure {failure_marker!r} while waiting for {marker!r}"
                    )
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


class MuxRuntime(Protocol):
    multiplexer: str
    version: str
    peer_path: Path
    gate_path: Path
    receipt_path: Path
    clients: list[PtyProcess]

    def start_and_attach(self, session: str) -> PtyProcess: ...

    def resource_roots(self) -> list[int]: ...

    def binary_provenance(self) -> dict[str, str]: ...

    def close(self) -> None: ...


class LemmaRuntime:
    multiplexer = "lemma"
    version = "development"

    def __init__(self, server: Path, cli: Path, peer: Path) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="lemma-benchmark-")
        root = Path(self.temporary.name)
        self.socket_path = root / "daemon.sock"
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.server_path = server.resolve()
        self.cli_path = cli.resolve()
        self.peer_path = peer.resolve()
        self.environment = benchmark_environment(root)
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

    def resource_roots(self) -> list[int]:
        return [self.server.pid, *(client.pid for client in self.clients)]

    def binary_provenance(self) -> dict[str, str]:
        return {
            "server": str(self.server_path),
            "cli": str(self.cli_path),
            "workload": str(self.peer_path),
        }

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


class TmuxRuntime:
    multiplexer = "tmux"

    def __init__(self, executable: Path, peer: Path) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="tmux-benchmark-")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.socket_path = root / "tmux.sock"
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.environment = benchmark_environment(root)
        self.clients: list[PtyProcess] = []
        self.server_pid = -1
        self.version = subprocess.run(
            [str(self.executable_path), "-V"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout.strip()

    def _command(self, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.executable_path), "-S", str(self.socket_path), "-f", "/dev/null", *arguments],
            env=self.environment,
            check=check,
            capture_output=True,
            text=True,
            timeout=5.0,
        )

    def start_and_attach(self, session: str) -> PtyProcess:
        self._command("new-session", "-d", "-s", session, "-x", "80", "-y", "24")
        if self.server_pid < 0:
            self.server_pid = int(self._command("display-message", "-p", "#{pid}").stdout.strip())
        client = PtyProcess(
            [
                str(self.executable_path),
                "-S",
                str(self.socket_path),
                "-f",
                "/dev/null",
                "attach-session",
                "-t",
                session,
            ],
            self.environment,
        )
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0)
        return client

    def resource_roots(self) -> list[int]:
        return [self.server_pid, *(client.pid for client in self.clients)]

    def binary_provenance(self) -> dict[str, str]:
        return {"multiplexer": str(self.executable_path), "workload": str(self.peer_path)}

    def close(self) -> None:
        for client in self.clients:
            client.close()
        self.clients.clear()
        if self.server_pid > 0:
            try:
                self._command("kill-server", check=False)
            except subprocess.SubprocessError:
                pass
        self.temporary.cleanup()


class ZellijRuntime:
    multiplexer = "zellij"

    def __init__(self, executable: Path, peer: Path) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="zellij-benchmark-")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.environment = benchmark_environment(root)
        self.socket_directory = Path(tempfile.mkdtemp(prefix="lz-", dir="/tmp"))
        self.environment["ZELLIJ_SOCKET_DIR"] = str(self.socket_directory)
        self.config_path = root / "config.kdl"
        self.config_path.write_text(
            "show_startup_tips false\n"
            "show_release_notes false\n"
            "session_serialization false\n"
            "serialize_pane_viewport false\n"
            "disable_session_metadata true\n",
            encoding="utf-8",
        )
        self.session_prefix = f"lb-{os.getpid()}-"
        self.sessions: list[str] = []
        self.clients: list[PtyProcess] = []
        self.version = subprocess.run(
            [str(self.executable_path), "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout.strip()

    def _arguments(self, *arguments: str) -> list[str]:
        return [str(self.executable_path), "--config", str(self.config_path), *arguments]

    def _command(self, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self._arguments(*arguments),
            env=self.environment,
            check=check,
            capture_output=True,
            text=True,
            timeout=5.0,
        )

    def start_and_attach(self, session: str) -> PtyProcess:
        mapped_session = self.session_prefix + session.replace("_", "-")
        self._command("attach", "--create-background", mapped_session)
        self.sessions.append(mapped_session)
        client = PtyProcess(self._arguments("attach", mapped_session), self.environment)
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0)
        return client

    def _server_pids(self) -> list[int]:
        try:
            output = subprocess.run(
                ["ps", "-axo", "pid=,command="],
                check=True,
                capture_output=True,
                text=True,
                timeout=2.0,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        return [
            int(line.split(maxsplit=1)[0])
            for line in output.splitlines()
            if "--server" in line and any(session in line for session in self.sessions)
        ]

    def resource_roots(self) -> list[int]:
        return [*self._server_pids(), *(client.pid for client in self.clients)]

    def binary_provenance(self) -> dict[str, str]:
        return {"multiplexer": str(self.executable_path), "workload": str(self.peer_path)}

    def close(self) -> None:
        for client in self.clients:
            client.close()
        self.clients.clear()
        for session in self.sessions:
            try:
                self._command("kill-session", session, check=False)
            except subprocess.SubprocessError:
                pass
        self.sessions.clear()
        shutil.rmtree(self.socket_directory, ignore_errors=True)
        self.temporary.cleanup()


def warm_scroll(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
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
    result["status"] = "completed"
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


def blocked_pty(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
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
        if accepted <= 0:
            raise RuntimeError("blocked PTY accepted no payload")

        under_backpressure = latency_samples(responsive, receipts, "BLOCKED", repetitions)
        runtime.gate_path.touch(mode=0o600, exist_ok=False)
        blocked.write_all(payload[accepted:], 60.0)
        blocked.read_until(
            BLOCK_DONE,
            60.0,
            failure_markers=(
                b"lost connection",
                b"server exited unexpectedly",
                b"Received empty unknown from server",
            ),
        )

        return {
            "status": "completed",
            "payload_bytes": PAYLOAD_SIZE,
            "bytes_before_backpressure": accepted,
            "client_backpressure_observed": accepted < len(payload),
            "idle": idle,
            "blocked_other_session": under_backpressure,
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
    parser.add_argument("--multiplexer", choices=("lemma", "tmux", "zellij"), default="lemma")
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--server", type=Path, default=Path("build/release/lemma_test_server"))
    parser.add_argument("--cli", type=Path, default=Path("build/release/lemma_test_cli"))
    parser.add_argument("--peer", type=Path, default=Path("build/release/lemma_test_pty_peer"))
    parser.add_argument("--tmux", type=Path, default=Path("tmux"))
    parser.add_argument("--zellij", type=Path, default=Path("zellij"))
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--allow-workload-failures",
        action="store_true",
        help="record competitor workload failures instead of failing the harness",
    )
    arguments = parser.parse_args()
    if arguments.repetitions < 1 or arguments.repetitions > 1_000:
        parser.error("--repetitions must be between 1 and 1000")
    if not arguments.peer.is_file():
        parser.error(f"missing executable: {arguments.peer}")

    runtime: MuxRuntime
    build_profile: str | None = None
    if arguments.multiplexer == "lemma":
        for executable in (arguments.server, arguments.cli):
            if not executable.is_file():
                parser.error(f"missing executable: {executable}")
        runtime = LemmaRuntime(arguments.server, arguments.cli, arguments.peer)
        build_profile = arguments.server.parent.name
    elif arguments.multiplexer == "tmux":
        tmux = Path(shutil.which(str(arguments.tmux)) or arguments.tmux)
        if not tmux.is_file():
            parser.error(f"missing executable: {arguments.tmux}")
        runtime = TmuxRuntime(tmux, arguments.peer)
    else:
        zellij = Path(shutil.which(str(arguments.zellij)) or arguments.zellij)
        if not zellij.is_file():
            parser.error(f"missing executable: {arguments.zellij}")
        runtime = ZellijRuntime(zellij, arguments.peer)

    try:
        workloads: dict[str, Any] = {}

        def measure(
            name: str, operation: Callable[[MuxRuntime, int], dict[str, Any]]
        ) -> None:
            try:
                workloads[name] = operation(runtime, arguments.repetitions)
            except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
                if not arguments.allow_workload_failures:
                    raise
                workloads[name] = {
                    "status": "failed",
                    "error": f"{type(error).__name__}: {error}",
                }

        if arguments.mode in ("warm-scroll", "all"):
            measure("warm_scroll", warm_scroll)
        if arguments.mode == "all":
            if workloads.get("warm_scroll", {}).get("status") == "completed":
                measure("idle_resources", idle_resources)
            else:
                workloads["idle_resources"] = {
                    "status": "failed",
                    "error": "not run because warm_scroll did not complete",
                }
        if arguments.mode in ("blocked-pty", "all"):
            measure("blocked_pty", blocked_pty)
        commit, worktree_dirty = git_provenance()
        report = {
            "schema": 3,
            "suite": "core-mux-baseline",
            "multiplexer": runtime.multiplexer,
            "multiplexer_version": runtime.version,
            "commit": commit,
            "worktree_dirty": worktree_dirty,
            "host": platform.node(),
            "system": platform.system(),
            "architecture": platform.machine(),
            "terminal": {"columns": 80, "rows": 24, "term": "xterm-256color"},
            "repetitions": arguments.repetitions,
            "binaries": runtime.binary_provenance(),
            "build_profile": build_profile,
            "resources_after_workloads": resource_snapshot(runtime.resource_roots()),
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
