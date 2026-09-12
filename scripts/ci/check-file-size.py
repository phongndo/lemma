#!/usr/bin/env python3
"""Reject changed regular files larger than the 500 KiB repository boundary."""

from __future__ import annotations

import stat
import subprocess
import sys
from pathlib import Path

MAX_BYTES = 500 * 1024


def _staged_size(path: str) -> int | None:
    changed = subprocess.run(
        ["git", "diff", "--cached", "--quiet", "--", path],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if changed.returncode == 0:
        return None
    if changed.returncode != 1:
        raise RuntimeError(f"could not inspect staged state for {path!r}")

    result = subprocess.run(
        ["git", "cat-file", "-s", f":{path}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        # A staged deletion has no index blob to measure.
        return 0
    return int(result.stdout.strip())


def _worktree_size(path: str) -> int:
    try:
        metadata = Path(path).lstat()
    except FileNotFoundError:
        return 0
    return metadata.st_size if stat.S_ISREG(metadata.st_mode) else 0


def main(paths: list[str]) -> int:
    oversized: list[tuple[str, int]] = []
    for path in paths:
        staged = _staged_size(path)
        size = _worktree_size(path) if staged is None else staged
        if size > MAX_BYTES:
            oversized.append((path, size))

    if not oversized:
        return 0

    for path, size in oversized:
        print(f"{path}: {size} bytes (maximum {MAX_BYTES})", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
