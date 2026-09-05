#!/usr/bin/env python3
"""Build and benchmark the pinned libghostty-vt feature profiles."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

FEATURE_NAMES = (
    "snapshot",
    "formatter",
    "selection",
    "render_state",
    "input_encode",
    "color",
    "grid_introspection",
    "glyph_protocol",
    "kitty_graphics",
)


def load_pin(path: Path) -> dict[str, Any]:
    pin = json.loads(path.read_text(encoding="utf-8"))
    profiles = pin.get("vt_feature_profiles")
    if not isinstance(profiles, dict) or not profiles:
        raise ValueError("Ghostty pin has no VT feature profiles")
    production = pin.get("production_vt_feature_profile")
    if production not in profiles:
        raise ValueError("production Ghostty VT feature profile is not defined")
    for name, value in profiles.items():
        if not isinstance(value, dict) or not isinstance(value.get("zig_value"), str):
            raise ValueError(f"Ghostty VT feature profile {name!r} has no Zig value")
        features = value.get("features")
        if not isinstance(features, dict) or set(features) != set(FEATURE_NAMES):
            raise ValueError(
                f"Ghostty VT feature profile {name!r} has invalid features"
            )
        if not all(isinstance(enabled, bool) for enabled in features.values()):
            raise ValueError(
                f"Ghostty VT feature profile {name!r} has non-boolean features"
            )
    return pin


def run(
    command: list[str], *, cwd: Path, capture: bool = False
) -> subprocess.CompletedProcess[str]:
    print(f"+ {shlex.join(command)}", flush=True)
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        capture_output=capture,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def stripped_size(path: Path) -> int:
    with tempfile.TemporaryDirectory(
        prefix="lemma-ghostty-feature-strip-"
    ) as directory:
        stripped = Path(directory) / path.name
        shutil.copy2(path, stripped)
        subprocess.run(["strip", "-x", str(stripped)], check=True, capture_output=True)
        return stripped.stat().st_size


def one_path(paths: list[Path], description: str) -> Path:
    if len(paths) != 1:
        raise RuntimeError(f"expected one {description}, found {len(paths)}")
    return paths[0]


def conan_install(root: Path, build_root: Path) -> Path:
    conan_directory = build_root / "conan"
    run(
        [
            "conan",
            "install",
            ".",
            "--lockfile=conan.lock",
            f"--output-folder={conan_directory}",
            "--profile:all=conan/profiles/llvm",
            "--settings=build_type=Release",
            "--conf=tools.cmake.cmaketoolchain:user_presets=",
            "--build=missing",
        ],
        cwd=root,
    )
    return (conan_directory / "conan_toolchain.cmake").resolve()


def ghostty_cmake_arguments() -> list[str]:
    names = (
        "LEMMA_GHOSTTY_SOURCE_DIR",
        "LEMMA_GHOSTTY_NIX_SOURCE_REV",
        "LEMMA_GHOSTTY_ZIG_SYSTEM_DIR",
        "LEMMA_GHOSTTY_ZIG_LIBC",
        "LEMMA_GHOSTTY_ZIG_TARGET",
    )
    return [f"-D{name}={os.environ[name]}" for name in names if os.environ.get(name)]


def build_profile(
    root: Path,
    build_root: Path,
    toolchain: Path,
    profile: str,
    benchmark_filter: str,
    benchmark_min_time: str,
    benchmark_repetitions: int,
    cooldown_seconds: float,
) -> dict[str, Any]:
    build_directory = (build_root / "build" / profile).resolve()
    build_directory.mkdir(parents=True, exist_ok=True)
    configure_command = [
        "cmake",
        "-S",
        str(root),
        "-B",
        str(build_directory),
        "-G",
        "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
        "-DCMAKE_CXX_SCAN_FOR_MODULES=OFF",
        f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
        "-DLEMMA_BUILD_TESTS=OFF",
        "-DLEMMA_BUILD_BENCHMARKS=ON",
        "-DLEMMA_ENABLE_LATENCY_TRACE=OFF",
        f"-DLEMMA_GHOSTTY_VT_FEATURE_PROFILE={profile}",
        *ghostty_cmake_arguments(),
    ]
    run(configure_command, cwd=root)
    build_command = [
        "cmake",
        "--build",
        str(build_directory),
        "--target",
        "lemma",
        "lemma_benchmarks",
        "lemma_memory_census",
        "lemma_terminal_memory_probe",
    ]
    run(build_command, cwd=root)
    time.sleep(cooldown_seconds)

    archive = one_path(
        list(build_directory.glob("_deps/ghostty/*/Release/*/lib/libghostty-vt.a")),
        "libghostty-vt archive",
    )
    feature_manifest_path = one_path(
        list(
            build_directory.glob(
                "_deps/ghostty/*/Release/*/share/lemma/ghostty-vt-features.json"
            )
        ),
        "validated Ghostty feature manifest",
    )
    feature_manifest = json.loads(feature_manifest_path.read_text(encoding="utf-8"))
    if feature_manifest["profile"] != profile:
        raise RuntimeError(
            "built Ghostty feature profile does not match the requested profile"
        )

    benchmark_output = build_root / f"{profile}-terminal-benchmarks.json"
    benchmark_command = [
        str(build_directory / "lemma_benchmarks"),
        f"--benchmark_filter={benchmark_filter}",
        f"--benchmark_min_time={benchmark_min_time}",
        f"--benchmark_repetitions={benchmark_repetitions}",
        "--benchmark_enable_random_interleaving=true",
        "--benchmark_display_aggregates_only=true",
        f"--benchmark_out={benchmark_output.resolve()}",
        "--benchmark_out_format=json",
    ]
    run(benchmark_command, cwd=root)
    annotation_command = [
        sys.executable,
        str(root / "benchmarks/annotate_micro_report.py"),
        "--report",
        str(benchmark_output.resolve()),
        "--executable",
        str(build_directory / "lemma_benchmarks"),
        "--manifest",
        str(root / "benchmarks/workloads.json"),
        "--ghostty-feature-profile",
        profile,
        "--command",
        *benchmark_command,
    ]
    run(annotation_command, cwd=root)

    memory_command = [str(build_directory / "lemma_memory_census")]
    memory = json.loads(run(memory_command, cwd=root, capture=True).stdout)
    section_command = (
        ["size", "-m", str(build_directory / "lemma")]
        if platform.system() == "Darwin"
        else ["size", "-A", str(build_directory / "lemma")]
    )
    section_output = build_root / f"{profile}-lemma-sections.txt"
    section_output.write_text(
        run(section_command, cwd=root, capture=True).stdout, encoding="utf-8"
    )
    relocation_command = (
        ["otool", "-rv", str(build_directory / "lemma")]
        if platform.system() == "Darwin"
        else ["readelf", "-rW", str(build_directory / "lemma")]
    )
    relocation_output = build_root / f"{profile}-lemma-relocations.txt"
    relocation_text = run(relocation_command, cwd=root, capture=True).stdout
    relocation_output.write_text(relocation_text, encoding="utf-8")
    relocation_count = sum(
        1
        for line in relocation_text.splitlines()
        if re.match(r"^\s*[0-9a-fA-F]+\s+", line) is not None
    )

    page_pool_report: str | None = None
    if platform.system() == "Linux":
        page_pool_output = build_root / f"{profile}-page-pool.json"
        run(
            [
                sys.executable,
                str(root / "benchmarks/ghostty_page_pool_probe.py"),
                "--probe",
                str(build_directory / "lemma_terminal_memory_probe"),
                "--output",
                str(page_pool_output),
                "--scrollback-lines",
                "0,5000",
            ],
            cwd=root,
        )
        page_pool_report = str(page_pool_output.resolve())

    lemma = build_directory / "lemma"
    return {
        "profile": profile,
        "build_directory": str(build_directory),
        "configure_command": configure_command,
        "build_command": build_command,
        "benchmark_command": benchmark_command,
        "annotation_command": annotation_command,
        "benchmark_report": str(benchmark_output.resolve()),
        "section_report": str(section_output.resolve()),
        "relocation_report": str(relocation_output.resolve()),
        "relocation_count": relocation_count,
        "page_pool_report": page_pool_report,
        "validated_features": feature_manifest,
        "artifacts": {
            "libghostty_vt": {
                "path": str(archive),
                "bytes": archive.stat().st_size,
                "stripped_bytes": stripped_size(archive),
                "sha256": sha256(archive),
            },
            "lemma": {
                "path": str(lemma),
                "bytes": lemma.stat().st_size,
                "stripped_bytes": stripped_size(lemma),
                "sha256": sha256(lemma),
            },
        },
        "terminal_memory": memory,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pin", type=Path, default=Path("third_party/ghostty-metadata/PIN.json")
    )
    parser.add_argument("--profile", action="append", dest="profiles")
    parser.add_argument(
        "--build-root", type=Path, default=Path("build/ghostty-feature-matrix")
    )
    parser.add_argument(
        "--output", type=Path, default=Path("build/ghostty-feature-matrix/results.json")
    )
    parser.add_argument("--benchmark-filter", default="^benchmark_terminal_")
    parser.add_argument("--benchmark-min-time", default="0.05s")
    parser.add_argument("--benchmark-repetitions", type=int, default=5)
    parser.add_argument("--cooldown-seconds", type=float, default=30.0)
    arguments = parser.parse_args()

    root = Path(
        run(
            ["git", "rev-parse", "--show-toplevel"], cwd=Path.cwd(), capture=True
        ).stdout.strip()
    )
    pin_path = (root / arguments.pin).resolve()
    pin = load_pin(pin_path)
    available_profiles = pin["vt_feature_profiles"]
    profiles = arguments.profiles or list(available_profiles)
    unknown = [profile for profile in profiles if profile not in available_profiles]
    if unknown:
        parser.error(f"unknown profile(s): {', '.join(unknown)}")
    if len(set(profiles)) != len(profiles):
        parser.error("profiles must be unique")
    if arguments.benchmark_repetitions < 1:
        parser.error("benchmark repetitions must be positive")
    if arguments.cooldown_seconds < 0:
        parser.error("cooldown seconds must be non-negative")

    build_root = (root / arguments.build_root).resolve()
    build_root.mkdir(parents=True, exist_ok=True)
    toolchain = conan_install(root, build_root)
    records = [
        build_profile(
            root,
            build_root,
            toolchain,
            profile,
            arguments.benchmark_filter,
            arguments.benchmark_min_time,
            arguments.benchmark_repetitions,
            arguments.cooldown_seconds,
        )
        for profile in profiles
    ]
    baseline = records[0]["artifacts"]
    for record in records:
        for artifact, values in record["artifacts"].items():
            values["bytes_delta_from_first"] = (
                values["bytes"] - baseline[artifact]["bytes"]
            )
            values["stripped_bytes_delta_from_first"] = (
                values["stripped_bytes"] - baseline[artifact]["stripped_bytes"]
            )

    commit = run(["git", "rev-parse", "HEAD"], cwd=root, capture=True).stdout.strip()
    dirty = bool(
        run(
            ["git", "status", "--porcelain", "--untracked-files=normal"],
            cwd=root,
            capture=True,
        ).stdout
    )
    report = {
        "schema": 1,
        "suite": "lemma-ghostty-feature-matrix",
        "generated_at": datetime.now(UTC).isoformat(),
        "source_commit": commit,
        "worktree_dirty": dirty,
        "host": socket.gethostname(),
        "system": platform.platform(),
        "ghostty_commit": pin["commit"],
        "production_profile": pin["production_vt_feature_profile"],
        "profile_definitions": {
            profile: available_profiles[profile] for profile in profiles
        },
        "benchmark_policy": {
            "filter": arguments.benchmark_filter,
            "minimum_time": arguments.benchmark_min_time,
            "repetitions": arguments.benchmark_repetitions,
            "cooldown_seconds": arguments.cooldown_seconds,
        },
        "profiles": records,
    }
    output = (root / arguments.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"Ghostty feature matrix: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
