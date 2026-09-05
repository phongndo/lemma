#!/usr/bin/env python3
"""Installed-bundle startup diagnostics; not a foreground-interaction qualification gate."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import socket
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


def artifact(path: Path) -> dict:
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def stop(runtime: Path) -> None:
    endpoint = runtime / "daemon.sock"
    if endpoint.exists():
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(5)
            peer.connect(str(endpoint))
            peer.sendall(b"S")
            while peer.recv(4096):
                pass
    deadline = time.monotonic() + 5
    while endpoint.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError(f"private daemon did not stop: {endpoint}")
        time.sleep(0.001)


def environment(root: Path, identity: str) -> dict[str, str]:
    for name in ("runtime", "home", "config", "zdot"):
        (root / name).mkdir(mode=0o700)
    return {
        "HOME": str(root / "home"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "ZDOTDIR": str(root / "zdot"),
        "LEMMA_DEV_RUNTIME_DIR": str(root / "runtime"),
        "LEMMA_DEV_BUILD_ID": identity,
        "PATH": "/usr/bin:/bin",
        "TERM": "xterm-256color",
        "LANG": "C",
        "LC_ALL": "C",
    }


def invoke(
    binary: Path, env: dict[str, str], *arguments: str
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(binary), "proc", *arguments],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def sample(binary: Path, root: Path, identity: str, result: dict[str, int]) -> None:
    env = environment(root, identity)
    name = "launcher"

    def proc(*arguments: str) -> dict:
        completed = invoke(binary, env, *arguments)
        if completed.returncode != 0:
            raise RuntimeError(f"{arguments!r}: {completed.stdout}{completed.stderr}")
        document = json.loads(completed.stdout)
        if not document["ok"]:
            raise RuntimeError(str(document))
        return document["results"][0]["result"]

    def panes() -> list[dict]:
        return proc("pane", "list", "--session", name)["panes"]

    def ready(pane: str, marker: str) -> None:
        # The input's echo does not contain the expected marker contiguously.
        proc(
            "pane",
            "input",
            "--session",
            name,
            "--pane",
            pane,
            "--paste",
            f"printf '__LAUNCH_%s__\\n' {marker}",
            "--key",
            "enter",
        )
        deadline = time.monotonic() + 5
        while True:
            captured = proc("pane", "capture", "--session", name, "--pane", pane)
            if f"__LAUNCH_{marker}__" in captured["capture"]["text"]:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(f"shell marker missing: {captured}")
            time.sleep(0.001)

    try:
        started = time.perf_counter_ns()
        proc("session", "start", name, "--cwd", str(root))
        result["fresh_daemon_ack_ns"] = time.perf_counter_ns() - started
        first = panes()[0]["id"]
        ready(first, "COLD")
        result["fresh_daemon_shell_ready_ns"] = time.perf_counter_ns() - started

        started = time.perf_counter_ns()
        proc("pane", "split", "--session", name, "--pane", first, "--right")
        result["warm_pane_ack_ns"] = time.perf_counter_ns() - started
        second = next(pane["id"] for pane in panes() if pane["id"] != first)
        ready(second, "PANE")
        result["warm_pane_shell_ready_ns"] = time.perf_counter_ns() - started

        started = time.perf_counter_ns()
        proc(
            "pane",
            "split",
            "--session",
            name,
            "--pane",
            second,
            "--down",
            "--hold",
            "--",
            str(root / "no-such-program"),
        )
        result["missing_target_ack_ns"] = time.perf_counter_ns() - started
        deadline = time.monotonic() + 5
        while True:
            failed = next(pane for pane in panes() if pane["id"] not in (first, second))
            if failed["process"]["state"] == "exited":
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f"target did not exit: {failed}")
            time.sleep(0.001)
        result["missing_target_exit_ns"] = time.perf_counter_ns() - started
        inspected = proc("pane", "inspect", "--session", name, "--pane", failed["id"])
        if inspected["pane_state"]["process"]["code"] != 127:
            raise RuntimeError(f"target failure changed: {inspected}")
    finally:
        stop(root / "runtime")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=20)
    arguments = parser.parse_args()
    if not 1 <= arguments.samples <= 1000:
        parser.error("samples must be in [1, 1000]")
    binary = arguments.binary.resolve(strict=True)
    helper = binary.with_name("lemma-pty-launcher")
    artifacts = [artifact(binary)] + ([artifact(helper)] if helper.exists() else [])
    identity = hashlib.sha256(
        json.dumps(artifacts, sort_keys=True).encode()
    ).hexdigest()
    report = {
        "schema": "lemma.launcher-probe/v1",
        "status": "incomplete",
        "host": platform.node(),
        "platform": platform.platform(),
        "affinity": sorted(os.sched_getaffinity(0))
        if hasattr(os, "sched_getaffinity")
        else None,
        "scope": "Fresh daemon, not cold OS caches; private development namespace; no observer. "
        "CLI acceptance and shell-output capture include subprocess, discovery, input and polling "
        "costs. Raw syscall/exec completion is a separate native probe. Not a paired product gate.",
        "artifacts": artifacts,
        "combined_installed_bytes": sum(item["bytes"] for item in artifacts),
        "samples": [],
        "summary": {},
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    # Copy only the caller for the missing-helper diagnostic. Never remove a real installed helper.
    with tempfile.TemporaryDirectory(prefix="lemma-lprobe-", dir="/tmp") as directory:
        top = Path(directory)
        broken = top / "broken" / "lemma"
        if helper.exists():
            broken.parent.mkdir()
            shutil.copy2(binary, broken)
        for index in range(arguments.samples):
            current: dict[str, int] = {}
            report["samples"].append(current)
            try:
                with tempfile.TemporaryDirectory(
                    prefix="lemma-lsample-", dir="/tmp"
                ) as directory:
                    sample(binary, Path(directory), identity, current)
                if helper.exists():
                    with tempfile.TemporaryDirectory(
                        prefix="lemma-lfailed-", dir="/tmp"
                    ) as directory:
                        root = Path(directory)
                        env = environment(root, identity)
                        try:
                            started = time.perf_counter_ns()
                            failed = invoke(broken, env, "session", "start", "missing")
                            current["missing_helper_cold_failure_ns"] = (
                                time.perf_counter_ns() - started
                            )
                            if failed.returncode == 0:
                                raise RuntimeError(
                                    f"missing helper unexpectedly succeeded: {failed.stdout}"
                                )
                        finally:
                            stop(root / "runtime")
            except Exception as error:
                report["status"] = "failed"
                report["error"] = repr(error)
                raise
            finally:
                # Retain partial timing and the failure, not just prior successful rounds.
                arguments.output.write_text(json.dumps(report, indent=2) + "\n")
            print(f"launcher sample {index + 1}/{arguments.samples}", flush=True)
    for key in report["samples"][0]:
        values = sorted(row[key] for row in report["samples"])
        report["summary"][key] = {
            "p50": statistics.median(values),
            "p95_nearest_rank": values[math.ceil(len(values) * 0.95) - 1],
            "min": min(values),
            "max": max(values),
        }
    report["status"] = "complete"
    arguments.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
