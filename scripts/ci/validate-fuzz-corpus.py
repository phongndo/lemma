#!/usr/bin/env python3
"""Validate provenance and content identity for promoted fuzz regressions."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path("fuzz/corpus")
REGISTRY = ROOT / "regressions.json"
TARGETS = {"attachment", "host-input", "api"}


def fail(message: str) -> None:
    raise SystemExit(f"fuzz corpus error: {message}")


def main() -> int:
    try:
        document = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {REGISTRY}: {error}")
    if not isinstance(document, dict) or document.get("schema") != 1:
        fail("regression registry must use schema 1")
    records = document.get("regressions")
    if not isinstance(records, list):
        fail("regressions must be an array")
    identities: set[tuple[str, str]] = set()
    for index, record in enumerate(records):
        label = f"regressions[{index}]"
        if not isinstance(record, dict):
            fail(f"{label} must be an object")
        target = record.get("target")
        name = record.get("name")
        if target not in TARGETS or not isinstance(name, str) or not name:
            fail(f"{label} has an invalid target or name")
        identity = (target, name)
        if identity in identities:
            fail(f"duplicate regression {target}/{name}")
        identities.add(identity)
        expected_path = f"fuzz/corpus/{target}/{name}"
        if record.get("path") != expected_path:
            fail(f"{label}.path must be {expected_path}")
        for field in ("regression", "source_input", "fixed_at", "sha256"):
            value = record.get(field)
            if not isinstance(value, str) or not value:
                fail(f"{label}.{field} must be a non-empty string")
        path = Path(expected_path)
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            fail(f"cannot read {path}: {error}")
        if digest != record["sha256"]:
            fail(f"{path} does not match its promoted SHA-256")
    if records != sorted(
        records, key=lambda record: (record["target"], record["name"])
    ):
        fail("regressions must be sorted by target and name")
    print(f"validated {len(records)} promoted fuzz regressions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
