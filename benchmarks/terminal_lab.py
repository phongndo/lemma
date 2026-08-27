#!/usr/bin/env python3
"""Create or validate GUI terminal-lab reports from external capture samples."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from benchmark_manifest import SUBJECTS, load_manifest


def file_record(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
    return {"path": str(resolved), "sha256": digest, "bytes": resolved.stat().st_size}


def percentile(samples: list[int], quantile: float) -> int:
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(quantile * len(ordered)) - 1)]


def validate_samples(value: Any) -> list[dict[str, int]]:
    if not isinstance(value, list) or len(value) < 1:
        raise ValueError("capture input must contain a non-empty sample array")
    samples: list[dict[str, int]] = []
    sequences: set[int] = set()
    for index, raw_sample in enumerate(value):
        if not isinstance(raw_sample, dict):
            raise ValueError(f"sample {index} must be an object")
        sample = cast(dict[str, object], raw_sample)
        required = {"sequence", "input_jitter_ns", "input_to_photon_ns"}
        if not required.issubset(sample):
            raise ValueError(
                f"sample {index} is missing {sorted(required.difference(sample))}"
            )
        normalized: dict[str, int] = {}
        for name, field in sample.items():
            if name not in {
                "sequence",
                "input_jitter_ns",
                "key_to_pty_ns",
                "key_to_outer_bytes_ns",
                "input_to_photon_ns",
                "frame_interval_ns",
            }:
                raise ValueError(f"sample {index} has unknown field {name!r}")
            if (
                not isinstance(field, int)
                or isinstance(field, bool)
                or field < 0
                or (name != "input_jitter_ns" and field == 0)
            ):
                raise ValueError(
                    f"sample {index}.{name} must be a valid bounded integer"
                )
            normalized[name] = field
        if normalized["sequence"] < 1 or normalized["input_to_photon_ns"] < 1:
            raise ValueError(
                f"sample {index} has an invalid sequence or photon latency"
            )
        if normalized["sequence"] in sequences:
            raise ValueError("capture sample sequences must be unique")
        sequences.add(normalized["sequence"])
        samples.append(normalized)
    if len(samples) > 1 and len({sample["input_jitter_ns"] for sample in samples}) == 1:
        raise ValueError(
            "capture samples must jitter input timing relative to display refresh"
        )
    return samples


def summaries(samples: list[dict[str, int]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for endpoint in (
        "key_to_pty_ns",
        "key_to_outer_bytes_ns",
        "input_to_photon_ns",
        "frame_interval_ns",
    ):
        values = [sample[endpoint] for sample in samples if endpoint in sample]
        if not values:
            continue
        result[endpoint] = {
            "samples": len(values),
            "p50_ns": percentile(values, 0.50),
            "p95_ns": percentile(values, 0.95),
            "p99_ns": percentile(values, 0.99),
            "p95_valid": len(values) >= 20,
            "p99_valid": len(values) >= 100,
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--terminal", choices=("ghostty", "kitty", "wezterm"), required=True
    )
    parser.add_argument("--subject", choices=SUBJECTS, required=True)
    parser.add_argument(
        "--configuration", choices=("stock", "normalized"), required=True
    )
    parser.add_argument(
        "--capture", choices=("hardware_photodiode", "software_pixel"), required=True
    )
    parser.add_argument("--terminal-binary", type=Path, required=True)
    parser.add_argument("--subject-binary", type=Path)
    parser.add_argument("--terminal-config", type=Path, required=True)
    parser.add_argument("--display", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    load_manifest()
    if arguments.subject != "direct" and arguments.subject_binary is None:
        parser.error("--subject-binary is required for mux subjects")
    for path in (
        arguments.terminal_binary,
        arguments.subject_binary,
        arguments.terminal_config,
        arguments.display,
        arguments.samples,
    ):
        if path is None:
            continue
        if not path.is_file():
            parser.error(f"missing file: {path}")
    try:
        display = json.loads(arguments.display.read_text(encoding="utf-8"))
        if not isinstance(display, dict) or set(display) != {
            "identifier",
            "refresh_hz",
            "variable_refresh",
            "sensor_position",
        }:
            raise ValueError("display profile has invalid fields")
        if (
            not isinstance(display["identifier"], str)
            or not isinstance(display["sensor_position"], str)
            or not isinstance(display["refresh_hz"], (int, float))
            or isinstance(display["refresh_hz"], bool)
            or display["refresh_hz"] <= 0
            or not isinstance(display["variable_refresh"], bool)
        ):
            raise ValueError("display profile has invalid values")
        captured = json.loads(arguments.samples.read_text(encoding="utf-8"))
        samples = validate_samples(captured)
    except (json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))

    report = {
        "schema": 1,
        "suite": "terminal-native-feel",
        "generated_at": datetime.now(UTC).isoformat(),
        "host": platform.node(),
        "system": platform.platform(),
        "terminal": arguments.terminal,
        "subject": arguments.subject,
        "configuration_profile": arguments.configuration,
        "capture_method": arguments.capture,
        "display": display,
        "terminal_binary": file_record(arguments.terminal_binary),
        "subject_binary": (
            file_record(arguments.subject_binary)
            if arguments.subject_binary is not None
            else None
        ),
        "manifest_sha256": hashlib.sha256(
            Path("benchmarks/workloads.json").read_bytes()
        ).hexdigest(),
        "terminal_config_sha256": hashlib.sha256(
            arguments.terminal_config.read_bytes()
        ).hexdigest(),
        "samples": samples,
        "summary": summaries(samples),
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
