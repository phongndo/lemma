#!/usr/bin/env python3
"""Bounded process-level core-mux workloads with identical completion semantics."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import platform
import pwd
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.benchmark_manifest import (  # noqa: E402
    ManifestError,
    expected_failure,
    load_manifest,
    suite_workloads,
    workload_for_mode,
)
from tests.support.pty_process import PtyProcess  # noqa: E402

ALT_SCREEN = b"\x1b[?1049h"
# Exact outer-terminal cleanup emitted by src/client/attached_client.cpp.
LEMMA_OUTER_TERMINAL_RESTORE = (
    b"\x1b[0m\x1b[?2026l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l"
    b"\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l"
    b"\x1b[?2004l\x1b]112\x1b\\\x1b[0 q\x1b[?25h\x1b[?7h\x1b[<u\x1b[?1049l"
)
WARM_MARKER = b"__LEMMA_WARM_SCROLL_DONE__"
WARM_READY_MARKER = b"__LEMMA_WARM_SCROLL_READY__"
BLOCK_READY = b"__LEMMA_PTY_READY__"
BLOCK_DONE = b"__LEMMA_PTY_DONE__ bytes=2097152 digest=d939b04ca2c22325"
LATENCY_READY = b"__LEMMA_LATENCY_READY__"
LATENCY_OUTPUT_READY = b"__LEMMA_LATENCY_OUTPUT_READY__"
LATENCY_VISIBLE_ACK = b"__LEMMA_LATENCY_VISIBLE__"
LATENCY_NEXT_READY = b"__LEMMA_LATENCY_NEXT__"
TUI_REDRAW_READY = b"__LEMMA_TUI_REDRAW_READY__"
TUI_WHEEL_READY = b"__LEMMA_TUI_WHEEL_READY__"
IDLE_READY = b"__LEMMA_IDLE_READY__"
ATTACH_VISIBLE_MARKER = b"__LEMMA_ATTACH_VISIBLE__"
# Keep the first byte distinct from fixture markers. Differential terminal renderers can retain a
# shared prefix on screen without retransmitting it to an attached outer client.
SHELL_READY_MARKER = b"LEMMA-SHELL-READY"
ATTACH_MAGIC = b"\x89LMA"
ATTACH_PROTOCOL_MAJOR = 2
ATTACH_PROTOCOL_MINOR = 9
ATTACH_HEADER_BYTES = 16
ATTACH_KIND_HELLO = 1
ATTACH_KIND_INPUT = 2
PAYLOAD_SIZE = 2 * 1024 * 1024
TUI_WHEEL_BURST_SIZE = 64
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
HERDR_BENCHMARK_CONFIG = """onboarding = false

[update]
version_check = false
manifest_check = false

[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
pane_scrollbars = false
mouse_capture = false
redraw_on_focus_gained = false
confirm_close = false
prompt_new_tab_name = false
prompt_new_workspace_name = false

[ui.sound]
enabled = false

[experimental]
pane_history = false
"""


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


def linux_host_metadata(
    cpuinfo: str, meminfo: str, model_identifier: str | None
) -> dict[str, Any]:
    cpu_model: str | None = None
    physical_cores: set[tuple[str, str]] = set()
    for record in cpuinfo.split("\n\n"):
        fields = {
            key.strip(): value.strip()
            for line in record.splitlines()
            if ":" in line
            for key, value in (line.split(":", 1),)
        }
        cpu_model = cpu_model or fields.get("model name")
        if "physical id" in fields and "core id" in fields:
            physical_cores.add((fields["physical id"], fields["core id"]))
    memory_bytes: int | None = None
    for line in meminfo.splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[0] == "MemTotal:" and fields[2] == "kB":
            try:
                memory_bytes = int(fields[1]) * 1024
            except ValueError:
                pass
            break
    return {
        "model_identifier": model_identifier.strip() if model_identifier else None,
        "cpu_model": cpu_model,
        "physical_cpu_count": len(physical_cores) or None,
        "memory_bytes": memory_bytes,
    }


def host_fingerprint() -> dict[str, Any]:
    def integer_sysctl(name: str) -> int | None:
        value = darwin_sysctl(name)
        try:
            return int(value) if value is not None else None
        except ValueError:
            return None

    metadata: dict[str, Any]
    if platform.system() == "Linux":
        try:
            cpuinfo = Path("/proc/cpuinfo").read_text(encoding="utf-8")
            meminfo = Path("/proc/meminfo").read_text(encoding="utf-8")
        except OSError:
            cpuinfo = ""
            meminfo = ""
        try:
            model_identifier = Path("/sys/class/dmi/id/product_name").read_text(
                encoding="utf-8"
            )
        except OSError:
            model_identifier = None
        metadata = linux_host_metadata(cpuinfo, meminfo, model_identifier)
    else:
        metadata = {
            "model_identifier": darwin_sysctl("hw.model"),
            "cpu_model": darwin_sysctl("machdep.cpu.brand_string"),
            "physical_cpu_count": integer_sysctl("hw.physicalcpu"),
            "memory_bytes": integer_sysctl("hw.memsize"),
        }
    return {"host_name": platform.node(), **metadata}


def local_socket_peer_pid(path: Path) -> int:
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        peer.connect(str(path))
        if platform.system() == "Darwin":
            # Darwin's LOCAL_PEERPID is option 2 at SOL_LOCAL (level 0).
            encoded = peer.getsockopt(0, 2, struct.calcsize("i"))
            process = struct.unpack("i", encoded)[0]
        elif platform.system() == "Linux":
            # Linux exposes pid, uid, and gid through SO_PEERCRED.
            encoded = peer.getsockopt(
                socket.SOL_SOCKET,
                getattr(socket, "SO_PEERCRED", 17),
                struct.calcsize("3i"),
            )
            process, _, _ = struct.unpack("3i", encoded)
        else:
            raise RuntimeError("local socket peer PID is unsupported on this platform")
    finally:
        peer.close()
    if process <= 0:
        raise RuntimeError("local socket reported an invalid peer PID")
    return process


def attach_frame(kind: int, payload: bytes, sequence: int, flags: int = 0) -> bytes:
    if not 0 < sequence <= 0xFFFF_FFFF or len(payload) > 0xFFFF_FFFF:
        raise ValueError("private attach frame exceeds its wire bounds")
    return (
        struct.pack(
            "!4sBBBBII",
            ATTACH_MAGIC,
            ATTACH_PROTOCOL_MAJOR,
            ATTACH_PROTOCOL_MINOR,
            kind,
            flags,
            len(payload),
            sequence,
        )
        + payload
    )


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
    result = metric_summary(samples, "ns")
    result["p95_valid"] = len(samples) >= 20
    result["p99_valid"] = len(samples) >= 100
    return result


def executable_provenance(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    digest = hashlib.sha256()
    with resolved.open("rb") as executable:
        while chunk := executable.read(1024 * 1024):
            digest.update(chunk)
    status = resolved.stat()
    return {
        "path": str(resolved),
        "sha256": digest.hexdigest(),
        "bytes": status.st_size,
        "mtime_ns": status.st_mtime_ns,
    }


def interaction_label_codes() -> dict[str, bytes]:
    labels = [
        "OUTPUT",
        "OPEN",
        "TUI",
        "WHEEL",
        "IDLE",
        "BLOCKED",
        "CLIENT_IDLE",
        "CLIENT_BLOCKED",
    ]
    for profile in load_manifest()["pane_profiles"]:
        labels.extend((f"{profile['id']}_IDLE", f"{profile['id']}_ACTIVE"))
    if len(labels) > 26 * 26:
        raise RuntimeError("interaction labels exceed the native probe token space")
    return {
        label: bytes((ord("L"), ord("A") + index // 26, ord("A") + index % 26))
        for index, label in enumerate(labels)
    }


INTERACTION_LABEL_CODES = interaction_label_codes()


def interaction_visible_token(label: str, index: int) -> bytes:
    if not 0 <= index < 10_000 or label not in INTERACTION_LABEL_CODES:
        raise ValueError("interaction marker is outside its bounded token space")
    label_index = tuple(INTERACTION_LABEL_CODES).index(label)
    radix = 26
    token_space = radix**6
    redraw_multiplier = sum(radix**position for position in range(6))
    encoded_index = bytearray(6)
    remaining = ((label_index * 10_000 + index) * redraw_multiplier) % token_space
    for position in range(len(encoded_index) - 1, -1, -1):
        encoded_index[position] = ord("A") + (remaining % radix)
        remaining //= radix
    return bytes(encoded_index)


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


def install_shell_startup(
    environment: dict[str, str], command: str, *, nushell_command: str | None = None
) -> None:
    shell = Path(environment["SHELL"]).name
    home = Path(environment["HOME"])
    config = Path(environment["XDG_CONFIG_HOME"])
    zdot = Path(environment["ZDOTDIR"])
    if shell in {"sh", "dash", "ksh", "mksh"}:
        interactive_startup = config / "lemma" / "shell-startup.sh"
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
        command = nushell_command if nushell_command is not None else command
    else:
        raise RuntimeError(
            f"benchmark startup does not support account login shell {environment['SHELL']!r}"
        )
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(command, encoding="utf-8")


def benchmark_environment(root: Path) -> dict[str, str]:
    for name in ("home", "config", "zdot", "data"):
        (root / name).mkdir(mode=0o700)
    account_shell = account_login_shell()
    environment = {
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
    install_shell_startup(
        environment, f"printf '{SHELL_READY_MARKER.decode('ascii')}\\n'\n"
    )
    return environment


def install_attach_shell_startup(environment: dict[str, str], peer: Path) -> None:
    command = f"exec {shlex.quote(str(peer))} attach-visible\n"
    install_shell_startup(
        environment,
        command,
        nushell_command=f"exec {json.dumps(str(peer))} attach-visible\n",
    )


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
        resident_bytes = 0
        physical_footprint_bytes = 0
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
            resident_bytes += usage.resident_size
            physical_footprint_bytes += usage.physical_footprint
            sampled += 1
    except (AttributeError, OSError) as error:
        return {"available": False, "reason": str(error)}
    return {
        "available": sampled == len(pids),
        "source": "proc_pid_rusage RUSAGE_INFO_V0",
        "sampled_processes": sampled,
        "cpu_time_ns": cpu_time_ns,
        "resident_bytes": resident_bytes,
        "physical_footprint_bytes": physical_footprint_bytes,
        "package_idle": package_idle,
        "interrupt": interrupts,
        "total": package_idle + interrupts,
    }


def parse_linux_schedstat(value: str) -> int:
    fields = value.split()
    if len(fields) != 3 or any(
        not field.isascii() or not field.isdecimal() for field in fields
    ):
        raise ValueError("invalid /proc/PID/schedstat record")
    return int(fields[0])


def linux_cpu_snapshot(pids: set[int]) -> dict[str, Any]:
    if platform.system() != "Linux":
        return {"available": False, "reason": "not Linux"}
    if not pids:
        return {"available": False, "reason": "no processes to sample"}
    try:
        cpu_time_ns = 0
        sampled = 0
        for pid in pids:
            schedstat = Path(f"/proc/{pid}/schedstat").read_text(encoding="ascii")
            cpu_time_ns += parse_linux_schedstat(schedstat)
            sampled += 1
    except (OSError, ValueError) as error:
        return {"available": False, "reason": str(error)}
    return {
        "available": sampled == len(pids),
        "source": "/proc/PID/schedstat CPU runtime",
        "sampled_processes": sampled,
        "cpu_time_ns": cpu_time_ns,
    }


def linux_memory_snapshot(pids: set[int]) -> dict[str, Any]:
    if platform.system() != "Linux":
        return {"available": False, "reason": "not Linux"}
    if not pids:
        return {"available": False, "reason": "no processes to sample"}
    try:
        pss_bytes = 0
        private_bytes = 0
        sampled = 0
        for pid in pids:
            fields: dict[str, int] = {}
            for line in (
                Path(f"/proc/{pid}/smaps_rollup")
                .read_text(encoding="ascii")
                .splitlines()
            ):
                name, separator, value = line.partition(":")
                if not separator:
                    continue
                parts = value.split()
                if parts and parts[0].isdecimal():
                    fields[name] = int(parts[0]) * 1_024
            pss_bytes += fields["Pss"]
            private_bytes += fields.get("Private_Clean", 0) + fields.get(
                "Private_Dirty", 0
            )
            sampled += 1
    except (KeyError, OSError, ValueError) as error:
        return {"available": False, "reason": str(error)}
    return {
        "available": sampled == len(pids),
        "source": "/proc/PID/smaps_rollup",
        "sampled_processes": sampled,
        "physical_footprint_bytes": pss_bytes,
        "private_bytes": private_bytes,
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
                return {
                    "available": False,
                    "reason": "proc_pidinfo(PROC_PIDLISTFDS) failed",
                }
            if received == len(storage):
                return {
                    "available": False,
                    "reason": "descriptor census exceeded 4,096 entries",
                }
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
    linux_memory = linux_memory_snapshot(pids)
    native_cpu = (
        darwin_resources if darwin_resources.get("available") is True else linux_cpu
    )
    native_memory = (
        darwin_resources if darwin_resources.get("available") is True else linux_memory
    )
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
        "physical_footprint_bytes": (
            native_memory["physical_footprint_bytes"]
            if native_memory.get("available") is True
            else None
        ),
        "physical_footprint_source": (
            native_memory.get("source")
            if native_memory.get("available") is True
            else None
        ),
        "private_bytes": (
            native_memory.get("private_bytes")
            if native_memory.get("available") is True
            else None
        ),
        "cpu_time_ns": (
            native_cpu["cpu_time_ns"]
            if native_cpu.get("available") is True
            else sum(processes[pid][2] for pid in pids)
        ),
        "cpu_time_source": (
            native_cpu.get("source")
            if native_cpu.get("available") is True
            else "ps time"
        ),
        "wakeups": wakeups,
        "pids": sorted(pids),
    }


def resource_snapshot(
    root_pids: list[int],
    role_pids: dict[str, list[int]] | None = None,
) -> dict[str, Any]:
    """Capture role and process-tree CPU, RSS, physical footprint, and wakeups."""
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
    unclassified = selected.difference(classified)
    if unclassified:
        roles["pane_or_mux_children"] = process_group_snapshot(unclassified, processes)

    return {
        **total,
        "scope": "multiplexer direct roles and complete descendant process tree",
        "roles": roles,
    }


def runtime_resource_snapshot(runtime: MuxRuntime) -> dict[str, Any]:
    return resource_snapshot(runtime.resource_roots(), runtime.resource_role_pids())


def process_tree_diagnostic(root_pids: list[int]) -> str:
    try:
        output = subprocess.run(
            [
                "ps",
                "-e",
                "-o",
                "pid=,ppid=,pgid=,sid=,tpgid=,stat=,wchan:24=,cmd=",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout
    except (OSError, subprocess.SubprocessError) as error:
        return f"process census failed: {error}"
    records: list[tuple[int, int, str]] = []
    for line in output.splitlines():
        fields = line.split(maxsplit=2)
        try:
            if len(fields) == 3:
                records.append((int(fields[0]), int(fields[1]), line))
        except ValueError:
            continue
    selected = {process for process in root_pids if process > 0}
    changed = True
    while changed:
        changed = False
        for process, parent, _ in records:
            if process not in selected and parent in selected:
                selected.add(process)
                changed = True
    return "\n".join(line for process, _, line in records if process in selected)


def summarize_resource_samples(
    before_samples: list[dict[str, Any]], after_samples: list[dict[str, Any]]
) -> dict[str, Any]:
    if len(before_samples) != len(after_samples):
        raise RuntimeError("resource sample endpoints are unbalanced")
    cpu_samples = [
        max(0, int(after["cpu_time_ns"]) - int(before["cpu_time_ns"]))
        for before, after in zip(before_samples, after_samples)
    ]
    rss_samples = [int(after["rss_bytes"]) for after in after_samples]
    footprint_samples = [
        int(after["physical_footprint_bytes"])
        for after in after_samples
        if after.get("physical_footprint_bytes") is not None
    ]
    footprint_available = len(footprint_samples) == len(after_samples)
    wakeup_samples: list[int] = []
    wakeup_source: str | None = None
    wakeups_available = True
    for before, after in zip(before_samples, after_samples):
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
        "physical_footprint": {
            "available": footprint_available,
            "source": (
                after_samples[-1].get("physical_footprint_source")
                if footprint_available
                else None
            ),
            **(
                metric_summary(footprint_samples, "bytes")
                if footprint_available
                else {"samples_bytes": []}
            ),
        },
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
    # Readiness proves the fixture is running, but terminal projection and process accounting may
    # still contain that final setup mutation. Exclude one complete interval before opening the
    # first measured resource window.
    if client is None:
        time.sleep(sample_seconds)
    else:
        client.drain(sample_seconds)
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

    role_names: set[str] = set()
    for snapshot in (*before_samples, *after_samples):
        roles = snapshot.get("roles")
        if isinstance(roles, dict):
            for role in roles:
                if not isinstance(role, str):
                    raise RuntimeError("resource snapshot has a non-string role name")
                role_names.add(role)
    role_results: dict[str, Any] = {}
    for role in sorted(role_names):
        role_before = [
            snapshot.get("roles", {}).get(role, {}) for snapshot in before_samples
        ]
        role_after = [
            snapshot.get("roles", {}).get(role, {}) for snapshot in after_samples
        ]
        if all(
            sample.get("available") is True for sample in (*role_before, *role_after)
        ):
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


def screen_renders_markers(runtime: MuxRuntime) -> bool:
    return runtime.multiplexer in {"zellij", "herdr"}


def wait_for_shell_execution(
    runtime: MuxRuntime,
    client: PtyProcess,
    marker: bytes,
    command: bytes,
) -> None:
    if marker in command:
        raise ValueError("shell readiness marker must not appear in echoed input")
    client.write_all(command, 2.0)
    client.read_until(marker, 5.0, visible_text=screen_renders_markers(runtime))
    client.drain(0.005)


def idle_resources(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    client = runtime.start_and_attach("idle_resources")
    command = f"exec {shlex.quote(str(runtime.peer_path))} idle\r".encode()
    client.write_all(command, 2.0)
    client.read_until(IDLE_READY, 5.0, visible_text=screen_renders_markers(runtime))
    client.drain(0.01)
    return sample_resources(runtime, repetitions, client)


class PtyReceiptChannel:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.peer_path = Path(f"{path}.peer")
        self.descriptor = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            self.descriptor.bind(str(path))
        except BaseException:
            self.descriptor.close()
            raise
        self.descriptor.setblocking(False)

    def acknowledge_visible(self) -> None:
        sent = self.descriptor.sendto(LATENCY_VISIBLE_ACK, str(self.peer_path))
        if sent != len(LATENCY_VISIBLE_ACK):
            raise RuntimeError(
                "incomplete autonomous-output visibility acknowledgement"
            )

    def wait_for_receipt(self, expected: bytes, timeout: float) -> None:
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
        for path in (self.path, self.peer_path):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def release_autonomous_output(receipts: PtyReceiptChannel) -> None:
    receipts.acknowledge_visible()
    receipts.wait_for_receipt(LATENCY_NEXT_READY, 5.0)


class MuxRuntime(Protocol):
    multiplexer: str
    version: str
    peer_path: Path
    probe_path: Path
    gate_path: Path
    receipt_path: Path
    clients: list[PtyProcess]
    environment: dict[str, str]

    def attach(self, session: str) -> PtyProcess: ...

    def attach_arguments(self, session: str) -> list[str]: ...

    def start_and_attach(self, session: str) -> PtyProcess: ...

    def start_detached(self, session: str) -> None: ...

    def start_detached_with_attach_marker(self, session: str) -> None: ...

    def detach(self, client: PtyProcess, session: str) -> None: ...

    def resource_roots(self) -> list[int]: ...

    def resource_role_pids(self) -> dict[str, list[int]]: ...

    def binary_provenance(self) -> dict[str, Any]: ...

    def close(self) -> None: ...


def wait_for_startup_shell(runtime: MuxRuntime, client: PtyProcess) -> None:
    # Alternate-screen setup only proves that the outer client initialized. The startup marker is
    # emitted by the inner shell, so observing it proves that workload input can be routed safely.
    client.read_until(
        SHELL_READY_MARKER,
        5.0,
        visible_text=screen_renders_markers(runtime),
    )
    client.drain(0.005)


def retain_attach_marker(runtime: MuxRuntime, session: str) -> None:
    validation_client = runtime.attach(session)
    validation_client.read_until(
        ATTACH_VISIBLE_MARKER,
        5.0,
        visible_text=screen_renders_markers(runtime),
    )
    runtime.detach(validation_client, session)


class LemmaRuntime:
    multiplexer = "lemma"
    version = "development"

    def __init__(
        self,
        server: Path,
        cli: Path,
        peer: Path,
        probe: Path,
        trace_directory: Path | None = None,
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="lemma-benchmark-")
        root = Path(self.temporary.name)
        self.socket_path = root / "daemon.sock"
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.server_path = server.resolve()
        self.cli_path = cli.resolve()
        self.peer_path = peer.resolve()
        self.probe_path = probe.resolve()
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
        normalized = list(arguments)
        requested_session = (
            normalized.pop()
            if len(normalized) == 2 and normalized[0] == "list"
            else None
        )
        completed = subprocess.run(
            [str(self.cli_path), str(self.socket_path), *normalized],
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        if requested_session is not None:
            prefix = f'lemma session "{requested_session}":'
            completed.stdout = "".join(
                line
                for line in completed.stdout.splitlines(keepends=True)
                if line.startswith(prefix)
            )
            if not completed.stdout:
                raise RuntimeError(
                    f"Lemma session {requested_session!r} was not listed"
                )
        return completed

    def attach_arguments(self, session: str) -> list[str]:
        return [str(self.cli_path), str(self.socket_path), "attach", session]

    def attach(self, session: str) -> PtyProcess:
        client = PtyProcess(
            self.attach_arguments(session),
            self.environment,
            terminal_restore_sequence=LEMMA_OUTER_TERMINAL_RESTORE,
        )
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        self.start_detached(session)
        client = self.attach(session)
        wait_for_startup_shell(self, client)
        return client

    def start_detached(self, session: str) -> None:
        self.command("start", session)

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
        return [
            self.server.pid,
            *(client.pid for client in self.clients if client.pid > 0),
        ]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": [self.server.pid],
            "attached_client": [
                client.pid for client in self.clients if client.pid > 0
            ],
        }

    def binary_provenance(self) -> dict[str, Any]:
        return {
            "server": executable_provenance(self.server_path),
            "cli": executable_provenance(self.cli_path),
            "workload": executable_provenance(self.peer_path),
            "probe": executable_provenance(self.probe_path),
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


class DirectRuntime:
    multiplexer = "direct"
    version = "host PTY baseline"

    def __init__(self, peer: Path, probe: Path) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="direct-benchmark-")
        root = Path(self.temporary.name)
        self.peer_path = peer.resolve()
        self.probe_path = probe.resolve()
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.environment = benchmark_environment(root)
        self.environment["PS1"] = "__LEMMA_DIRECT_READY__ "
        self.clients: list[PtyProcess] = []

    def attach_arguments(self, session: str) -> list[str]:
        del session
        return ["/bin/sh", "-i"]

    def attach(self, session: str) -> PtyProcess:
        client = PtyProcess(self.attach_arguments(session), self.environment)
        self.clients.append(client)
        client.read_until(b"__LEMMA_DIRECT_READY__", 5.0)
        client.drain(0.01)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        return self.attach(session)

    def start_detached(self, session: str) -> None:
        del session
        raise RuntimeError("the direct PTY baseline has no detached-session model")

    def start_detached_with_attach_marker(self, session: str) -> None:
        del session
        raise RuntimeError("the direct PTY baseline has no attach model")

    def detach(self, client: PtyProcess, session: str) -> None:
        del session
        client.close()

    def resource_roots(self) -> list[int]:
        return [client.pid for client in self.clients if client.pid > 0]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "direct_shell": [client.pid for client in self.clients if client.pid > 0]
        }

    def binary_provenance(self) -> dict[str, Any]:
        return {
            "shell": executable_provenance(Path("/bin/sh")),
            "workload": executable_provenance(self.peer_path),
            "probe": executable_provenance(self.probe_path),
        }

    def close(self) -> None:
        for client in self.clients:
            client.close()
        self.clients.clear()
        self.temporary.cleanup()


class TmuxRuntime:
    multiplexer = "tmux"

    def __init__(
        self,
        executable: Path,
        peer: Path,
        probe: Path,
        trace_directory: Path | None = None,
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="tmux-benchmark-")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.probe_path = probe.resolve()
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

    def _command(
        self, *arguments: str, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                str(self.executable_path),
                "-S",
                str(self.socket_path),
                "-f",
                "/dev/null",
                *arguments,
            ],
            env=self.environment,
            check=check,
            capture_output=True,
            text=True,
            timeout=5.0,
        )

    def attach_arguments(self, session: str) -> list[str]:
        return [
            str(self.executable_path),
            "-S",
            str(self.socket_path),
            "-f",
            "/dev/null",
            "attach-session",
            "-t",
            session,
        ]

    def attach(self, session: str) -> PtyProcess:
        client = PtyProcess(self.attach_arguments(session), self.environment)
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        self.start_detached(session)
        client = self.attach(session)
        wait_for_startup_shell(self, client)
        return client

    def start_detached(self, session: str) -> None:
        self._command("new-session", "-d", "-s", session, "-x", "80", "-y", "24")
        if self.server_pid < 0:
            self.server_pid = int(
                self._command("display-message", "-p", "#{pid}").stdout.strip()
            )

    def start_detached_with_attach_marker(self, session: str) -> None:
        install_attach_shell_startup(self.environment, self.peer_path)
        self._command("new-session", "-d", "-s", session, "-x", "80", "-y", "24")
        if self.server_pid < 0:
            self.server_pid = int(
                self._command("display-message", "-p", "#{pid}").stdout.strip()
            )
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
        return [
            self.server_pid,
            *(client.pid for client in self.clients if client.pid > 0),
        ]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": [self.server_pid],
            "attached_client": [
                client.pid for client in self.clients if client.pid > 0
            ],
        }

    def binary_provenance(self) -> dict[str, Any]:
        return {
            "multiplexer": executable_provenance(self.executable_path),
            "workload": executable_provenance(self.peer_path),
            "probe": executable_provenance(self.probe_path),
        }

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
        self,
        executable: Path,
        peer: Path,
        probe: Path,
        trace_directory: Path | None = None,
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="zellij-benchmark-")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.probe_path = probe.resolve()
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
        return [
            str(self.executable_path),
            "--config",
            str(self.config_path),
            *arguments,
        ]

    def _command(
        self, *arguments: str, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self._arguments(*arguments),
            env=self.environment,
            check=check,
            capture_output=True,
            text=True,
            timeout=5.0,
        )

    def attach_arguments(self, session: str) -> list[str]:
        mapped_session = self.session_prefix + session.replace("_", "-")
        return self._arguments("attach", mapped_session)

    def attach(self, session: str) -> PtyProcess:
        client = PtyProcess(self.attach_arguments(session), self.environment)
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        # Creating and attaching through one client is the only Zellij operation that owns both
        # sides of the startup lifetime. A background session can be published by list-sessions and
        # still disappear before a second attach process reaches it.
        mapped_session = self.session_prefix + session.replace("_", "-")
        self.sessions.append(mapped_session)
        client = PtyProcess(
            self._arguments("attach", "--create", mapped_session), self.environment
        )
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 5.0, preserve_suffix=True)
        wait_for_startup_shell(self, client)
        return client

    def _wait_for_session(self, mapped_session: str) -> None:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            listed = self._command("list-sessions", "--short", check=False)
            if listed.returncode == 0 and mapped_session in listed.stdout.splitlines():
                return
            time.sleep(0.005)
        raise TimeoutError(f"Zellij session {mapped_session!r} was not published")

    def start_detached(self, session: str) -> None:
        mapped_session = self.session_prefix + session.replace("_", "-")
        self._command("attach", "--create-background", mapped_session)
        self.sessions.append(mapped_session)
        self._wait_for_session(mapped_session)

    def start_detached_with_attach_marker(self, session: str) -> None:
        install_attach_shell_startup(self.environment, self.peer_path)
        mapped_session = self.session_prefix + session.replace("_", "-")
        self._command("attach", "--create-background", mapped_session)
        self.sessions.append(mapped_session)
        self._wait_for_session(mapped_session)
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
        return [
            *self._server_pids(),
            *(client.pid for client in self.clients if client.pid > 0),
        ]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": self._server_pids(),
            "attached_client": [
                client.pid for client in self.clients if client.pid > 0
            ],
        }

    def binary_provenance(self) -> dict[str, Any]:
        return {
            "multiplexer": executable_provenance(self.executable_path),
            "workload": executable_provenance(self.peer_path),
            "probe": executable_provenance(self.probe_path),
        }

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


class HerdrRuntime:
    multiplexer = "herdr"

    def __init__(
        self,
        executable: Path,
        peer: Path,
        probe: Path,
        trace_directory: Path | None = None,
    ) -> None:
        # Herdr derives per-session client sockets below the config directory. Keep the
        # isolated root short enough for Darwin's bounded sockaddr_un path.
        self.temporary = tempfile.TemporaryDirectory(prefix="hb-", dir="/tmp")
        root = Path(self.temporary.name)
        self.executable_path = executable.resolve()
        self.peer_path = peer.resolve()
        self.probe_path = probe.resolve()
        self.gate_path = root / "blocked.gate"
        self.receipt_path = root / "receipt.sock"
        self.environment = benchmark_environment(root)
        self.environment["XDG_STATE_HOME"] = str(root / "state")
        if trace_directory is not None:
            self.environment["LEMMA_LATENCY_TRACE"] = str(trace_directory.resolve())
        self.config_directory = Path(self.environment["XDG_CONFIG_HOME"]) / "herdr"
        self.config_path = self.config_directory / "config.toml"
        self.config_directory.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(HERDR_BENCHMARK_CONFIG, encoding="utf-8")
        self.environment["HERDR_CONFIG_PATH"] = str(self.config_path)
        self.sessions: set[str] = set()
        self.server_pids: dict[str, int] = {}
        self.owned_servers: list[subprocess.Popen[bytes]] = []
        self.clients: list[PtyProcess] = []
        self.version = subprocess.run(
            [str(self.executable_path), "--version"],
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout.strip()

    def _command(
        self, *arguments: str, check: bool = True, timeout: float = 5.0
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.executable_path), *arguments],
            env=self.environment,
            check=check,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def session_command(
        self, session: str, *arguments: str
    ) -> subprocess.CompletedProcess[str]:
        return self._command("--session", session, *arguments)

    def _remember_server(self, session: str) -> None:
        socket_path = self.config_directory / "sessions" / session / "herdr.sock"
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                self.server_pids[session] = local_socket_peer_pid(socket_path)
                return
            except OSError:
                time.sleep(0.005)
        raise TimeoutError(f"Herdr session {session!r} API socket did not become ready")

    def attach_arguments(self, session: str) -> list[str]:
        return [str(self.executable_path), "--session", session]

    def attach(self, session: str) -> PtyProcess:
        self.sessions.add(session)
        client = PtyProcess(self.attach_arguments(session), self.environment)
        self.clients.append(client)
        client.read_until(ALT_SCREEN, 10.0, preserve_suffix=True)
        self._remember_server(session)
        return client

    def start_and_attach(self, session: str) -> PtyProcess:
        client = self.attach(session)
        wait_for_startup_shell(self, client)
        return client

    def start_detached(self, session: str) -> None:
        self.sessions.add(session)
        server = subprocess.Popen(
            [str(self.executable_path), "--session", session, "server"],
            env=self.environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.owned_servers.append(server)
        self._remember_server(session)
        self.session_command(session, "workspace", "create", "--cwd", os.getcwd())
        if self.pane_count(session) != 1:
            raise RuntimeError("Herdr detached session did not create one root pane")

    def start_detached_with_attach_marker(self, session: str) -> None:
        install_attach_shell_startup(self.environment, self.peer_path)
        validation_client = self.attach(session)
        validation_client.read_until(ATTACH_VISIBLE_MARKER, 5.0, visible_text=True)
        self.detach(validation_client, session)

    def detach(self, client: PtyProcess, session: str) -> None:
        del session
        client.write_all(b"\x02q", 2.0)
        client.wait_for_exit(10.0)

    def pane_count(self, session: str) -> int:
        response = self.session_command(session, "api", "snapshot")
        try:
            snapshot = json.loads(response.stdout)["result"]["snapshot"]
            return len(snapshot["panes"])
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise RuntimeError("Herdr snapshot did not contain a pane list") from error

    def resource_roots(self) -> list[int]:
        return [
            *self.server_pids.values(),
            *(client.pid for client in self.clients if client.pid > 0),
        ]

    def resource_role_pids(self) -> dict[str, list[int]]:
        return {
            "daemon": list(self.server_pids.values()),
            "attached_client": [
                client.pid for client in self.clients if client.pid > 0
            ],
        }

    def binary_provenance(self) -> dict[str, Any]:
        return {
            "multiplexer": executable_provenance(self.executable_path),
            "workload": executable_provenance(self.peer_path),
            "probe": executable_provenance(self.probe_path),
        }

    def close(self) -> None:
        # On Darwin the detached server may remain a child of its launching client. Stop
        # servers first so forcibly closing an attached client cannot wait on that child.
        remaining_servers = set(self.server_pids.values())
        for session in self.sessions:
            try:
                stopped = self._command(
                    "session", "stop", session, "--json", check=False, timeout=20.0
                )
                if stopped.returncode == 0:
                    remaining_servers.discard(self.server_pids.get(session, -1))
            except subprocess.SubprocessError:
                pass
        for process in remaining_servers:
            try:
                os.kill(process, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for client in self.clients:
            client.close()
        for server in self.owned_servers:
            try:
                server.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=0.5)
        self.clients.clear()
        self.owned_servers.clear()
        self.sessions.clear()
        self.server_pids.clear()
        self.temporary.cleanup()


def warm_scroll(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    client = runtime.start_and_attach("warm_scroll")
    fixture_command = (
        f"{shlex.quote(str(runtime.peer_path))} warm-scroll-loop\r"
    ).encode()
    client.write_all(fixture_command, 2.0)
    client.read_until(
        WARM_READY_MARKER, 60.0, visible_text=screen_renders_markers(runtime)
    )
    client.drain()

    try:
        completed = subprocess.run(
            [
                str(runtime.probe_path),
                "command",
                str(client.descriptor),
                str(repetitions),
                "\r",
                WARM_MARKER.decode("ascii"),
            ],
            check=True,
            capture_output=True,
            text=True,
            pass_fds=(client.descriptor,),
            timeout=max(60.0, float(repetitions) * 60.0),
        )
    except subprocess.CalledProcessError as error:
        census = process_tree_diagnostic(runtime.resource_roots())
        raise RuntimeError(
            "native command probe failed: "
            f"stdout={error.stdout!r} stderr={error.stderr!r} processes={census!r}"
        ) from error
    try:
        measured = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("native command probe returned invalid JSON") from error
    latencies = measured.get("latency")
    outer_bytes = measured.get("outer_bytes")
    if (
        not isinstance(measured, dict)
        or measured.get("observer") != "native_poll"
        or not isinstance(latencies, dict)
        or not isinstance(outer_bytes, list)
        or len(outer_bytes) != repetitions
    ):
        raise RuntimeError("native command probe returned an invalid result")
    return {
        "status": "completed",
        "observer": measured["observer"],
        "clock": measured["clock"],
        **latencies,
        "outer_bytes": outer_bytes,
        "median_outer_bytes": percentile(outer_bytes, 0.50),
    }


def attach_to_visible(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if repetitions != 1:
        raise ValueError("attach-to-visible isolates one runtime per native sample")
    # The startup fixture remains foreground. An untimed validation attach observes its marker
    # and detaches cleanly first, proving canonical state is ready before the native probe forks.
    session = "attach_visible"
    runtime.start_detached_with_attach_marker(session)
    completed = subprocess.run(
        [
            str(runtime.probe_path),
            "attach",
            "1",
            ATTACH_VISIBLE_MARKER.decode("ascii"),
            "--",
            *runtime.attach_arguments(session),
        ],
        env=runtime.environment,
        check=True,
        capture_output=True,
        text=True,
        timeout=10.0,
    )
    try:
        measured = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("native attach probe returned invalid JSON") from error
    latencies = measured.get("latency")
    outer_bytes = measured.get("outer_bytes")
    if (
        not isinstance(measured, dict)
        or measured.get("observer") != "native_poll"
        or not isinstance(latencies, dict)
        or not isinstance(outer_bytes, list)
        or len(outer_bytes) != 1
    ):
        raise RuntimeError("native attach probe returned an invalid result")
    return {
        "status": "completed",
        "observer": measured["observer"],
        "clock": measured["clock"],
        **latencies,
        "outer_bytes": outer_bytes,
        "median_outer_bytes": percentile(outer_bytes, 0.50),
    }


def latency_samples(
    client: PtyProcess,
    receipts: PtyReceiptChannel,
    probe: Path,
    label: str,
    repetitions: int,
    *,
    wait_for_peer_ready: bool = False,
) -> dict[str, Any]:
    label_code = INTERACTION_LABEL_CODES.get(label)
    if label_code is None:
        raise ValueError(f"unknown interaction label: {label}")
    completed = subprocess.run(
        [
            str(probe),
            "latency",
            str(client.descriptor),
            str(receipts.descriptor.fileno()),
            str(receipts.peer_path),
            label,
            label_code.decode("ascii"),
            str(repetitions),
            "1" if wait_for_peer_ready else "0",
        ],
        check=True,
        capture_output=True,
        text=True,
        pass_fds=(client.descriptor, receipts.descriptor.fileno()),
        timeout=max(10.0, float(repetitions) * 6.0),
    )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("native latency probe returned invalid JSON") from error
    if (
        not isinstance(result, dict)
        or result.get("schema") != 1
        or result.get("observer") != "native_poll"
    ):
        raise RuntimeError("native latency probe returned an invalid result")
    outer_bytes = result.get("outer_bytes")
    if not isinstance(outer_bytes, list) or len(outer_bytes) != repetitions:
        raise RuntimeError("native latency probe returned an invalid byte distribution")
    return {
        "observer": result["observer"],
        "clock": result["clock"],
        "key_to_pty": result["key_to_pty"],
        "key_to_outer_bytes": result["key_to_outer_bytes"],
        "outer_bytes": outer_bytes,
        "median_outer_bytes": percentile(outer_bytes, 0.50),
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
        client.read_until(
            LATENCY_OUTPUT_READY,
            5.0,
            visible_text=screen_renders_markers(runtime),
        )
        release_autonomous_output(receipts)
        client.drain(0.06)
        return {
            "status": "completed",
            **latency_samples(
                client,
                receipts,
                runtime.probe_path,
                "OUTPUT",
                repetitions,
                wait_for_peer_ready=True,
            ),
        }
    finally:
        receipts.close()


def interactive_open_loop(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    receipts = PtyReceiptChannel(runtime.receipt_path)
    try:
        client = runtime.start_and_attach("interactive_open_loop")
        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency "
            f"{shlex.quote(str(runtime.receipt_path))}\r"
        ).encode()
        client.write_all(launch, 2.0)
        client.read_until(
            LATENCY_READY, 5.0, visible_text=screen_renders_markers(runtime)
        )
        client.drain(0.01)
        completed = subprocess.run(
            [
                str(runtime.probe_path),
                "open-loop",
                str(client.descriptor),
                str(receipts.descriptor.fileno()),
                "OPEN",
                INTERACTION_LABEL_CODES["OPEN"].decode("ascii"),
                str(repetitions),
                "8333",
                "bounded",
            ],
            check=True,
            capture_output=True,
            text=True,
            pass_fds=(client.descriptor, receipts.descriptor.fileno()),
            timeout=max(30.0, float(repetitions) / 60.0 + 10.0),
        )
        try:
            measured = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                "native open-loop probe returned invalid JSON"
            ) from error
        if (
            not isinstance(measured, dict)
            or measured.get("observer") != "native_poll"
            or measured.get("offered_interval_ns") != 8_333_000
        ):
            raise RuntimeError("native open-loop probe returned an invalid result")
        return {
            "status": "completed",
            "observer": measured["observer"],
            "clock": measured["clock"],
            "offered_rate_hz": 120,
            "key_to_pty": measured["key_to_pty"],
            "key_to_outer_bytes": measured["key_to_outer_bytes"],
            "schedule_lateness": measured["schedule_lateness"],
        }
    finally:
        receipts.close()


def tui_redraw(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    receipts = PtyReceiptChannel(runtime.receipt_path)
    try:
        client = runtime.start_and_attach("tui_redraw")
        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency-tui "
            f"{shlex.quote(str(runtime.receipt_path))}\r"
        ).encode()
        client.write_all(launch, 2.0)
        client.read_until(
            TUI_REDRAW_READY,
            5.0,
            visible_text=screen_renders_markers(runtime),
        )
        client.drain(0.01)
        return {
            "status": "completed",
            **latency_samples(client, receipts, runtime.probe_path, "TUI", repetitions),
        }
    finally:
        receipts.close()


def tui_wheel_burst(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    receipts = PtyReceiptChannel(runtime.receipt_path)
    try:
        client = runtime.start_and_attach("tui_wheel")
        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} latency-tui-wheel "
            f"{shlex.quote(str(runtime.receipt_path))} {TUI_WHEEL_BURST_SIZE}\r"
        ).encode()
        client.write_all(launch, 2.0)
        client.read_until(
            TUI_WHEEL_READY,
            5.0,
            visible_text=screen_renders_markers(runtime),
        )
        client.drain(0.01)

        completed = subprocess.run(
            [
                str(runtime.probe_path),
                "wheel",
                str(client.descriptor),
                str(receipts.descriptor.fileno()),
                "WHEEL",
                INTERACTION_LABEL_CODES["WHEEL"].decode("ascii"),
                str(repetitions),
                str(TUI_WHEEL_BURST_SIZE),
                "bounded",
            ],
            check=True,
            capture_output=True,
            text=True,
            pass_fds=(client.descriptor, receipts.descriptor.fileno()),
            timeout=max(10.0, float(repetitions) * 6.0),
        )
        try:
            measured = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("native wheel probe returned invalid JSON") from error
        outer_bytes = measured.get("outer_bytes")
        if (
            not isinstance(measured, dict)
            or measured.get("observer") != "native_poll"
            or not isinstance(outer_bytes, list)
            or len(outer_bytes) != repetitions
        ):
            raise RuntimeError("native wheel probe returned an invalid result")
        return {
            "status": "completed",
            "observer": measured["observer"],
            "clock": measured["clock"],
            "wheel_events_per_sample": TUI_WHEEL_BURST_SIZE,
            "key_to_pty": measured["key_to_pty"],
            "key_to_outer_bytes": measured["key_to_outer_bytes"],
            "outer_bytes": outer_bytes,
            "median_outer_bytes": percentile(outer_bytes, 0.50),
        }
    finally:
        receipts.close()


class WorkloadFailure(RuntimeError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


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
        responsive.read_until(
            LATENCY_READY, 5.0, visible_text=screen_renders_markers(runtime)
        )
        responsive.drain(0.01)
        idle = latency_samples(
            responsive, receipts, runtime.probe_path, "IDLE", repetitions
        )

        launch = (
            f"exec {shlex.quote(str(runtime.peer_path))} block "
            f"{shlex.quote(str(runtime.gate_path))} {PAYLOAD_SIZE}\r"
        ).encode()
        blocked.write_all(launch, 2.0)
        blocked.read_until(
            BLOCK_READY, 5.0, visible_text=screen_renders_markers(runtime)
        )
        payload = b"q" * PAYLOAD_SIZE
        accepted = blocked.fill_until_stalled(payload)
        if accepted <= 0:
            raise RuntimeError("blocked PTY accepted no payload")

        under_backpressure = latency_samples(
            responsive,
            receipts,
            runtime.probe_path,
            "BLOCKED",
            repetitions,
        )
        runtime.gate_path.touch(mode=0o600, exist_ok=False)
        try:
            blocked.write_all(payload[accepted:], 60.0)
            blocked.read_until(
                BLOCK_DONE,
                60.0,
                failure_markers=(
                    b"__LEMMA_PTY_FAILED__",
                    b"lost connection",
                    b"server exited unexpectedly",
                    b"Received empty unknown from server",
                ),
                visible_text=screen_renders_markers(runtime),
            )
        except (RuntimeError, TimeoutError) as error:
            raise WorkloadFailure(
                str(error),
                {
                    "status": "failed",
                    "error": f"{type(error).__name__}: {error}",
                    "payload_bytes": PAYLOAD_SIZE,
                    "bytes_before_backpressure": accepted,
                    "client_backpressure_observed": accepted < len(payload),
                    "idle": idle,
                    "blocked_other_session": under_backpressure,
                },
            ) from error

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


def session_profile(
    runtime: MuxRuntime, sessions: int, repetitions: int
) -> dict[str, Any]:
    for index in range(sessions):
        runtime.start_detached(f"session_profile_{index}")
    return {
        "status": "completed",
        "sessions": sessions,
        "panes_per_session": 1,
        "resources": sample_resources(runtime, repetitions),
    }


def workspace_profile(
    runtime: MuxRuntime, workspaces: int, repetitions: int
) -> dict[str, Any]:
    if not isinstance(runtime, HerdrRuntime):
        result = session_profile(runtime, workspaces, repetitions)
        result["workspaces"] = result.pop("sessions")
        result["panes_per_workspace"] = result.pop("panes_per_session")
        return result

    session = "workspace_profile"
    runtime.start_detached(session)
    for _ in range(1, workspaces):
        runtime.session_command(session, "workspace", "create", "--cwd", os.getcwd())
    if runtime.pane_count(session) != workspaces:
        raise RuntimeError(
            "Herdr workspace profile did not create one pane per workspace"
        )
    return {
        "status": "completed",
        "workspaces": workspaces,
        "panes_per_workspace": 1,
        "resources": sample_resources(runtime, repetitions),
    }


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
        "empty": empty,
        "populated": populated,
    }


def blocked_client(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if not isinstance(runtime, LemmaRuntime):
        raise TypeError("blocked-client workload requires Lemma")
    receipts = PtyReceiptChannel(runtime.receipt_path)
    blocked: socket.socket | None = None
    disconnect_probe: subprocess.Popen[str] | None = None
    ready_read = -1
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
        idle = latency_samples(
            responsive,
            receipts,
            runtime.probe_path,
            "CLIENT_IDLE",
            repetitions,
        )

        blocked = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        blocked.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1_024)
        blocked.settimeout(5.0)
        blocked.connect(str(runtime.socket_path))
        session = b"blocked_client"
        hello_payload = (
            bytes((len(session),)) + struct.pack("!HH", 500, 200) + b"\0" + session
        )
        blocked.sendall(attach_frame(ATTACH_KIND_HELLO, hello_payload, 1))
        receive_attach_hello(blocked)
        flood_command = b"exec yes __LEMMA_BLOCKED_CLIENT_FLOOD__\r"
        flood_frame = attach_frame(ATTACH_KIND_INPUT, flood_command, 2)
        ready_read, ready_write = os.pipe()
        disconnect_probe = subprocess.Popen(
            [
                str(runtime.probe_path),
                "disconnect",
                str(blocked.fileno()),
                str(ready_write),
                flood_frame.hex(),
                str(BLOCKED_CLIENT_DISCONNECT_DEADLINE_NS // 1_000_000),
            ],
            pass_fds=(blocked.fileno(), ready_write),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        os.close(ready_write)
        readable, _, _ = select.select([ready_read], [], [], 2.0)
        if not readable or os.read(ready_read, 1) != b"R":
            raise TimeoutError("native disconnect probe did not arm the blocked client")
        os.close(ready_read)
        ready_read = -1

        under_backpressure = latency_samples(
            responsive,
            receipts,
            runtime.probe_path,
            "CLIENT_BLOCKED",
            repetitions,
        )
        probe_output, probe_error = disconnect_probe.communicate(timeout=6.0)
        if disconnect_probe.returncode != 0:
            raise TimeoutError(
                "blocked attached client exceeded its no-progress disconnect bound: "
                f"{probe_error.strip()}"
            )
        try:
            disconnect_result = json.loads(probe_output)
            disconnect_latency_ns = int(disconnect_result["disconnect_latency_ns"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError(
                "native disconnect probe returned invalid JSON"
            ) from error
        if (
            disconnect_result.get("observer") != "native_poll"
            or disconnect_latency_ns > BLOCKED_CLIENT_DISCONNECT_DEADLINE_NS
        ):
            raise TimeoutError(
                "blocked attached client was observed after its disconnect bound"
            )
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if ", detached," in runtime.command("list", "blocked_client").stdout:
                break
            time.sleep(0.01)
        else:
            raise TimeoutError("blocked client disconnected without publishing detach")

        return {
            "status": "completed",
            "receive_buffer_bytes": 4 * 1_024,
            "disconnect": {
                "observer": "native_poll",
                "clock": disconnect_result["clock"],
                "latency_ns": disconnect_latency_ns,
            },
            "idle": idle,
            "blocked_other_session": under_backpressure,
        }
    finally:
        if ready_read >= 0:
            os.close(ready_read)
        if disconnect_probe is not None and disconnect_probe.poll() is None:
            disconnect_probe.kill()
            disconnect_probe.wait(timeout=1.0)
        if blocked is not None:
            blocked.close()
        receipts.close()


def wait_for_profile_panes(
    runtime: LemmaRuntime | TmuxRuntime | HerdrRuntime,
    client: PtyProcess,
    session: str,
    panes: int,
) -> None:
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        client.drain(0.005)
        if isinstance(runtime, LemmaRuntime):
            reached = f", {panes} pane(s)," in runtime.command("list", session).stdout
        elif isinstance(runtime, HerdrRuntime):
            reached = runtime.pane_count(session) == panes
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


def wait_for_profile_shell(
    runtime: LemmaRuntime | TmuxRuntime | HerdrRuntime,
    client: PtyProcess,
    pane_index: int,
) -> None:
    marker = f"__LEMMA_PROFILE_PANE_{pane_index:04d}_READY__".encode()
    # Keep the complete marker out of the echoed command so observation proves the shell executed
    # it. Pane publication only proves that the PTY child exists; sampling before login-shell
    # startup settles otherwise charges setup CPU to the nominally idle interval.
    command = f"printf '__LEMMA_PROFILE_PANE_%04d_READY__\\n' {pane_index}\r".encode()
    wait_for_shell_execution(runtime, client, marker, command)


def launch_latency_peer(
    runtime: LemmaRuntime | TmuxRuntime | HerdrRuntime,
    client: PtyProcess,
    autonomous_output: bool,
    receipts: PtyReceiptChannel | None = None,
) -> None:
    mode = "latency-output" if autonomous_output else "latency"
    ready = LATENCY_OUTPUT_READY if autonomous_output else LATENCY_READY
    command = (
        f"exec {shlex.quote(str(runtime.peer_path))} {mode} "
        f"{shlex.quote(str(runtime.receipt_path))}\r"
    ).encode()
    client.write_all(command, 2.0)
    client.read_until(ready, 5.0, visible_text=screen_renders_markers(runtime))
    if autonomous_output:
        if receipts is None:
            raise ValueError("autonomous output requires a receipt channel")
        release_autonomous_output(receipts)
    client.drain(0.06 if autonomous_output else 0.005)


def build_profile(
    runtime: LemmaRuntime | TmuxRuntime | HerdrRuntime,
    client: PtyProcess,
    panes: int,
    session: str = "profile",
) -> None:
    pane_index = 1
    wait_for_profile_shell(runtime, client, pane_index)
    tab_count = 1 if panes == 1 else panes // 4
    for tab_index in range(tab_count):
        if panes == 1:
            return

        if isinstance(runtime, HerdrRuntime):
            if tab_index > 0:
                runtime.session_command(session, "tab", "create", "--focus")
                pane_index += 1
                wait_for_profile_panes(runtime, client, session, pane_index)
                wait_for_profile_shell(runtime, client, pane_index)
            for direction in ("right", "down", "down"):
                runtime.session_command(
                    session,
                    "pane",
                    "split",
                    "--current",
                    "--direction",
                    direction,
                    "--focus",
                )
                pane_index += 1
                wait_for_profile_panes(runtime, client, session, pane_index)
                wait_for_profile_shell(runtime, client, pane_index)
            continue

        send_prefix(client, b"%")
        pane_index += 1
        wait_for_profile_panes(runtime, client, session, pane_index)
        wait_for_profile_shell(runtime, client, pane_index)

        send_prefix(client, b'"')
        pane_index += 1
        wait_for_profile_panes(runtime, client, session, pane_index)
        wait_for_profile_shell(runtime, client, pane_index)

        send_prefix(client, b"o")
        send_prefix(client, b'"')
        pane_index += 1
        wait_for_profile_panes(runtime, client, session, pane_index)
        wait_for_profile_shell(runtime, client, pane_index)

        if tab_index + 1 < tab_count:
            send_prefix(client, b"c")
            wait_for_profile_panes(runtime, client, session, pane_index + 1)
            pane_index += 1
            wait_for_profile_shell(runtime, client, pane_index)


def pane_profile(
    runtime: LemmaRuntime | TmuxRuntime | HerdrRuntime,
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
            launch_latency_peer(runtime, client, True, receipts)
            resources = sample_resources(runtime, repetitions, client)
        interaction = latency_samples(
            client,
            receipts,
            runtime.probe_path,
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


def lifecycle_sentinel_arguments(peer_path: Path) -> tuple[str, ...]:
    # Use the built fixture rather than a distribution-specific utility path. The idle peer also
    # gives this measurement one explicit, quiescent process lifetime.
    return ("start", "lifecycle_sentinel", "--", str(peer_path), "idle")


def lifecycle_churn(runtime: MuxRuntime, repetitions: int) -> dict[str, Any]:
    if not isinstance(runtime, LemmaRuntime):
        raise TypeError("lifecycle churn requires Lemma")
    # Keep one ordinary session alive so deleting the churn target does not intentionally stop the
    # daemon whose descriptor and memory plateau this workload audits. Final-session auto-exit has
    # separate process coverage; the runtime process group reclaims this sentinel after sampling.
    runtime.command(*lifecycle_sentinel_arguments(runtime.peer_path))
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
            raise RuntimeError(
                "lifecycle churn could not identify its live pane"
            ) from error
        if focused_pid <= 0:
            raise RuntimeError(
                "lifecycle churn observed an invalid focused pane identity"
            )
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
            (index - x_mean) * (value - final_mean) for index, value in enumerate(final)
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
            raise RuntimeError(
                f"lifecycle churn did not return to a bounded memory plateau: {plateau}"
            )
    else:
        plateau = {
            "evaluated": False,
            "reason": f"at least {plateau_cycles * 2} cycles are required",
        }

    return {
        "status": "completed",
        "cycles": repetitions,
        "baseline_condition": "one ordinary sentinel session remains live across cycles",
        "operations_per_cycle": [
            "create",
            "attach",
            "split",
            "close",
            "detach",
            "kill",
        ],
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


def git_provenance() -> tuple[str, bool | None, str | None]:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unknown", None, None

    try:
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=normal"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return commit, None, None

    if not status:
        return commit, False, None
    try:
        tracked_diff = subprocess.run(
            ["git", "diff", "--binary", "HEAD"],
            check=True,
            capture_output=True,
            timeout=2.0,
        ).stdout
        untracked = sorted(
            line[3:]
            for line in status.splitlines()
            if line.startswith("?? ") and Path(line[3:]).is_file()
        )
        digest = hashlib.sha256(tracked_diff)
        for name in untracked:
            digest.update(name.encode("utf-8"))
            digest.update(Path(name).read_bytes())
    except (OSError, subprocess.SubprocessError):
        return commit, True, None
    return commit, True, digest.hexdigest()


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
            magic, version, role, event_size, capacity, process, count, dropped = (
                header.unpack_from(encoded)
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
            and count <= capacity == 524_288
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
        "event_capacity_per_process": 524_288,
        "events": total_events,
        "dropped": total_dropped,
        "files": files,
    }


def main() -> int:
    manifest_parser = argparse.ArgumentParser(add_help=False)
    manifest_parser.add_argument(
        "--manifest", type=Path, default=Path("benchmarks/workloads.json")
    )
    manifest_arguments, _ = manifest_parser.parse_known_args()
    try:
        manifest = load_manifest(manifest_arguments.manifest)
    except ManifestError as error:
        manifest_parser.error(str(error))
    process_modes = tuple(
        workload["cli_mode"] for workload in manifest["process_workloads"]
    )

    parser = argparse.ArgumentParser(parents=[manifest_parser])
    parser.add_argument(
        "--mode",
        choices=(
            *process_modes,
            "comparison",
            "profiles",
            "session-profiles",
            "workspace-profiles",
            "all",
        ),
        default="comparison",
    )
    parser.add_argument(
        "--multiplexer",
        choices=("direct", "lemma", "tmux", "zellij", "herdr"),
        default="lemma",
    )
    parser.add_argument("--repetitions", type=int)
    parser.add_argument(
        "--intent", choices=("smoke", "extended", "gate", "manual"), default="manual"
    )
    parser.add_argument(
        "--server", type=Path, default=Path("build/release/lemma_test_server")
    )
    parser.add_argument(
        "--cli", type=Path, default=Path("build/release/lemma_test_cli")
    )
    parser.add_argument(
        "--peer", type=Path, default=Path("build/release/lemma_test_pty_peer")
    )
    parser.add_argument(
        "--probe", type=Path, default=Path("build/release/lemma_benchmark_probe")
    )
    parser.add_argument("--tmux", type=Path, default=Path("tmux"))
    parser.add_argument("--zellij", type=Path, default=Path("zellij"))
    parser.add_argument("--herdr", type=Path, default=Path("herdr"))
    parser.add_argument("--trace-directory", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--allow-workload-failures",
        action="store_true",
        help="record competitor workload failures instead of failing the harness",
    )
    arguments = parser.parse_args()
    if arguments.repetitions is None:
        policy_name = arguments.intent if arguments.intent != "manual" else "smoke"
        policy = manifest["sample_policies"][policy_name]
        arguments.repetitions = (
            policy["profile_repetitions"]
            if arguments.mode == "profiles"
            else policy["process_repetitions"]
        )
    if arguments.repetitions < 1 or arguments.repetitions > 10_000:
        parser.error("--repetitions must be between 1 and 10000")
    selected_scenarios = (
        suite_workloads(manifest, arguments.mode)
        if arguments.mode in {"comparison", "all"}
        else []
    )
    individual_scenario = workload_for_mode(manifest, arguments.mode)
    if individual_scenario is not None:
        selected_scenarios = [individual_scenario]
    requires_attach_fixture = any(
        scenario["id"] == "attach_to_visible"
        and arguments.multiplexer in scenario["subjects"]
        for scenario in selected_scenarios
    )
    if requires_attach_fixture:
        account_shell = account_login_shell()
        if Path(account_shell).name not in ATTACH_STARTUP_SHELLS:
            parser.error(
                f"attach-to-visible does not support account login shell {account_shell!r}"
            )
    for fixture_executable in (arguments.peer, arguments.probe):
        if not fixture_executable.is_file():
            parser.error(f"missing executable: {fixture_executable}")
    if arguments.mode == "profiles" and arguments.multiplexer not in {
        "lemma",
        "tmux",
        "herdr",
    }:
        parser.error("pane profiles require --multiplexer lemma, tmux, or herdr")
    if arguments.trace_directory is not None:
        arguments.trace_directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        if any(arguments.trace_directory.glob("*.ltrace")):
            parser.error("--trace-directory must not contain existing .ltrace files")

    build_profile: str | None = None
    tmux: Path | None = None
    zellij: Path | None = None
    herdr: Path | None = None
    if arguments.multiplexer == "direct":
        build_profile = arguments.probe.parent.name
    elif arguments.multiplexer == "lemma":
        for executable in (arguments.server, arguments.cli):
            if not executable.is_file():
                parser.error(f"missing executable: {executable}")
        build_profile = arguments.server.parent.name
    elif arguments.multiplexer == "tmux":
        tmux = Path(shutil.which(str(arguments.tmux)) or arguments.tmux)
        if not tmux.is_file():
            parser.error(f"missing executable: {arguments.tmux}")
    elif arguments.multiplexer == "zellij":
        zellij = Path(shutil.which(str(arguments.zellij)) or arguments.zellij)
        if not zellij.is_file():
            parser.error(f"missing executable: {arguments.zellij}")
    else:
        herdr = Path(shutil.which(str(arguments.herdr)) or arguments.herdr)
        if not herdr.is_file():
            parser.error(f"missing executable: {arguments.herdr}")

    def create_runtime() -> MuxRuntime:
        if arguments.multiplexer == "direct":
            return DirectRuntime(arguments.peer, arguments.probe)
        if arguments.multiplexer == "lemma":
            return LemmaRuntime(
                arguments.server,
                arguments.cli,
                arguments.peer,
                arguments.probe,
                arguments.trace_directory,
            )
        if arguments.multiplexer == "tmux":
            assert tmux is not None
            return TmuxRuntime(tmux, arguments.peer, arguments.probe)
        if arguments.multiplexer == "zellij":
            assert zellij is not None
            return ZellijRuntime(zellij, arguments.peer, arguments.probe)
        assert herdr is not None
        return HerdrRuntime(herdr, arguments.peer, arguments.probe)

    workloads: dict[str, Any] = {}
    pane_profiles: dict[str, Any] = {}
    session_profiles: dict[str, Any] = {}
    workspace_profiles: dict[str, Any] = {}
    runtime_version = "unknown"
    binary_provenance: dict[str, Any] = {}

    def run_operation(
        operation: Callable[[MuxRuntime, int], dict[str, Any]],
        repetitions: int | None = None,
    ) -> dict[str, Any]:
        nonlocal runtime_version, binary_provenance
        runtime: MuxRuntime | None = None
        try:
            runtime = create_runtime()
            runtime_version = runtime.version
            result = operation(
                runtime, arguments.repetitions if repetitions is None else repetitions
            )
            result["resources_after_workload"] = runtime_resource_snapshot(runtime)
            if not binary_provenance:
                binary_provenance = runtime.binary_provenance()
            return result
        except (
            OSError,
            RuntimeError,
            TimeoutError,
            subprocess.SubprocessError,
        ) as error:
            if runtime is not None and not binary_provenance:
                binary_provenance = runtime.binary_provenance()
            if not arguments.allow_workload_failures:
                raise
            if isinstance(error, WorkloadFailure):
                return error.result
            return {
                "status": "failed",
                "error": f"{type(error).__name__}: {error}",
            }
        finally:
            if runtime is not None:
                runtime.close()

    operations: dict[str, Callable[[MuxRuntime, int], dict[str, Any]]] = {
        "warm_scroll": warm_scroll,
        "attach_to_visible": attach_to_visible,
        "interactive_under_output": interactive_under_output,
        "interactive_open_loop": interactive_open_loop,
        "tui_redraw": tui_redraw,
        "tui_wheel_burst": tui_wheel_burst,
        "idle_resources": idle_resources,
        "blocked_pty": blocked_pty,
        "blocked_client": blocked_client,
        "component_resources": component_resources,
        "history_resources": history_resources,
        "lifecycle_churn": lifecycle_churn,
    }

    def classify_failure(workload: str, result: dict[str, Any]) -> dict[str, Any]:
        if result.get("status") != "failed":
            return result
        error = result.get("error")
        reviewed = expected_failure(
            manifest,
            arguments.multiplexer,
            workload,
            error if isinstance(error, str) else "",
        )
        if reviewed is not None:
            result["failure_expected"] = True
            result["failure_classification"] = reviewed["classification"]
        return result

    selected = [
        (scenario, operations[scenario["id"]]) for scenario in selected_scenarios
    ]
    for scenario, operation in selected:
        name = scenario["id"]
        if arguments.multiplexer not in scenario["subjects"]:
            workloads[name] = {
                "status": "unsupported",
                "reason": (
                    f"{name} is not defined for the {arguments.multiplexer} subject"
                ),
            }
            continue
        if name != "attach_to_visible":
            workloads[name] = classify_failure(name, run_operation(operation))
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
            attach_bytes.extend(result["outer_bytes"])
            resources_after_workload = result.get("resources_after_workload")
        if attach_failure is not None:
            workloads[name] = classify_failure(name, attach_failure)
        else:
            workloads[name] = {
                "status": "completed",
                "observer": "native_poll",
                "clock": "steady_clock",
                **summary(attach_samples),
                "outer_bytes": attach_bytes,
                "median_outer_bytes": percentile(attach_bytes, 0.50),
                "resources_after_workload": resources_after_workload,
            }

    if arguments.mode in ("profiles", "all") and arguments.multiplexer in {
        "lemma",
        "tmux",
        "herdr",
    }:
        profile_suite = manifest["profile_suites"][arguments.intent]
        profile_definitions = {
            profile["id"]: int(profile["panes"])
            for profile in manifest["pane_profiles"]
        }
        for profile in profile_suite:
            panes = profile_definitions[profile]
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
                    if not isinstance(
                        runtime, (LemmaRuntime, TmuxRuntime, HerdrRuntime)
                    ):
                        raise TypeError(
                            "pane profile requires Lemma, tmux, or Herdr runtime"
                        )
                    return pane_profile(
                        runtime, profile_id, pane_count, active, repetitions
                    )

                pane_profiles[profile][key] = run_operation(profile_operation)

    if (
        arguments.mode in ("session-profiles", "all")
        and arguments.multiplexer != "direct"
    ):
        session_suite = manifest["session_profile_suites"][arguments.intent]
        session_definitions = {
            profile["id"]: int(profile["sessions"])
            for profile in manifest["session_profiles"]
        }
        for profile in session_suite:
            sessions = session_definitions[profile]

            def session_profile_operation(
                runtime: MuxRuntime,
                repetitions: int,
                *,
                session_count: int = sessions,
            ) -> dict[str, Any]:
                return session_profile(runtime, session_count, repetitions)

            session_profiles[profile] = run_operation(session_profile_operation)

    if (
        arguments.mode in ("workspace-profiles", "all")
        and arguments.multiplexer != "direct"
    ):
        workspace_suite = manifest["workspace_profile_suites"][arguments.intent]
        workspace_definitions = {
            profile["id"]: int(profile["workspaces"])
            for profile in manifest["workspace_profiles"]
        }
        for profile in workspace_suite:
            workspaces = workspace_definitions[profile]

            def workspace_profile_operation(
                runtime: MuxRuntime,
                repetitions: int,
                *,
                workspace_count: int = workspaces,
            ) -> dict[str, Any]:
                return workspace_profile(runtime, workspace_count, repetitions)

            workspace_profiles[profile] = run_operation(workspace_profile_operation)

    commit, worktree_dirty, worktree_diff_sha256 = git_provenance()
    host_load_average = list(os.getloadavg())
    maximum_gate_load = manifest["regression_budgets"]["scope"][
        "maximum_load_average_1m"
    ]
    report = {
        "schema": 5,
        "suite": "core-mux-baseline",
        "run_intent": arguments.intent,
        "generated_at": datetime.now(UTC).isoformat(),
        "manifest": {
            "path": str(arguments.manifest.resolve()),
            "schema": manifest["schema"],
            "sha256": hashlib.sha256(arguments.manifest.read_bytes()).hexdigest(),
        },
        "scenario_ids": [scenario["id"] for scenario in selected_scenarios],
        "statistics_valid": {
            "p50": True,
            "p95": arguments.repetitions >= 20,
            "p99": arguments.repetitions >= 100,
        },
        "environment_valid": host_load_average[0] <= maximum_gate_load,
        "maximum_gate_load_average_1m": maximum_gate_load,
        "multiplexer": arguments.multiplexer,
        "multiplexer_version": runtime_version,
        "commit": commit,
        "worktree_dirty": worktree_dirty,
        "worktree_diff_sha256": worktree_diff_sha256,
        "host": platform.node(),
        "host_fingerprint": host_fingerprint(),
        "system": platform.system(),
        "system_release": platform.release(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "host_load_average": host_load_average,
        "terminal": manifest["terminal"],
        "repetitions": arguments.repetitions,
        "binaries": binary_provenance,
        "build_profile": build_profile,
        "latency_trace": latency_trace_metadata(arguments.trace_directory),
        "private_attach_framing": (
            {
                "version": f"{ATTACH_PROTOCOL_MAJOR}.{ATTACH_PROTOCOL_MINOR}",
                "envelope_bytes_per_message": ATTACH_HEADER_BYTES,
                "render_generation_bytes_per_frame": 4,
                "render_wire_overhead_bytes_per_frame": ATTACH_HEADER_BYTES + 4,
                "outer_bytes_metric_excludes_private_framing": True,
            }
            if arguments.multiplexer == "lemma"
            else None
        ),
        "workloads": workloads,
        "pane_profiles": pane_profiles,
        "session_profiles": session_profiles,
        "workspace_profiles": workspace_profiles,
    }

    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
