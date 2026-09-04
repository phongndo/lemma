#!/usr/bin/env python3
"""Record release executable sizes, stripped sizes, and direct dependencies."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def source_manifest() -> dict[str, Any]:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        check=True,
        capture_output=True,
    ).stdout
    paths = sorted(path for path in listed.split(b"\0") if path)
    digest = hashlib.sha256()
    for encoded_path in paths:
        path = Path(os.fsdecode(encoded_path))
        digest.update(len(encoded_path).to_bytes(8, "big"))
        digest.update(encoded_path)
        if path.is_symlink():
            payload = b"symlink\0" + os.fsencode(os.readlink(path))
        elif path.is_dir():
            status = subprocess.run(
                ["git", "-C", str(path), "status", "--porcelain=v1"],
                check=True,
                capture_output=True,
            ).stdout
            if status:
                raise RuntimeError(f"source submodule is dirty: {path}")
            revision = subprocess.run(
                ["git", "-C", str(path), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
            ).stdout.strip()
            payload = b"submodule\0" + revision
        else:
            payload = b"file\0" + path.read_bytes()
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    status = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    return {
        "algorithm": "sha256",
        "digest": digest.hexdigest(),
        "file_count": len(paths),
        "dirty": bool(status),
        "changed_path_count": len(status),
    }


def cmake_configuration(build_directory: Path) -> dict[str, str]:
    wanted = {
        "CMAKE_BUILD_TYPE",
        "LEMMA_BUILD_TESTS",
        "LEMMA_BUILD_BENCHMARKS",
        "LEMMA_ENABLE_LATENCY_TRACE",
        "LEMMA_GHOSTTY_VT_FEATURE_PROFILE",
    }
    values: dict[str, str] = {}
    for line in (build_directory / "CMakeCache.txt").read_text().splitlines():
        if line.startswith("//") or line.startswith("#") or "=" not in line:
            continue
        declaration, value = line.split("=", maxsplit=1)
        name = declaration.split(":", maxsplit=1)[0]
        if name in wanted:
            values[name] = value
    missing = wanted - values.keys()
    if missing:
        raise RuntimeError(f"release configuration is missing: {sorted(missing)}")
    return values


def binary_record(path: Path) -> dict[str, Any]:
    record: dict[str, Any] = {"path": str(path.resolve()), "bytes": path.stat().st_size}
    with tempfile.TemporaryDirectory(prefix="lemma-stripped-") as temporary:
        stripped = Path(temporary) / path.name
        shutil.copy2(path, stripped)
        subprocess.run(["strip", "-x", str(stripped)], check=True)
        record["stripped_bytes"] = stripped.stat().st_size
    if platform.system() == "Darwin":
        dependencies = subprocess.run(
            ["otool", "-L", str(path)], check=True, capture_output=True, text=True
        ).stdout.splitlines()[1:]
        record["dependencies"] = [
            line.strip().split(" (", 1)[0] for line in dependencies
        ]
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-directory", type=Path, default=Path("build/release"))
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()

    binaries: dict[str, Any] = {}
    for name in (
        "lemma",
        "lemma_test_server",
        "lemma_test_cli",
        "lemma_test_pty_peer",
        "lemma_benchmark_probe",
    ):
        path = arguments.build_directory / name
        binaries[name] = binary_record(path)
    for name in ("tmux", "zellij"):
        resolved = shutil.which(name)
        binaries[name] = (
            {"available": False}
            if resolved is None
            else {
                "available": True,
                "path": resolved,
                "bytes": os.stat(resolved).st_size,
            }
        )

    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    report = {
        "schema": 2,
        "commit": commit,
        "source_manifest": source_manifest(),
        "cmake_configuration": cmake_configuration(arguments.build_directory),
        "system": platform.platform(),
        "binaries": binaries,
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
