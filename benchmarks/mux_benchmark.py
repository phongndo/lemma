#!/usr/bin/env python3
"""Bounded process-level core-mux workloads with identical completion semantics."""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import json
import math
import os
import platform
import pty
import pwd
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

ALT_SCREEN = b"\x1b[?1049h"
# Exact outer-terminal cleanup emitted by src/client/attached_client.cpp.
LEMMA_OUTER_TERMINAL_RESTORE = (
    b"\x1b[0m\x1b[?2026l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l"
    b"\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l"
    b"\x1b[?2004l\x1b[?25h\x1b[?7h\x1b[?1049l"
)
FINAL_PTY_OUTPUT_BYTES = 64 * 1024
WARM_MARKER = b"__LEMMA_WARM_SCROLL_DONE__"
BLOCK_READY = b"__LEMMA_PTY_READY__"
BLOCK_DONE = b"__LEMMA_PTY_DONE__ bytes=2097152 digest=d939b04ca2c22325"
LATENCY_READY = b"__LEMMA_LATENCY_READY__"
LATENCY_OUTPUT_READY = b"__LEMMA_LATENCY_OUTPUT_READY__"
LATENCY_NEXT_READY = b"__LEMMA_LATENCY_NEXT__"
ATTACH_VISIBLE_MARKER = b"__LEMMA_ATTACH_VISIBLE__"
ATTACH_MAGIC = b"\x89LMA"
ATTACH_PROTOCOL_MAJOR = 1
ATTACH_PROTOCOL_MINOR = 0
ATTACH_HEADER_BYTES = 16
ATTACH_KIND_HELLO = 1
ATTACH_KIND_INPUT = 2
PAYLOAD_SIZE = 2 * 1024 * 1024
BLOCKED_CLIENT_NO_PROGRESS_TIMEOUT_NS = 5_000_000_000
# The workload starts its clock at the flood command rather than at the first queued daemon frame.
# Allow a bounded startup and CLI polling margin without weakening the five-second contract.
BLOCKED_CLIENT_DISCONNECT_TOLERANCE_NS = 500_000_000
BLOCKED_CLIENT_DISCONNECT_DEADLINE_NS = (
    BLOCKED_CLIENT_NO_PROGRESS_TIMEOUT_NS + BLOCKED_CLIENT_DISCONNECT_TOLERANCE_NS
)
ATTACH_STARTUP_SHELLS = {
    "sh",
    "dash",
    "ksh",
    "mksh",
    "bash",
    "zsh",
    "fish",
    "nu",
    "nushell",
}


def darwin_sysctl(name: str) -> str | None:
    if platform.system() != "Darwin":
        return None
    try:
        value = subprocess.run(
            ["/usr/sbin/sysctl", "-n", name],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return value or None


def host_fingerprint() -> dict[str, Any]:
    def integer_sysctl(name: str) -> int | None:
        value = darwin_sysctl(name)
        try:
            return int(value) if value is not None else None
        except ValueError:
            return None

    return {
        "host_name": platform.node(),
        "model_identifier": darwin_sysctl("hw.model"),
        "cpu_model": darwin_sysctl("machdep.cpu.brand_string"),
        "physical_cpu_count": integer_sysctl("hw.physicalcpu"),
        "memory_bytes": integer_sysctl("hw.memsize"),
    }


def attach_frame(kind: int, payload: bytes, sequence: int, flags: int = 0) -> bytes:
    if not 0 < sequence <= 0xFFFF_FFFF or len(payload) > 0xFFFF_FFFF:
        raise ValueError("private attach frame exceeds its wire bounds")
    return struct.pack(
        "!4sBBBBII",
        ATTACH_MAGIC,
        ATTACH_PROTOCOL_MAJOR,
        ATTACH_PROTOCOL_MINOR,
        kind,
        flags,
        len(payload),
        sequence,
    ) + payload


def receive_exact(peer: socket.socket, size: int) -> bytes:
    received = bytearray()
    while len(received) < size:
        fragment = peer.recv(size - len(received))
        if not fragment:
            raise RuntimeError("private attach peer closed during a framed message")
        received.extend(fragment)
    return bytes(received)


def receive_attach_hello(peer: socket.socket) -> None:
    header = receive_exact(peer, ATTACH_HEADER_BYTES)
    magic, major, minor, kind, flags, payload_bytes, sequence = struct.unpack(
        "!4sBBBBII", header
    )
    if (
        magic != ATTACH_MAGIC
        or (major, minor) != (ATTACH_PROTOCOL_MAJOR, ATTACH_PROTOCOL_MINOR)
        or kind != ATTACH_KIND_HELLO
        or flags != 0
        or payload_bytes != 4
        or sequence != 1
    ):
        raise RuntimeError("blocked client received an invalid daemon hello")
    receive_exact(peer, payload_bytes)


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


INTERACTION_LABEL_CODES = {
    "OUTPUT": b"OUT",
    "IDLE": b"IDL",
    "BLOCKED": b"BLK",
    "CLIENT_IDLE": b"CID",
    "CLIENT_BLOCKED": b"CBL",
    "P1_IDLE": b"PAI",
    "P1_ACTIVE": b"PAA",
    "P4_IDLE": b"PBI",
    "P4_ACTIVE": b"PBA",
    "P16_IDLE": b"PCI",
    "P16_ACTIVE": b"PCA",
    "PMAX_IDLE": b"PDI",
    "PMAX_ACTIVE": b"PDA",
}


def interaction_visible_token(label: str, index: int) -> bytes:
    encoded_index = bytearray(b"A" * 5)
    remaining = index
    for position in range(len(encoded_index) - 1, -1, -1):
        encoded_index[position] = ord("A") + (remaining % 26)
        remaining //= 26
    label_code = INTERACTION_LABEL_CODES.get(label)
    if remaining != 0 or label_code is None:
        raise ValueError("interaction marker is outside its bounded token space")
    return label_code + bytes(encoded_index)


def interaction_marker(label: str, index: int) -> bytes:
    visible_token = interaction_visible_token(label, index)
    return f"__LEMMA_{label}_{index:04d}_".encode() + visible_token + b"__"


def account_login_shell() -> str:
    try:
        account_shell = pwd.getpwuid(os.getuid()).pw_shell
    except (KeyError, OSError):
        account_shell = "/bin/sh"
    if (
        not account_shell
        or not Path(account_shell).is_absolute()
        or not os.access(account_shell, os.X_OK)
    ):
        return "/bin/sh"
    return account_shell


def benchmark_environment(root: Path) -> dict[str, str]:
    for name in ("home", "config", "zdot", "data"):
        (root / name).mkdir(mode=0o700)
    account_shell = account_login_shell()
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


def install_attach_shell_startup(environment: dict[str, str], peer: Path) -> None:
    shell = Path(environment["SHELL"]).name
    command = f"exec {shlex.quote(str(peer))} attach-visible\n"
    home = Path(environment["HOME"])
    config = Path(environment["XDG_CONFIG_HOME"])
    zdot = Path(environment["ZDOTDIR"])
    if shell in {"sh", "dash", "ksh", "mksh"}:
        interactive_startup = config / "lemma" / "attach-fixture.sh"
        environment["ENV"] = str(interactive_startup)
        paths = (home / ".profile", interactive_startup)
    elif shell == "bash":
        paths = (home / ".bash_profile", home / ".bashrc")
    elif shell == "zsh":
        paths = (zdot / ".zprofile", zdot / ".zshrc")
    elif shell == "fish":
        paths = (config / "fish" / "config.fish",)
    elif shell in {"nu", "nushell"}:
        paths = (config / "nushell" / "config.nu",)
        command = f"exec {json.dumps(str(peer))} attach-visible\n"
    else:
        raise RuntimeError(
            f"attach-to-visible does not support account login shell {environment['SHELL']!r}"
        )
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(command, encoding="utf-8")


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


def open_descriptor_snapshot(pid: int) -> dict[str, Any]:
    if pid <= 0:
        return {"available": False, "reason": "invalid process"}
    if platform.system() == "Linux":
        try:
            return {
                "available": True,
                "source": "/proc/PID/fd",
                "count": len(list(Path(f"/proc/{pid}/fd").iterdir())),
            }
        except OSError as error:
            return {"available": False, "reason": str(error)}
    if platform.system() == "Darwin":
        # proc_fdinfo is two int32 values. A fixed 4,096-entry buffer is well above Lemma's
        # reviewed descriptor bounds and avoids a size-probe race.
        try:
            libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
            proc_pidinfo = libproc.proc_pidinfo
            proc_pidinfo.argtypes = [
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_uint64,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            proc_pidinfo.restype = ctypes.c_int
            entry_bytes = ctypes.sizeof(ctypes.c_int32) * 2
            capacity = 4_096
            storage = ctypes.create_string_buffer(entry_bytes * capacity)
            received = proc_pidinfo(pid, 1, 0, storage, len(storage))
            if received <= 0 or received % entry_bytes != 0:
                return {"available": False, "reason": "proc_pidinfo(PROC_PIDLISTFDS) failed"}
            if received == len(storage):
                return {"available": False, "reason": "descriptor census exceeded 4,096 entries"}
            return {
                "available": True,
                "source": "proc_pidinfo PROC_PIDLISTFDS",
                "count": received // entry_bytes,
            }
        except (AttributeError, OSError) as error:
            return {"available": False, "reason": str(error)}
    return {"available": False, "reason": "unsupported platform"}


def process_group_snapshot(
    pids: set[int], processes: dict[int, tuple[int, int, int]]
) -> dict[str, Any]:
    if not pids:
        return {"available": False, "reason": "no live processes in role"}
    darwin_resources = darwin_resource_snapshot(pids)
    linux_cpu = linux_cpu_snapshot(pids)
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
        else {
            "available": False,
            "reason": "no reviewed per-process wakeup counter on this platform",
        }
    )
    return {
        "available": True,
        "process_count": len(pids),
        "rss_bytes": sum(processes[pid][1] for pid in pids),
        "cpu_time_ns": (
            native_cpu["cpu_time_ns"]
            if native_cpu.get("available") is True
            else sum(processes[pid][2] for pid in pids)
        ),
        "cpu_time_source": (
            native_cpu.get("source") if native_cpu.get("available") is True else "ps time"
        ),
        "wakeups": wakeups,
        "pids": sorted(pids),
    }


def resource_snapshot(
    root_pids: list[int],
    role_pids: dict[str, list[int]] | None = None,
    unavailable_roles: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Capture direct-role and complete process-tree RSS, CPU, and reviewed wakeup counters."""
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

    roots = {pid for pid in root_pids if pid > 0}
    if not roots:
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

    total = process_group_snapshot(selected, processes)
    if total.get("available") is not True:
        return total
    roles: dict[str, Any] = {}
    classified: set[int] = set()
    for role, configured in (role_pids or {}).items():
        direct = {pid for pid in configured if pid in selected}
        roles[role] = process_group_snapshot(direct, processes)
        classified.update(direct)
    for role, reason in (unavailable_roles or {}).items():
        roles.setdefault(role, {"available": False, "reason": reason})
    unclassified = selected.difference(classified)
    if unclassified:
        roles["pane_or_mux_children"] = process_group_snapshot(unclassified, processes)

    return {
        **total,
        "scope": "multiplexer direct roles and complete descendant process tree",
        "roles": roles,
    }


def runtime_resource_snapshot(runtime: MuxRuntime) -> dict[str, Any]:
    return resource_snapshot(
        runtime.resource_roots(), runtime.resource_role_pids(), runtime.unavailable_resource_roles()
    )


def summarize_resource_samples(
    before_samples: list[dict[str, Any]], after_samples: list[dict[str, Any]]
) -> dict[str, Any]:
    cpu_samples = [
        max(0, int(after["cpu_time_ns"]) - int(before["cpu_time_ns"]))
        for before, after in zip(before_samples, after_samples, strict=True)
    ]
    rss_samples = [int(after["rss_bytes"]) for after in after_samples]
    wakeup_samples: list[int] = []
    wakeup_source: str | None = None
    wakeups_available = True
    for before, after in zip(before_samples, after_samples, strict=True):
        before_wakeups = before.get("wakeups")
        after_wakeups = after.get("wakeups")
        if (
            not isinstance(before_wakeups, dict)
            or not isinstance(after_wakeups, dict)
            or before_wakeups.get("available") is not True
            or after_wakeups.get("available") is not True
        ):
            wakeups_available = False
            continue
        wakeup_source = str(after_wakeups.get("source"))
        wakeup_samples.append(
            max(0, int(after_wakeups["total"]) - int(before_wakeups["total"]))
        )
    return {
        "cpu_time": summary(cpu_samples),
        "rss": metric_summary(rss_samples, "bytes"),
        "wakeups": {
            "available": wakeups_available,
            "source": wakeup_source if wakeups_available else None,
            "reason": None
            if wakeups_available
            else "no reviewed per-process wakeup counter on this platform",
            **(
                metric_summary(wakeup_samples, "count")
                if wakeups_available
                else {"samples_count": []}
            ),
        },
    }


def sample_resources(
    runtime: MuxRuntime, repetitions: int, client: PtyProcess | None = None
) -> dict[str, Any]:
    sample_seconds = 1.0
    before_samples: list[dict[str, Any]] = []
    after_samples: list[dict[str, Any]] = []
    outer_bytes: list[int] = []
    for _ in range(repetitions):
        before = runtime_resource_snapshot(runtime)
        if client is None:
            time.sleep(sample_seconds)
        else:
            outer_bytes.append(client.drain(sample_seconds))
        after = runtime_resource_snapshot(runtime)
        if before.get("available") is not True or after.get("available") is not True:
            raise RuntimeError("resource snapshot is unavailable")
        before_samples.append(before)
        after_samples.append(after)

    role_names = set()
    for snapshot in (*before_samples, *after_samples):
        roles = snapshot.get("roles")
        if isinstance(roles, dict):
            role_names.update(roles)
    role_results: dict[str, Any] = {}
    for role in sorted(role_names):
        role_before = [snapshot.get("roles", {}).get(role, {}) for snapshot in before_samples]
        role_after = [snapshot.get("roles", {}).get(role, {}) for snapshot in after_samples]
        if all(sample.get("available") is True for sample in (*role_before, *role_after)):
            role_results[role] = {
                "available": True,
                **summarize_resource_samples(role_before, role_after),
            }
        else:
            reason = next(
                (
                    str(sample.get("reason"))
                    for sample in (*role_before, *role_after)
                    if sample.get("available") is not True and sample.get("reason")
                ),
                "role was unavailable during sampling",
            )
            role_results[role] = {"available": False, "reason": reason}

    sampled_output = (
        {
            "available": True,
            **metric_summary(outer_bytes, "bytes"),
        }
        if client is not None
        else {
            "available": False,
            "reason": "no attached outer client was sampled",
            "samples_bytes": [],
        }
    )
    sampled_throughput = (
        {
            "available": True,
            **metric_summary(
                [int(value / sample_seconds) for value in outer_bytes],
                "bytes_per_second",
            ),
        }
        if client is not None
        else {
            "available": False,
            "reason": "no attached outer client was sampled",
            "samples_bytes_per_second": [],
        }
    )
    return {
        "status": "completed",
        "sample_duration_ns": int(sample_seconds * 1_000_000_000),
        **summarize_resource_samples(before_samples, after_samples),
        "outer_bytes": sampled_output,
        "outer_throughput": sampled_throughput,
        "roles": role_results,
    }


def idle_resources(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    client = runtime.start_and_attach("idle_resources")
    client.drain()
    return sample_resources(runtime, repetitions, client)


class PtyProcess:
    def __init__(
        self,
        arguments: list[str],
        environment: dict[str, str],
        *,
        terminal_restore_sequence: bytes | None = None,
    ) -> None:
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
        self.pending_read = b""
        self.initial_terminal_attributes: list[Any] | None = None
        self.terminal_restore_sequence = terminal_restore_sequence
        self.final_output = b""
        self.terminal_modes_restored: bool | None = None
        self.terminal_state_restored: bool | None = None
        try:
            fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            self.initial_terminal_attributes = termios.tcgetattr(descriptor)
            flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
            fcntl.fcntl(descriptor, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            os.write(release_write, b"\0")
        except BaseException:
            os.close(release_write)
            self.close()
            raise
        os.close(release_write)

    def wait_for_exit(self, timeout: float) -> None:
        if self.pid <= 0:
            return
        self.final_output = b""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            # Detaching clients restore terminal modes before exit. Keep consuming and retaining
            # the final PTY output so cleanup cannot block and escape-controlled modes are checked.
            self.drain(
                min(0.01, max(0.0, deadline - time.monotonic())),
                retain_final_output=True,
            )
            try:
                waited, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError as error:
                raise RuntimeError("PTY child was reaped unexpectedly") from error
            if waited == self.pid:
                # Consume bytes queued immediately before exit before inspecting the cleanup tail.
                self.drain(0.05, retain_final_output=True)
                try:
                    current_attributes = termios.tcgetattr(self.descriptor)
                    attributes_restored = (
                        self.initial_terminal_attributes is not None
                        and current_attributes == self.initial_terminal_attributes
                    )
                except termios.error:
                    attributes_restored = False
                if self.terminal_restore_sequence is None:
                    self.terminal_modes_restored = None
                    self.terminal_state_restored = attributes_restored
                else:
                    self.terminal_modes_restored = (
                        self.terminal_restore_sequence in self.final_output
                    )
                    self.terminal_state_restored = (
                        attributes_restored and self.terminal_modes_restored is True
                    )
                try:
                    os.close(self.descriptor)
                except OSError:
                    pass
                self.descriptor = -1
                self.pid = -1
                if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                    raise RuntimeError(f"PTY child exited unsuccessfully: status={status}")
                return
            time.sleep(0.005)
        raise TimeoutError("PTY child did not exit after detach")

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

    def resize(self, columns: int, rows: int) -> None:
        if not 0 < columns <= 500 or not 0 < rows <= 200 or self.pid <= 0:
            raise ValueError("PTY resize is outside the private attach bounds")
        encoded = struct.pack("HHHH", rows, columns, 0, 0)
        fcntl.ioctl(self.descriptor, termios.TIOCSWINSZ, encoded)
        actual = fcntl.ioctl(
            self.descriptor, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0)
        )
        actual_rows, actual_columns, _, _ = struct.unpack("HHHH", actual)
        if (actual_columns, actual_rows) != (columns, rows):
            raise RuntimeError("outer PTY did not retain the requested dimensions")
        try:
            os.killpg(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            raise RuntimeError("attached client exited during resize") from None

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
        preserve_suffix: bool = False,
    ) -> tuple[int, int]:
        if started_ns is None:
            started_ns = time.monotonic_ns()
        deadline = time.monotonic() + timeout
        total = 0
        retained = b""
        while time.monotonic() < deadline:
            if self.pending_read:
                data = self.pending_read
                self.pending_read = b""
            else:
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
            marker_offset = retained.find(marker)
            if marker_offset >= 0:
                suffix = retained[marker_offset + len(marker) :]
                if preserve_suffix:
                    self.pending_read = suffix
                    total -= len(suffix)
                return time.monotonic_ns() - started_ns, total
            for failure_marker in failure_markers:
                if failure_marker in retained:
                    raise RuntimeError(
                        f"observed failure {failure_marker!r} while waiting for {marker!r}"
                    )
        raise TimeoutError(f"did not observe {marker!r}; tail={retained[-4096:]!r}")

    def drain(
        self, duration: float = 0.05, *, retain_final_output: bool = False
    ) -> int:
        deadline = time.monotonic() + duration
        total = len(self.pending_read)
        if retain_final_output and self.pending_read:
            self.final_output = (self.final_output + self.pending_read)[
                -FINAL_PTY_OUTPUT_BYTES:
            ]
        self.pending_read = b""
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.descriptor], [], [], 0.005)
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
            if retain_final_output:
                self.final_output = (self.final_output + data)[-FINAL_PTY_OUTPUT_BYTES:]
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
        self.pending_receipt: bytes | None = None

    def read_interaction(
        self,
        client: PtyProcess,
        receipt_marker: bytes,
        visible_marker: bytes,
        timeout: float,
        started_ns: int,
    ) -> tuple[int, int, int]:
        deadline = time.monotonic() + timeout
        receipt_latency: int | None = None
        visible_latency: int | None = None
        output_bytes = 0
        retained = b""
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            readable, _, _ = select.select(
                [self.descriptor, client.descriptor], [], [], min(remaining, 0.02)
            )
            if self.descriptor in readable:
                received = self.descriptor.recv(4 * 1024)
                if received == receipt_marker and receipt_latency is None:
                    receipt_latency = time.monotonic_ns() - started_ns
                elif (
                    received == LATENCY_NEXT_READY
                    and receipt_latency is not None
                    and self.pending_receipt is None
                ):
                    self.pending_receipt = received
                else:
                    raise RuntimeError(
                        f"unexpected PTY receipt: expected={receipt_marker!r} actual={received!r}"
                    )
            if client.descriptor in readable:
                try:
                    data = os.read(client.descriptor, 64 * 1024)
                except BlockingIOError:
                    data = b""
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    output_bytes += len(data)
                    retained = (retained + data)[-(len(visible_marker) + 64 * 1024) :]
                    if visible_marker in retained and visible_latency is None:
                        visible_latency = time.monotonic_ns() - started_ns
            if receipt_latency is not None and visible_latency is not None:
                return receipt_latency, visible_latency, output_bytes
        raise TimeoutError(
            f"incomplete interaction for {receipt_marker!r}; "
            f"receipt={receipt_latency is not None} visible={visible_latency is not None}"
        )

    def wait_for_receipt(self, expected: bytes, timeout: float) -> None:
        if self.pending_receipt is not None:
            received = self.pending_receipt
            self.pending_receipt = None
            if received != expected:
                raise RuntimeError(
                    f"unexpected PTY receipt: expected={expected!r} actual={received!r}"
                )
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            readable, _, _ = select.select(
                [self.descriptor], [], [], min(remaining, 0.02)
            )
            if not readable:
                continue
            received = self.descriptor.recv(4 * 1024)
            if received != expected:
                raise RuntimeError(
                    f"unexpected PTY receipt: expected={expected!r} actual={received!r}"
                )
            return
        raise TimeoutError(f"did not receive PTY readiness receipt {expected!r}")

    def close(self) -> None:
        self.descriptor.close()
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


class MuxRuntime(Protocol):
    multiplexer: str
    version: str
    peer_path: Path
    gate_path: Path
    receipt_path: Path
    clients: list[PtyProcess]

    def attach(self, session: str) -> PtyProcess: ...

    def start_and_attach(self, session: str) -> PtyProcess: ...

    def start_detached_with_attach_marker(self, session: str) -> None: ...

    def detach(self, client: PtyProcess, session: str) -> None: ...

    def resource_roots(self) -> list[int]: ...

    def resource_role_pids(self) -> dict[str, list[int]]: ...

    def unavailable_resource_roles(self) -> dict[str, str]: ...

    def binary_provenance(self) -> dict[str, str]: ...

    def close(self) -> None: ...


def retain_attach_marker(runtime: MuxRuntime, session: str) -> None:
    validation_client = runtime.attach(session)
    validation_client.read_until(ATTACH_VISIBLE_MARKER, 5.0)
    runtime.detach(validation_client, session)


class LemmaRuntime:
    multiplexer = "lemma"
    version = "development"

    def __init__(
        self, server: Path, cli: Path, peer: Path, trace_directory: Path | None = None
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="lemma-benchmark-")
        root = Path(self.temporary.name)
        self.socket_path = root / "daemon.sock"
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.server_path = server.resolve()
        self.cli_path = cli.resolve()
        self.peer_path = peer.resolve()
        self.environment = benchmark_environment(root)
        if trace_directory is not None:
            self.environment["LEMMA_LATENCY_TRACE"] = str(trace_directory.resolve())
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
            [str(self.cli_path), str(self.socket_path), "attach", session],
            self.environment,
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        self.command("start", session)
        return self.attach(session)

    def start_detached_with_attach_marker(self, session: str) -> None:
        install_attach_shell_startup(self.environment, self.peer_path)
        self.command("start", session)
        retain_attach_marker(self, session)

    def detach(self, client: PtyProcess, session: str) -> None:
        client.write_all(b"\x02d", 2.0)
        client.wait_for_exit(5.0)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if ", detached," in self.command("list", session).stdout:
                return
            time.sleep(0.005)
        raise TimeoutError("Lemma validation client did not detach")

    def resource_roots(self) -> list[int]:
        return [self.server.pid, *(client.pid for client in self.clients if client.pid > 0)]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": [self.server.pid],
            "attached_client": [client.pid for client in self.clients if client.pid > 0],
        }

    def unavailable_resource_roles(self) -> dict[str, str]:
        return {"extension_host": "benchmark server explicitly disables extensions"}

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
        for _ in range(20):
            try:
                self.temporary.cleanup()
                return
            except OSError:
                time.sleep(0.01)
        shutil.rmtree(self.temporary.name, ignore_errors=True)


class TmuxRuntime:
    multiplexer = "tmux"

    def __init__(
        self, executable: Path, peer: Path, trace_directory: Path | None = None
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="tmux-benchmark-")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.socket_path = root / "tmux.sock"
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.environment = benchmark_environment(root)
        if trace_directory is not None:
            self.environment["LEMMA_LATENCY_TRACE"] = str(trace_directory.resolve())
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

    def attach(self, session: str) -> PtyProcess:
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
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        self._command("new-session", "-d", "-s", session, "-x", "80", "-y", "24")
        if self.server_pid < 0:
            self.server_pid = int(self._command("display-message", "-p", "#{pid}").stdout.strip())
        return self.attach(session)

    def start_detached_with_attach_marker(self, session: str) -> None:
        install_attach_shell_startup(self.environment, self.peer_path)
        self._command("new-session", "-d", "-s", session, "-x", "80", "-y", "24")
        if self.server_pid < 0:
            self.server_pid = int(self._command("display-message", "-p", "#{pid}").stdout.strip())
        retain_attach_marker(self, session)

    def detach(self, client: PtyProcess, session: str) -> None:
        client.write_all(b"\x02d", 2.0)
        client.wait_for_exit(5.0)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            attached = self._command(
                "display-message", "-p", "-t", session, "#{session_attached}"
            ).stdout.strip()
            if attached == "0":
                return
            time.sleep(0.005)
        raise TimeoutError("tmux validation client did not detach")

    def resource_roots(self) -> list[int]:
        return [self.server_pid, *(client.pid for client in self.clients if client.pid > 0)]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": [self.server_pid],
            "attached_client": [client.pid for client in self.clients if client.pid > 0],
        }

    def unavailable_resource_roles(self) -> dict[str, str]:
        return {"extension_host": "tmux adapter has no Lemma extension host"}

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
        for _ in range(20):
            try:
                self.temporary.cleanup()
                return
            except OSError:
                time.sleep(0.01)
        shutil.rmtree(self.temporary.name, ignore_errors=True)


class ZellijRuntime:
    multiplexer = "zellij"

    def __init__(
        self, executable: Path, peer: Path, trace_directory: Path | None = None
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="zellij-benchmark-")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.environment = benchmark_environment(root)
        if trace_directory is not None:
            self.environment["LEMMA_LATENCY_TRACE"] = str(trace_directory.resolve())
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

    def attach(self, session: str) -> PtyProcess:
        mapped_session = self.session_prefix + session.replace("_", "-")
        client = PtyProcess(self._arguments("attach", mapped_session), self.environment)
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        mapped_session = self.session_prefix + session.replace("_", "-")
        self._command("attach", "--create-background", mapped_session)
        self.sessions.append(mapped_session)
        return self.attach(session)

    def start_detached_with_attach_marker(self, session: str) -> None:
        install_attach_shell_startup(self.environment, self.peer_path)
        mapped_session = self.session_prefix + session.replace("_", "-")
        self._command("attach", "--create-background", mapped_session)
        self.sessions.append(mapped_session)
        retain_attach_marker(self, session)

    def detach(self, client: PtyProcess, session: str) -> None:
        del session
        client.write_all(b"\x0fd", 2.0)
        client.wait_for_exit(5.0)

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
        return [*self._server_pids(), *(client.pid for client in self.clients if client.pid > 0)]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": self._server_pids(),
            "attached_client": [client.pid for client in self.clients if client.pid > 0],
        }

    def unavailable_resource_roles(self) -> dict[str, str]:
        return {"extension_host": "Zellij adapter has no Lemma extension host"}

    def binary_provenance(self) -> dict[str, str]:
        return {"multiplexer": str(self.executable_path), "workload": str(self.peer_path)}

    def close(self) -> None:
        for client in self.clients:
            client.close()
        self.clients.clear()
        server_pids = self._server_pids()
        for session in self.sessions:
            try:
                self._command("kill-session", session, check=False)
            except subprocess.SubprocessError:
                pass
        self.sessions.clear()
        deadline = time.monotonic() + 0.5
        remaining = set(server_pids)
        while remaining and time.monotonic() < deadline:
            for pid in tuple(remaining):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    remaining.remove(pid)
            if remaining:
                time.sleep(0.01)
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 0.5
        while remaining and time.monotonic() < deadline:
            for pid in tuple(remaining):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    remaining.remove(pid)
            if remaining:
                time.sleep(0.01)
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
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


def attach_to_visible(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    latencies: list[int] = []
    client_bytes: list[int] = []
    for index in range(repetitions):
        # The startup fixture remains foreground. An untimed validation attach observes its marker
        # and detaches cleanly before start_detached_with_attach_marker returns, proving that the
        # canonical retained screen is ready before this measured attach begins.
        session = f"attach_visible_{index}"
        runtime.start_detached_with_attach_marker(session)

        started_ns = time.monotonic_ns()
        client = runtime.attach(session)
        latency, output_bytes = client.read_until(
            ATTACH_VISIBLE_MARKER, 5.0, started_ns=started_ns
        )
        latencies.append(latency)
        client_bytes.append(output_bytes)
        client.close()
        time.sleep(0.05)
    return {
        "status": "completed",
        **summary(latencies),
        "client_bytes": client_bytes,
        "median_client_bytes": percentile(client_bytes, 0.50),
    }


def latency_samples(
    client: PtyProcess,
    receipts: PtyReceiptChannel,
    label: str,
    repetitions: int,
    *,
    wait_for_peer_ready: bool = False,
) -> dict[str, Any]:
    key_to_pty: list[int] = []
    key_to_visible: list[int] = []
    client_bytes: list[int] = []
    for index in range(repetitions):
        marker = interaction_marker(label, index)
        visible_token = interaction_visible_token(label, index)
        started_ns = time.monotonic_ns()
        client.write_all(marker + b"\n", 2.0)
        pty_latency, visible_latency, output_bytes = receipts.read_interaction(
            client, marker, visible_token, 5.0, started_ns
        )
        key_to_pty.append(pty_latency)
        key_to_visible.append(visible_latency)
        client_bytes.append(output_bytes)
        client.drain(0.01)
        if wait_for_peer_ready:
            receipts.wait_for_receipt(LATENCY_NEXT_READY, 1.0)
    return {
        "key_to_pty": summary(key_to_pty),
        "key_to_visible": summary(key_to_visible),
        "client_bytes": client_bytes,
        "median_client_bytes": percentile(client_bytes, 0.50),
    }


def interactive_under_output(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    receipts = PtyReceiptChannel(runtime.receipt_path)
    try:
        client = runtime.start_and_attach("interactive_output")
        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency-output "
            f"{shlex.quote(str(runtime.receipt_path))}\r"
        ).encode()
        client.write_all(launch, 2.0)
        client.read_until(LATENCY_OUTPUT_READY, 5.0)
        client.drain(0.01)
        return {
            "status": "completed",
            **latency_samples(
                client, receipts, "OUTPUT", repetitions, wait_for_peer_ready=True
            ),
        }
    finally:
        receipts.close()


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


def component_resources(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if not isinstance(runtime, LemmaRuntime):
        raise TypeError("component resources require Lemma")
    baseline = sample_resources(runtime, repetitions)
    runtime.command("start", "component_resources")
    detached = sample_resources(runtime, repetitions)
    client = runtime.attach("component_resources")
    client.drain()
    attached = sample_resources(runtime, repetitions, client)
    runtime.detach(client, "component_resources")
    detached_after_attach = sample_resources(runtime, repetitions)
    return {
        "status": "completed",
        "baseline": baseline,
        "detached_session": detached,
        "attached_session": attached,
        "detached_after_attach": detached_after_attach,
    }


def history_resources(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if not isinstance(runtime, LemmaRuntime):
        raise TypeError("history resources require Lemma")
    client = runtime.start_and_attach("history_resources")
    client.drain()
    empty = sample_resources(runtime, repetitions, client)
    command = f"{shlex.quote(str(runtime.peer_path))} warm-scroll\r".encode()
    client.write_all(command, 2.0)
    client.read_until(WARM_MARKER, 60.0)
    client.drain()
    populated = sample_resources(runtime, repetitions, client)
    return {
        "status": "completed",
        "history_input_rows": 25_000,
        "terminal_history_quota_bytes": 10_000,
        "empty": empty,
        "populated": populated,
    }


def blocked_client(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if not isinstance(runtime, LemmaRuntime):
        raise TypeError("blocked-client workload requires Lemma")
    receipts = PtyReceiptChannel(runtime.receipt_path)
    blocked: socket.socket | None = None
    try:
        runtime.command("start", "blocked_client")
        responsive = runtime.start_and_attach("responsive_client_peer")
        receipt_launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency "
            f"{shlex.quote(str(runtime.receipt_path))}\r"
        ).encode()
        responsive.write_all(receipt_launch, 2.0)
        responsive.read_until(LATENCY_READY, 5.0)
        responsive.drain(0.01)
        idle = latency_samples(responsive, receipts, "CLIENT_IDLE", repetitions)

        blocked = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        blocked.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1_024)
        blocked.settimeout(5.0)
        blocked.connect(str(runtime.socket_path))
        session = b"blocked_client"
        hello_payload = bytes((len(session),)) + struct.pack("!HH", 500, 200) + b"\0" + session
        blocked.sendall(attach_frame(ATTACH_KIND_HELLO, hello_payload, 1))
        receive_attach_hello(blocked)
        flood_command = b"exec yes __LEMMA_BLOCKED_CLIENT_FLOOD__\r"
        blocked.sendall(attach_frame(ATTACH_KIND_INPUT, flood_command, 2))
        blocked_since_ns = time.monotonic_ns()
        time.sleep(0.05)

        under_backpressure = latency_samples(
            responsive, receipts, "CLIENT_BLOCKED", repetitions
        )
        disconnect_deadline_ns = blocked_since_ns + BLOCKED_CLIENT_DISCONNECT_DEADLINE_NS
        while time.monotonic_ns() <= disconnect_deadline_ns:
            if ", detached," in runtime.command("list", "blocked_client").stdout:
                break
            responsive.drain(0.005)
            time.sleep(0.01)
        else:
            raise TimeoutError(
                "blocked attached client exceeded its no-progress disconnect bound"
            )
        disconnect_latency_ns = time.monotonic_ns() - blocked_since_ns
        if disconnect_latency_ns > BLOCKED_CLIENT_DISCONNECT_DEADLINE_NS:
            raise TimeoutError(
                "blocked attached client was observed detached after its no-progress "
                f"disconnect bound: {disconnect_latency_ns}ns > "
                f"{BLOCKED_CLIENT_DISCONNECT_DEADLINE_NS}ns"
            )

        return {
            "status": "completed",
            "receive_buffer_bytes": 4 * 1_024,
            "disconnect_latency_ns": disconnect_latency_ns,
            "idle": idle,
            "blocked_other_session": under_backpressure,
        }
    finally:
        if blocked is not None:
            blocked.close()
        receipts.close()


def wait_for_profile_panes(
    runtime: LemmaRuntime | TmuxRuntime,
    client: PtyProcess,
    session: str,
    panes: int,
) -> None:
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        client.drain(0.005)
        if isinstance(runtime, LemmaRuntime):
            reached = f", {panes} pane(s)," in runtime.command("list", session).stdout
        else:
            listing = runtime._command(
                "list-panes", "-a", "-t", session, "-F", "#{pane_id}"
            ).stdout
            reached = len(listing.splitlines()) == panes
        if reached:
            return
        time.sleep(0.005)
    raise TimeoutError(f"{runtime.multiplexer} did not reach {panes} panes")


def send_prefix(client: PtyProcess, command: bytes) -> None:
    client.write_all(b"\x02" + command, 2.0)


def launch_latency_peer(
    runtime: LemmaRuntime | TmuxRuntime,
    client: PtyProcess,
    autonomous_output: bool,
) -> None:
    mode = "latency-output" if autonomous_output else "latency"
    ready = LATENCY_OUTPUT_READY if autonomous_output else LATENCY_READY
    command = (
        f"exec {shlex.quote(str(runtime.peer_path))} {mode} "
        f"{shlex.quote(str(runtime.receipt_path))}\r"
    ).encode()
    client.write_all(command, 2.0)
    client.read_until(ready, 5.0)
    client.drain(0.005)


def build_profile(
    runtime: LemmaRuntime | TmuxRuntime,
    client: PtyProcess,
    panes: int,
    session: str = "profile",
) -> None:
    pane_index = 1
    tab_count = 1 if panes == 1 else panes // 4
    for tab_index in range(tab_count):
        if panes == 1:
            return

        send_prefix(client, b"%")
        pane_index += 1
        wait_for_profile_panes(runtime, client, session, pane_index)

        send_prefix(client, b'"')
        pane_index += 1
        wait_for_profile_panes(runtime, client, session, pane_index)

        send_prefix(client, b"o")
        send_prefix(client, b'"')
        pane_index += 1
        wait_for_profile_panes(runtime, client, session, pane_index)

        if tab_index + 1 < tab_count:
            send_prefix(client, b"c")
            wait_for_profile_panes(runtime, client, session, pane_index + 1)
            pane_index += 1


def pane_profile(
    runtime: LemmaRuntime | TmuxRuntime,
    profile: str,
    panes: int,
    active: bool,
    repetitions: int,
) -> dict[str, Any]:
    receipts = PtyReceiptChannel(runtime.receipt_path)
    try:
        client = runtime.start_and_attach("profile")
        build_profile(runtime, client, panes)
        if not active:
            resources = sample_resources(runtime, repetitions, client)
            launch_latency_peer(runtime, client, False)
        else:
            launch_latency_peer(runtime, client, True)
            resources = sample_resources(runtime, repetitions, client)
        interaction = latency_samples(
            client,
            receipts,
            f"{profile}_{'ACTIVE' if active else 'IDLE'}",
            repetitions,
            wait_for_peer_ready=active,
        )
        return {
            "status": "completed",
            "panes": panes,
            "activity": "active" if active else "idle",
            "resources": resources,
            "interaction": interaction,
        }
    finally:
        receipts.close()


def lifecycle_churn(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if not isinstance(runtime, LemmaRuntime):
        raise TypeError("lifecycle churn requires Lemma")
    baseline = runtime_resource_snapshot(runtime)
    if baseline.get("available") is not True:
        raise RuntimeError("lifecycle churn baseline resource snapshot is unavailable")
    baseline_descriptors = open_descriptor_snapshot(runtime.server.pid)
    if baseline_descriptors.get("available") is not True:
        raise RuntimeError("lifecycle churn descriptor baseline is unavailable")

    tree_rss: list[int] = []
    daemon_rss: list[int] = []
    process_counts: list[int] = []
    descriptor_counts: list[int] = []
    focused_pids: list[int] = []
    restored_clients = 0
    for _ in range(repetitions):
        runtime.command("start", "lifecycle_churn")
        client = runtime.attach("lifecycle_churn")
        build_profile(runtime, client, 4, "lifecycle_churn")
        listing = runtime.command("list", "lifecycle_churn").stdout
        try:
            focused_pid = int(listing.split("focused pid ", 1)[1].split(",", 1)[0])
        except (IndexError, ValueError) as error:
            raise RuntimeError("lifecycle churn could not identify its live pane") from error
        if focused_pid <= 0:
            raise RuntimeError("lifecycle churn observed an invalid focused pane identity")
        focused_pids.append(focused_pid)
        for expected in (3, 2, 1):
            send_prefix(client, b"x")
            wait_for_profile_panes(runtime, client, "lifecycle_churn", expected)
        runtime.detach(client, "lifecycle_churn")
        if client.terminal_state_restored is not True:
            raise RuntimeError("lifecycle churn leaked attached-client terminal state")
        restored_clients += 1
        runtime.command("kill", "lifecycle_churn")
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            listing = runtime.command("list").stdout
            if "lifecycle_churn" not in listing:
                break
            time.sleep(0.005)
        else:
            raise TimeoutError("lifecycle churn session was not reclaimed")
        snapshot = runtime_resource_snapshot(runtime)
        if snapshot.get("available") is not True:
            raise RuntimeError("lifecycle churn resource snapshot is unavailable")
        daemon = snapshot.get("roles", {}).get("daemon", {})
        if daemon.get("available") is not True:
            raise RuntimeError("lifecycle churn daemon snapshot is unavailable")
        descriptor_snapshot = open_descriptor_snapshot(runtime.server.pid)
        if descriptor_snapshot.get("available") is not True:
            raise RuntimeError("lifecycle churn descriptor snapshot is unavailable")
        process_count = int(snapshot["process_count"])
        descriptor_count = int(descriptor_snapshot["count"])
        if process_count != int(baseline["process_count"]):
            raise RuntimeError("lifecycle churn left a pane or client process live")
        if descriptor_count != int(baseline_descriptors["count"]):
            raise RuntimeError("lifecycle churn leaked a daemon descriptor")
        tree_rss.append(int(snapshot["rss_bytes"]))
        daemon_rss.append(int(daemon["rss_bytes"]))
        process_counts.append(process_count)
        descriptor_counts.append(descriptor_count)

    plateau_cycles = min(100, max(25, repetitions // 10))
    plateau: dict[str, Any]
    if repetitions >= plateau_cycles * 2:
        preceding = daemon_rss[-(plateau_cycles * 2) : -plateau_cycles]
        final = daemon_rss[-plateau_cycles:]
        final_range = max(final) - min(final)
        preceding_p95 = percentile(preceding, 0.95)
        final_p95 = percentile(final, 0.95)
        x_mean = (plateau_cycles - 1) / 2
        denominator = sum((index - x_mean) ** 2 for index in range(plateau_cycles))
        final_mean = sum(final) / len(final)
        numerator = sum(
            (index - x_mean) * (value - final_mean)
            for index, value in enumerate(final)
        )
        slope = numerator / denominator
        plateau = {
            "evaluated": True,
            "window_cycles": plateau_cycles,
            "preceding_p95_bytes": preceding_p95,
            "final_p95_bytes": final_p95,
            "final_range_bytes": final_range,
            "final_slope_bytes_per_cycle": slope,
            "maximum_final_range_bytes": 2 * 1_024 * 1_024,
            "maximum_p95_growth_bytes": 1 * 1_024 * 1_024,
            "maximum_final_slope_bytes_per_cycle": 4_096,
        }
        if (
            final_range > plateau["maximum_final_range_bytes"]
            or final_p95 > preceding_p95 + plateau["maximum_p95_growth_bytes"]
            or slope > plateau["maximum_final_slope_bytes_per_cycle"]
        ):
            raise RuntimeError("lifecycle churn did not return to a bounded memory plateau")
    else:
        plateau = {
            "evaluated": False,
            "reason": f"at least {plateau_cycles * 2} cycles are required",
        }

    return {
        "status": "completed",
        "cycles": repetitions,
        "operations_per_cycle": ["create", "attach", "split", "close", "detach", "kill"],
        "identity_check": (
            "each incarnation exposed a positive live focused pane PID and the reused session "
            "name was absent before the next create"
        ),
        "focused_pids": focused_pids,
        "terminal_restorations": restored_clients,
        "tree_rss": metric_summary(tree_rss, "bytes"),
        "daemon_rss": metric_summary(daemon_rss, "bytes"),
        "process_counts": metric_summary(process_counts, "count"),
        "daemon_open_descriptors": {
            "source": baseline_descriptors["source"],
            **metric_summary(descriptor_counts, "count"),
        },
        "memory_plateau": plateau,
    }


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


def latency_trace_metadata(directory: Path | None) -> dict[str, Any]:
    if directory is None:
        return {
            "requested": False,
            "available": False,
            "reason": "benchmark tracing was not requested",
        }
    files = []
    total_events = 0
    total_dropped = 0
    header = struct.Struct("<QIHHIIQQ24x")
    for path in sorted(directory.glob("*.ltrace")):
        try:
            encoded = path.read_bytes()
            magic, version, role, event_size, capacity, process, count, dropped = header.unpack_from(
                encoded
            )
        except (OSError, struct.error) as error:
            files.append({"path": str(path), "valid": False, "error": str(error)})
            continue
        valid = (
            magic == 0x3145_4341_5254_4D4C
            and version == 2
            and role in (1, 2)
            and event_size == 40
            and process > 0
            and count <= capacity == 32_768
            and encoded[40 : header.size] == bytes(header.size - 40)
            and len(encoded) == header.size + (capacity * event_size)
        )
        files.append(
            {
                "path": str(path),
                "valid": valid,
                "role": role,
                "process": process,
                "events": count,
                "dropped": dropped,
            }
        )
        if valid:
            total_events += count
            total_dropped += dropped
    return {
        "requested": True,
        "available": bool(files) and all(item.get("valid") is True for item in files),
        "reason": None if files else "trace-enabled binaries produced no trace files",
        "event_capacity_per_process": 32_768,
        "events": total_events,
        "dropped": total_dropped,
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=(
            "warm-scroll",
            "attach-visible",
            "interactive-output",
            "idle-resources",
            "blocked-pty",
            "blocked-client",
            "component-resources",
            "history-resources",
            "lifecycle-churn",
            "comparison",
            "profiles",
            "all",
        ),
        default="comparison",
    )
    parser.add_argument("--multiplexer", choices=("lemma", "tmux", "zellij"), default="lemma")
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--server", type=Path, default=Path("build/release/lemma_test_server"))
    parser.add_argument("--cli", type=Path, default=Path("build/release/lemma_test_cli"))
    parser.add_argument("--peer", type=Path, default=Path("build/release/lemma_test_pty_peer"))
    parser.add_argument("--tmux", type=Path, default=Path("tmux"))
    parser.add_argument("--zellij", type=Path, default=Path("zellij"))
    parser.add_argument("--trace-directory", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--allow-workload-failures",
        action="store_true",
        help="record competitor workload failures instead of failing the harness",
    )
    arguments = parser.parse_args()
    if arguments.repetitions < 1 or arguments.repetitions > 1_000:
        parser.error("--repetitions must be between 1 and 1000")
    if arguments.mode in {"comparison", "all", "attach-visible"}:
        account_shell = account_login_shell()
        if Path(account_shell).name not in ATTACH_STARTUP_SHELLS:
            parser.error(
                f"attach-to-visible does not support account login shell {account_shell!r}"
            )
    if not arguments.peer.is_file():
        parser.error(f"missing executable: {arguments.peer}")
    if arguments.mode in ("profiles", "all") and arguments.multiplexer == "zellij":
        parser.error("pane profiles currently require --multiplexer lemma or tmux")
    if (
        arguments.mode
        in {
            "blocked-client",
            "component-resources",
            "history-resources",
            "lifecycle-churn",
        }
        and arguments.multiplexer != "lemma"
    ):
        parser.error(f"{arguments.mode} currently requires --multiplexer lemma")
    if arguments.trace_directory is not None:
        arguments.trace_directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        if any(arguments.trace_directory.glob("*.ltrace")):
            parser.error("--trace-directory must not contain existing .ltrace files")

    build_profile: str | None = None
    tmux: Path | None = None
    zellij: Path | None = None
    if arguments.multiplexer == "lemma":
        for executable in (arguments.server, arguments.cli):
            if not executable.is_file():
                parser.error(f"missing executable: {executable}")
        build_profile = arguments.server.parent.name
    elif arguments.multiplexer == "tmux":
        tmux = Path(shutil.which(str(arguments.tmux)) or arguments.tmux)
        if not tmux.is_file():
            parser.error(f"missing executable: {arguments.tmux}")
    else:
        zellij = Path(shutil.which(str(arguments.zellij)) or arguments.zellij)
        if not zellij.is_file():
            parser.error(f"missing executable: {arguments.zellij}")

    def create_runtime() -> MuxRuntime:
        if arguments.multiplexer == "lemma":
            return LemmaRuntime(
                arguments.server, arguments.cli, arguments.peer, arguments.trace_directory
            )
        if arguments.multiplexer == "tmux":
            assert tmux is not None
            return TmuxRuntime(tmux, arguments.peer)
        assert zellij is not None
        return ZellijRuntime(zellij, arguments.peer)

    workloads: dict[str, Any] = {}
    pane_profiles: dict[str, Any] = {}
    runtime_version = "unknown"
    binary_provenance: dict[str, str] = {}

    def run_operation(
        operation: Callable[[MuxRuntime, int], dict[str, Any]],
        repetitions: int | None = None,
    ) -> dict[str, Any]:
        nonlocal runtime_version, binary_provenance
        runtime: MuxRuntime | None = None
        try:
            runtime = create_runtime()
            runtime_version = runtime.version
            binary_provenance = runtime.binary_provenance()
            result = operation(
                runtime, arguments.repetitions if repetitions is None else repetitions
            )
            result["resources_after_workload"] = runtime_resource_snapshot(runtime)
            return result
        except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
            if not arguments.allow_workload_failures:
                raise
            return {
                "status": "failed",
                "error": f"{type(error).__name__}: {error}",
            }
        finally:
            if runtime is not None:
                runtime.close()

    selected: list[tuple[str, Callable[[MuxRuntime, int], dict[str, Any]]]] = []
    comparison_workloads = [
        ("warm_scroll", warm_scroll),
        ("attach_to_visible", attach_to_visible),
        ("interactive_under_output", interactive_under_output),
        ("idle_resources", idle_resources),
        ("blocked_pty", blocked_pty),
    ]
    if arguments.mode in ("comparison", "all"):
        selected.extend(comparison_workloads)
        if arguments.multiplexer == "lemma":
            selected.append(("blocked_client", blocked_client))
    else:
        individual = {
            "warm-scroll": ("warm_scroll", warm_scroll),
            "attach-visible": ("attach_to_visible", attach_to_visible),
            "interactive-output": ("interactive_under_output", interactive_under_output),
            "idle-resources": ("idle_resources", idle_resources),
            "blocked-pty": ("blocked_pty", blocked_pty),
            "blocked-client": ("blocked_client", blocked_client),
            "component-resources": ("component_resources", component_resources),
            "history-resources": ("history_resources", history_resources),
            "lifecycle-churn": ("lifecycle_churn", lifecycle_churn),
        }
        if arguments.mode in individual:
            selected.append(individual[arguments.mode])
    for name, operation in selected:
        if name != "attach_to_visible":
            workloads[name] = run_operation(operation)
            continue

        attach_samples: list[int] = []
        attach_bytes: list[int] = []
        resources_after_workload: dict[str, Any] | None = None
        attach_failure: dict[str, Any] | None = None
        for repetition in range(arguments.repetitions):
            result = run_operation(operation, 1)
            if result.get("status") != "completed":
                attach_failure = {
                    **result,
                    "completed_repetitions": repetition,
                }
                break
            attach_samples.extend(result["samples_ns"])
            attach_bytes.extend(result["client_bytes"])
            resources_after_workload = result.get("resources_after_workload")
        if attach_failure is not None:
            workloads[name] = attach_failure
        else:
            workloads[name] = {
                "status": "completed",
                **summary(attach_samples),
                "client_bytes": attach_bytes,
                "median_client_bytes": percentile(attach_bytes, 0.50),
                "resources_after_workload": resources_after_workload,
            }

    if arguments.mode in ("profiles", "all"):
        for profile, panes in (("P1", 1), ("P4", 4), ("P16", 16), ("PMAX", 64)):
            pane_profiles[profile] = {}
            for activity in (False, True):
                key = "active" if activity else "idle"

                def profile_operation(
                    runtime: MuxRuntime,
                    repetitions: int,
                    *,
                    profile_id: str = profile,
                    pane_count: int = panes,
                    active: bool = activity,
                ) -> dict[str, Any]:
                    if not isinstance(runtime, (LemmaRuntime, TmuxRuntime)):
                        raise TypeError("pane profile requires Lemma or tmux runtime")
                    return pane_profile(runtime, profile_id, pane_count, active, repetitions)

                pane_profiles[profile][key] = run_operation(profile_operation)

    commit, worktree_dirty = git_provenance()
    report = {
        "schema": 4,
        "suite": "core-mux-baseline",
        "multiplexer": arguments.multiplexer,
        "multiplexer_version": runtime_version,
        "commit": commit,
        "worktree_dirty": worktree_dirty,
        "host": platform.node(),
        "host_fingerprint": host_fingerprint(),
        "system": platform.system(),
        "system_release": platform.release(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "terminal": {"columns": 80, "rows": 24, "term": "xterm-256color"},
        "repetitions": arguments.repetitions,
        "binaries": binary_provenance,
        "build_profile": build_profile,
        "latency_trace": latency_trace_metadata(arguments.trace_directory),
        "private_attach_framing": (
            {
                "version": "1.0",
                "envelope_bytes_per_message": ATTACH_HEADER_BYTES,
                "render_generation_bytes_per_frame": 4,
                "render_wire_overhead_bytes_per_frame": ATTACH_HEADER_BYTES + 4,
                "client_bytes_metric_excludes_private_framing": True,
            }
            if arguments.multiplexer == "lemma"
            else None
        ),
        "workloads": workloads,
        "pane_profiles": pane_profiles,
    }

    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
