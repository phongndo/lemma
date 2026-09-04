"""Linux backing-file accounting plus platform-neutral, non-waking residency observation."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from tests.support.mux_harness import LemmaServer


def snapshot_residency(server: LemmaServer) -> dict[str, int]:
    result = server.command("proc", "daemon", "inspect")
    if result.status != 0:
        raise RuntimeError(f"snapshot accounting unavailable: {result.output}")
    value = json.loads(result.output)["results"][0]["result"]["daemon"]
    return value["resources"]["snapshot_bytes"]


def snapshot_backing(process: int) -> dict[str, int]:
    if sys.platform != "linux":
        raise RuntimeError("snapshot backing accounting requires Linux /proc")
    files = size = allocated = 0
    for descriptor in Path(f"/proc/{process}/fd").iterdir():
        try:
            name = os.readlink(descriptor)
            if ".lemma-pane-snapshot-" not in name:
                continue
            status = descriptor.stat()
            if os.readlink(descriptor) != name:
                continue  # The descriptor was reused while sampling.
        except FileNotFoundError:
            continue  # Snapshot destruction raced this resource sample.
        files += 1
        size += status.st_size
        allocated += status.st_blocks * 512
    return {
        "snapshot_files": files,
        "snapshot_ciphertext_bytes": size,
        "snapshot_allocated_bytes": allocated,
    }
