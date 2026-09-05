#!/usr/bin/env python3
"""Exercise the installed executable/helper bundle in a private runtime namespace."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import time
from pathlib import Path


def check(binary: Path, root: Path) -> None:
    binary = binary.resolve(strict=True)
    helper = binary.with_name("lemma-pty-launcher")
    for artifact in (binary, helper):
        mode = artifact.stat().st_mode
        if not stat.S_ISREG(mode) or not os.access(artifact, os.X_OK):
            raise RuntimeError(f"installed executable unavailable: {artifact}")
        if mode & (stat.S_ISUID | stat.S_ISGID):
            raise RuntimeError(
                f"installed executable must not be privileged: {artifact}"
            )
    digest = hashlib.sha256()
    for artifact in (binary, helper):
        digest.update(artifact.name.encode())
        digest.update(b"\0")
        digest.update(artifact.stat().st_size.to_bytes(8, "big"))
        digest.update(artifact.read_bytes())
    for directory in ("runtime", "home", "config", "zdot"):
        (root / directory).mkdir(mode=0o700)
    environment = {
        "HOME": str(root / "home"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "ZDOTDIR": str(root / "zdot"),
        "LEMMA_DEV_RUNTIME_DIR": str(root / "runtime"),
        "LEMMA_DEV_BUILD_ID": digest.hexdigest(),
        "PATH": "/usr/bin:/bin",
        "TERM": "xterm-256color",
        "LANG": "C",
        "LC_ALL": "C",
    }

    def invoke(
        *arguments: str, require: bool = True
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [str(binary), *arguments],
            env=environment,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if require and result.returncode != 0:
            raise RuntimeError(
                f"installed command {arguments!r}: {result.stdout}{result.stderr}"
            )
        return result

    def proc(*arguments: str) -> dict:
        document = json.loads(invoke("proc", *arguments).stdout)
        if not document["ok"]:
            raise RuntimeError(f"installed proc failed: {document}")
        return document["results"][0]["result"]

    direct = subprocess.run([str(helper)], env=environment, timeout=5, check=False)
    if direct.returncode != 127:
        raise RuntimeError(
            "private helper accepted invocation without its inherited setup socket"
        )
    if not invoke("--version").stdout.startswith("lemma "):
        raise RuntimeError("installed version output invalid")
    name = "installed_start"
    try:
        proc(
            "session",
            "start",
            name,
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            "printf '__INSTALLED__'",
        )
        initial = proc("pane", "list", "--session", name)["panes"][0]["id"]
        proc(
            "pane",
            "split",
            "--session",
            name,
            "--pane",
            initial,
            "--right",
            "--hold",
            "--",
            "/bin/sh",
            "-c",
            "printf '__INSTALLED_SPLIT__'",
        )
        deadline = time.monotonic() + 5
        while True:
            panes = proc("pane", "list", "--session", name)["panes"]
            if len(panes) == 2 and all(
                pane["process"]["state"] == "exited" for pane in panes
            ):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f"installed children did not complete: {panes}")
            time.sleep(0.01)
        captured = [
            proc("pane", "capture", "--session", name, "--pane", pane["id"])["capture"][
                "text"
            ]
            for pane in panes
        ]
        if not any("__INSTALLED__" in text for text in captured) or not any(
            "__INSTALLED_SPLIT__" in text for text in captured
        ):
            raise RuntimeError(f"installed PTY output missing: {captured}")
    finally:
        invoke("kill", name, require=False)
    deadline = time.monotonic() + 5
    while (root / "runtime" / "daemon.sock").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("installed daemon did not remove its private endpoint")
        time.sleep(0.01)
    print(
        json.dumps(
            {
                "binary": str(binary),
                "helper": str(helper),
                "binary_bytes": binary.stat().st_size,
                "helper_bytes": helper.stat().st_size,
                "combined_bytes": binary.stat().st_size + helper.stat().st_size,
                "installed_behavior": "passed",
            },
            sort_keys=True,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--binary", type=Path)
    source.add_argument("--build", type=Path)
    arguments = parser.parse_args()
    # Keep the private Unix socket below Darwin's pathname limit, regardless of Nix's TMPDIR.
    with tempfile.TemporaryDirectory(prefix="lemma-install-", dir="/tmp") as temporary:
        root = Path(temporary)
        binary = arguments.binary
        if arguments.build is not None:
            prefix = root / "prefix"
            subprocess.run(
                [
                    "cmake",
                    "--install",
                    str(arguments.build.resolve()),
                    "--prefix",
                    str(prefix),
                ],
                check=True,
            )
            binary = prefix / "bin" / "lemma"
        check(binary, root)


if __name__ == "__main__":
    main()
