#!/usr/bin/env python3
"""Attach source, binary, and manifest identity to Google Benchmark JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mux_benchmark import host_fingerprint


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def git_metadata() -> dict[str, Any]:
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
    return {"source_commit": commit, "worktree_dirty": bool(status)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument(
        "--manifest", type=Path, default=Path("benchmarks/workloads.json")
    )
    parser.add_argument("--ghostty-feature-profile")
    parser.add_argument("--command", nargs=argparse.REMAINDER, default=[])
    arguments = parser.parse_args()

    report = json.loads(arguments.report.read_text(encoding="utf-8"))
    context = report.get("context") if isinstance(report, dict) else None
    if not isinstance(context, dict):
        raise RuntimeError("Google Benchmark report has no context")
    executable = arguments.executable.resolve()
    fingerprint = host_fingerprint()
    context.update(
        {
            **git_metadata(),
            "generated_at": datetime.now(UTC).isoformat(),
            "host_name": fingerprint["host_name"],
            "host_model_identifier": fingerprint["model_identifier"],
            "host_cpu_model": fingerprint["cpu_model"],
            "host_physical_cpu_count": fingerprint["physical_cpu_count"],
            "host_memory_bytes": fingerprint["memory_bytes"],
            "executable": str(executable),
            "executable_sha256": sha256(executable),
            "executable_bytes": executable.stat().st_size,
            "manifest": str(arguments.manifest.resolve()),
            "manifest_sha256": sha256(arguments.manifest),
            "benchmark_command": arguments.command,
        }
    )
    if arguments.ghostty_feature_profile is not None:
        context["ghostty_vt_feature_profile"] = arguments.ghostty_feature_profile
    arguments.report.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
