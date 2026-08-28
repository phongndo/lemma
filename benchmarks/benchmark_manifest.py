#!/usr/bin/env python3
"""Load the single versioned benchmark scenario and policy manifest."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MANIFEST_SCHEMA = 4
SUBJECTS = ("direct", "lemma", "tmux", "zellij", "herdr")
PROCESS_STATUSES = ("completed", "failed", "unsupported")


class ManifestError(ValueError):
    """The benchmark manifest does not describe a bounded executable suite."""


def _nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{label} must be a non-empty string")
    return value


def _string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ManifestError(f"{label} must be a non-empty array")
    result = []
    for index, item in enumerate(value):
        result.append(_nonempty_string(item, f"{label}[{index}]"))
    if len(result) != len(set(result)):
        raise ManifestError(f"{label} contains duplicate values")
    return result


def load_manifest(path: Path = Path("benchmarks/workloads.json")) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(
            f"cannot read benchmark manifest {path}: {error}"
        ) from error
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict) or manifest.get("schema") != MANIFEST_SCHEMA:
        raise ManifestError(f"benchmark manifest must use schema {MANIFEST_SCHEMA}")

    terminal = manifest.get("terminal")
    if not isinstance(terminal, dict):
        raise ManifestError("terminal must be an object")
    for dimension in ("columns", "rows"):
        value = terminal.get(dimension)
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 0 < value <= 1_000
        ):
            raise ManifestError(f"terminal.{dimension} is outside the supported bounds")
    _nonempty_string(terminal.get("term"), "terminal.term")

    workloads = manifest.get("process_workloads")
    if not isinstance(workloads, list) or not workloads:
        raise ManifestError("process_workloads must be a non-empty array")
    identifiers: list[str] = []
    cli_modes: list[str] = []
    for index, workload in enumerate(workloads):
        label = f"process_workloads[{index}]"
        if not isinstance(workload, dict):
            raise ManifestError(f"{label} must be an object")
        identifiers.append(_nonempty_string(workload.get("id"), f"{label}.id"))
        cli_modes.append(
            _nonempty_string(workload.get("cli_mode"), f"{label}.cli_mode")
        )
        _nonempty_string(workload.get("fixture"), f"{label}.fixture")
        _nonempty_string(
            workload.get("completion_endpoint"), f"{label}.completion_endpoint"
        )
        subjects = _string_list(workload.get("subjects"), f"{label}.subjects")
        unknown = sorted(set(subjects).difference(SUBJECTS))
        if unknown:
            raise ManifestError(
                f"{label}.subjects contains unknown subjects: {unknown}"
            )
        _string_list(workload.get("metrics"), f"{label}.metrics")
    if len(identifiers) != len(set(identifiers)):
        raise ManifestError("process workload IDs must be unique")
    if len(cli_modes) != len(set(cli_modes)):
        raise ManifestError("process workload cli_mode values must be unique")

    suites = manifest.get("suites")
    if not isinstance(suites, dict) or not suites:
        raise ManifestError("suites must be a non-empty object")
    known = set(identifiers)
    for name, members in suites.items():
        _nonempty_string(name, "suite name")
        selected = _string_list(members, f"suites.{name}")
        unknown = sorted(set(selected).difference(known))
        if unknown:
            raise ManifestError(f"suites.{name} contains unknown workloads: {unknown}")

    policies = manifest.get("sample_policies")
    if not isinstance(policies, dict) or set(policies) != {
        "smoke",
        "extended",
        "gate",
    }:
        raise ManifestError("sample_policies must contain smoke, extended, and gate")
    for name, policy in policies.items():
        if not isinstance(policy, dict):
            raise ManifestError(f"sample_policies.{name} must be an object")
        for field in (
            "micro_repetitions",
            "process_repetitions",
            "profile_repetitions",
        ):
            value = policy.get(field)
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or not 1 <= value <= 10_000
            ):
                raise ManifestError(f"sample_policies.{name}.{field} is invalid")
        for field in ("micro_min_time_seconds", "micro_warmup_seconds"):
            value = policy.get(field)
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not 0 <= value <= 60
            ):
                raise ManifestError(f"sample_policies.{name}.{field} is invalid")

    comparison_policy = manifest.get("comparison_policy")
    practical = (
        comparison_policy.get("practical_effect_thresholds")
        if isinstance(comparison_policy, dict)
        else None
    )
    if not isinstance(practical, dict):
        raise ManifestError("comparison_policy has no practical effect thresholds")
    for name in ("minimum_relative_change", "minimum_latency_change_ns"):
        value = practical.get(name)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise ManifestError(f"comparison_policy.{name} is invalid")
    expected_failures = comparison_policy.get("expected_failures")
    if not isinstance(expected_failures, list):
        raise ManifestError("comparison_policy.expected_failures must be an array")
    failure_signatures: list[tuple[str, str, str]] = []
    workload_subjects = {
        workload["id"]: set(workload["subjects"]) for workload in workloads
    }
    for index, failure in enumerate(expected_failures):
        label = f"comparison_policy.expected_failures[{index}]"
        if not isinstance(failure, dict):
            raise ManifestError(f"{label} must be an object")
        subject = _nonempty_string(failure.get("subject"), f"{label}.subject")
        workload = _nonempty_string(failure.get("workload"), f"{label}.workload")
        _nonempty_string(failure.get("classification"), f"{label}.classification")
        error_contains = _nonempty_string(
            failure.get("error_contains"), f"{label}.error_contains"
        )
        if subject not in SUBJECTS or workload not in workload_subjects:
            raise ManifestError(f"{label} identifies an unknown subject or workload")
        if subject not in workload_subjects[workload]:
            raise ManifestError(f"{label} identifies an unsupported workload")
        failure_signatures.append((subject, workload, error_contains))
    if len(failure_signatures) != len(set(failure_signatures)):
        raise ManifestError(
            "comparison_policy.expected_failures contains duplicate signatures"
        )

    budgets = manifest.get("regression_budgets")
    scope = budgets.get("scope") if isinstance(budgets, dict) else None
    maximum_load = (
        scope.get("maximum_load_average_1m") if isinstance(scope, dict) else None
    )
    if (
        not isinstance(maximum_load, (int, float))
        or isinstance(maximum_load, bool)
        or maximum_load <= 0
    ):
        raise ManifestError(
            "regression_budgets.scope.maximum_load_average_1m is invalid"
        )

    lab = manifest.get("terminal_lab")
    if not isinstance(lab, dict) or lab.get("schema") != 1:
        raise ManifestError("terminal_lab must use schema 1")
    terminals = _string_list(lab.get("terminals"), "terminal_lab.terminals")
    if terminals != ["ghostty", "kitty", "wezterm"]:
        raise ManifestError(
            "terminal_lab.terminals must be ghostty, kitty, and wezterm"
        )
    if _string_list(lab.get("subjects"), "terminal_lab.subjects") != list(SUBJECTS):
        raise ManifestError(
            "terminal_lab.subjects must contain the complete subject matrix"
        )
    endpoints = _string_list(lab.get("endpoints"), "terminal_lab.endpoints")
    if "input_to_photon_ns" not in endpoints:
        raise ManifestError("terminal_lab must define an input-to-photon endpoint")


def expected_failure(
    manifest: dict[str, Any], subject: str, workload: str, error: str
) -> dict[str, str] | None:
    for failure in manifest["comparison_policy"]["expected_failures"]:
        if (
            failure["subject"] == subject
            and failure["workload"] == workload
            and failure["error_contains"] in error
        ):
            return failure
    return None


def workload_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {workload["id"]: workload for workload in manifest["process_workloads"]}


def workload_for_mode(manifest: dict[str, Any], mode: str) -> dict[str, Any] | None:
    return next(
        (
            workload
            for workload in manifest["process_workloads"]
            if workload["cli_mode"] == mode
        ),
        None,
    )


def suite_workloads(manifest: dict[str, Any], suite: str) -> list[dict[str, Any]]:
    scenarios = workload_map(manifest)
    try:
        return [scenarios[identifier] for identifier in manifest["suites"][suite]]
    except KeyError as error:
        raise ManifestError(f"unknown benchmark suite: {suite}") from error
