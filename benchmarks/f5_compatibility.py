#!/usr/bin/env python3
"""Exercise representative real terminal applications through Lemma's attached PTY path."""

from __future__ import annotations

import argparse
import json
import platform
import shlex
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from mux_benchmark import LemmaRuntime, PtyProcess, git_provenance, host_fingerprint


def executable_version(path: Path) -> str:
    for arguments in ([str(path), "--version"], [str(path), "-V"]):
        try:
            completed = subprocess.run(
                arguments,
                check=False,
                capture_output=True,
                text=True,
                timeout=2.0,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        output = (completed.stdout + completed.stderr).strip().splitlines()
        if output:
            return output[0][:512]
    return "version unavailable"


def shell_done(client: PtyProcess, name: str) -> int:
    client.drain(0.1)
    expected = f"__F5_DONE_{name.upper()}__".encode()
    command = f"printf '__F5_DONE_%s__\\n' {shlex.quote(name.upper())}\r".encode()
    client.write_all(command, 2.0)
    _, received = client.read_until(expected, 5.0)
    return received


def run_shell(client: PtyProcess, executable: Path, name: str) -> dict[str, Any]:
    options = {
        "bash": "--noprofile --norc",
        "zsh": "-f",
        "fish": "--no-config",
    }[name]
    client.write_all(f"{shlex.quote(str(executable))} {options}\r".encode(), 2.0)
    time.sleep(0.1)
    marker = f"__F5_SHELL_{name.upper()}__".encode()
    command = f"printf '__F5_SHELL_%s__\\n' {shlex.quote(name.upper())}\r".encode()
    started = time.monotonic_ns()
    client.write_all(command, 2.0)
    latency, received = client.read_until(marker, 5.0, started_ns=started)
    client.write_all(b"exit\r", 2.0)
    received += shell_done(client, name)
    return {"marker_latency_ns": latency, "outer_bytes": received}


def run_editor(
    client: PtyProcess, executable: Path, name: str, temporary: Path
) -> dict[str, Any]:
    edited = temporary / f"f5-editor-{name}.txt"
    arguments = [str(executable)]
    if name == "nvim":
        arguments.extend(["--clean", "-n"])
    else:
        arguments.extend(["-Nu", "NONE", "-n", "-i", "NONE"])
    arguments.append(str(edited))
    client.write_all((" ".join(shlex.quote(value) for value in arguments) + "\r").encode(), 2.0)
    # The shell echoes the command and filename before the editor has installed its raw input
    # mode. Drain a bounded startup interval so those bytes cannot be mistaken for readiness.
    client.drain(0.5)
    marker = f"__F5_EDITOR_{name.upper()}__"
    started = time.monotonic_ns()
    client.write_all(("i" + marker).encode(), 2.0)
    latency, received = client.read_until(marker.encode(), 5.0, started_ns=started)
    # Ctrl-C returns Vim-family editors to Normal mode without relying on a bare-Escape ambiguity
    # timeout. Keep the Ex command in a later input message and bounded rendering interval.
    client.write_all(b"\x03", 2.0)
    client.drain(0.2)
    client.write_all(b":wq\r", 2.0)
    client.drain(0.5)
    received += shell_done(client, name)
    contents = edited.read_text(encoding="utf-8")
    if marker not in contents:
        raise RuntimeError(f"{name} did not persist its edited marker")
    return {
        "marker_latency_ns": latency,
        "outer_bytes": received,
        "saved_bytes": len(contents.encode()),
    }


def run_pager(client: PtyProcess, executable: Path, name: str, temporary: Path) -> dict[str, Any]:
    document = temporary / f"f5-pager-{name}.txt"
    marker = f"__F5_PAGER_{name.upper()}__"
    document.write_text(marker + "\n" + "\n".join(f"bounded pager row {i}" for i in range(100)))
    arguments = [str(executable)]
    if name == "less":
        arguments.append("-R")
    arguments.append(str(document))
    started = time.monotonic_ns()
    client.write_all((" ".join(shlex.quote(value) for value in arguments) + "\r").encode(), 2.0)
    latency, received = client.read_until(marker.encode(), 5.0, started_ns=started)
    client.write_all(b"q", 2.0)
    received += shell_done(client, name)
    return {"marker_latency_ns": latency, "outer_bytes": received}


def run_repl(client: PtyProcess, executable: Path, name: str) -> dict[str, Any]:
    if name != "python3":
        raise ValueError(f"unsupported REPL fixture {name}")
    client.write_all(f"{shlex.quote(str(executable))} -q\r".encode(), 2.0)
    client.read_until(b">>>", 5.0)
    marker = b"__F5_REPL_PYTHON__"
    started = time.monotonic_ns()
    client.write_all(b"print('__F5_' + 'REPL_PYTHON__')\r", 2.0)
    latency, received = client.read_until(marker, 5.0, started_ns=started)
    client.write_all(b"exit()\r", 2.0)
    received += shell_done(client, name)
    return {"marker_latency_ns": latency, "outer_bytes": received}


def run_tui(client: PtyProcess, executable: Path, name: str) -> dict[str, Any]:
    if name != "htop":
        raise ValueError(f"unsupported TUI fixture {name}")
    client.drain(0.05)
    started = time.monotonic_ns()
    client.write_all(f"{shlex.quote(str(executable))} -C -d 1\r".encode(), 2.0)
    latency, received = client.read_until(b"Tasks", 5.0, started_ns=started)
    client.write_all(b"q", 2.0)
    received += shell_done(client, name)
    if received < 100:
        raise RuntimeError("full-screen TUI produced implausibly little terminal output")
    return {"first_screen_latency_ns": latency, "outer_bytes": received}


def run_case(
    server: Path,
    cli: Path,
    peer: Path,
    category: str,
    name: str,
    executable: Path,
    operation: Callable[[PtyProcess, Path, str, Path], dict[str, Any]],
) -> dict[str, Any]:
    runtime: LemmaRuntime | None = None
    started = time.monotonic_ns()
    try:
        runtime = LemmaRuntime(server, cli, peer)
        client = runtime.start_and_attach(f"f5_{category}_{name}")
        result = operation(client, executable, name, Path(runtime.temporary.name))
        runtime.detach(client, f"f5_{category}_{name}")
        if client.terminal_state_restored is not True:
            raise RuntimeError("attached client did not restore its outer terminal state")
        return {
            "status": "passed",
            "category": category,
            "name": name,
            "executable": str(executable),
            "version": executable_version(executable),
            "duration_ns": time.monotonic_ns() - started,
            "terminal_state_restored": True,
            **result,
        }
    except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError, ValueError) as error:
        return {
            "status": "failed",
            "category": category,
            "name": name,
            "executable": str(executable),
            "version": executable_version(executable),
            "duration_ns": time.monotonic_ns() - started,
            "error": f"{type(error).__name__}: {error}",
        }
    finally:
        if runtime is not None:
            runtime.close()


def adapt_shell(
    client: PtyProcess, executable: Path, name: str, temporary: Path
) -> dict[str, Any]:
    del temporary
    return run_shell(client, executable, name)


def adapt_repl(
    client: PtyProcess, executable: Path, name: str, temporary: Path
) -> dict[str, Any]:
    del temporary
    return run_repl(client, executable, name)


def adapt_tui(
    client: PtyProcess, executable: Path, name: str, temporary: Path
) -> dict[str, Any]:
    del temporary
    return run_tui(client, executable, name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", type=Path, default=Path("build/release/lemma_test_server"))
    parser.add_argument("--cli", type=Path, default=Path("build/release/lemma_test_cli"))
    parser.add_argument("--peer", type=Path, default=Path("build/release/lemma_test_pty_peer"))
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    for executable in (arguments.server, arguments.cli, arguments.peer):
        if not executable.is_file():
            parser.error(f"missing executable: {executable}")

    specifications: list[
        tuple[str, str, Callable[[PtyProcess, Path, str, Path], dict[str, Any]]]
    ] = [
        ("shell", "bash", adapt_shell),
        ("shell", "zsh", adapt_shell),
        ("shell", "fish", adapt_shell),
        ("editor", "nvim", run_editor),
        ("editor", "vim", run_editor),
        ("pager", "less", run_pager),
        ("repl", "python3", adapt_repl),
        ("tui", "htop", adapt_tui),
    ]
    cases: list[dict[str, Any]] = []
    missing: list[dict[str, str]] = []
    for category, name, operation in specifications:
        resolved = shutil.which(name)
        if resolved is None:
            missing.append({"category": category, "name": name})
            continue
        cases.append(
            run_case(
                arguments.server,
                arguments.cli,
                arguments.peer,
                category,
                name,
                Path(resolved),
                operation,
            )
        )

    required_categories = {"shell", "editor", "pager", "repl", "tui"}
    passed_categories = {
        str(case["category"]) for case in cases if case.get("status") == "passed"
    }
    expected_names = {name for _, name, _ in specifications}
    passed_names = {str(case["name"]) for case in cases if case.get("status") == "passed"}
    status = (
        "passed"
        if passed_categories == required_categories and passed_names == expected_names and not missing
        else "failed"
    )
    commit, dirty = git_provenance()
    report = {
        "schema": 1,
        "suite": "f5-terminal-application-compatibility",
        "status": status,
        "commit": commit,
        "worktree_dirty": dirty,
        "host": platform.node(),
        "host_fingerprint": host_fingerprint(),
        "system": platform.system(),
        "system_release": platform.release(),
        "architecture": platform.machine(),
        "terminal": {"columns": 80, "rows": 24, "term": "xterm-256color"},
        "required_cases": [
            {"category": category, "name": name} for category, name, _ in specifications
        ],
        "missing_cases": missing,
        "cases": cases,
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
