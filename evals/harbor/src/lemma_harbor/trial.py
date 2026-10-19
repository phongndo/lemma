"""What a Harbor trial of Lemma is made of, apart from Harbor.

The model ref and the key a run needs, the trial home's config, and what the
run reports (Lemma's usage, read back from `lemma run --json` or the session
log). Nothing here imports Harbor, so it is tested without it.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

# The variable the llm plugin (`llm.http`) reads each built-in provider's API
# key from. Only the chosen provider's is passed into the task's container;
# `--ae NAME=value` passes any other.
KEY_VARIABLES = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "opencode": "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
}


def model_ref(model_name: str | None) -> str:
    """Harbor's `-m provider/model` as Lemma's `<provider>/<model>` ref: the same, as Lemma's built-ins have LiteLLM's names."""
    provider, slash, model = (model_name or "").partition("/")
    if not slash or not provider or not model:
        raise ValueError(f"-m takes <provider>/<model>, as Lemma's model refs do (anthropic/claude-sonnet-5-5); got {model_name!r}")
    return f"{provider}/{model}"


def key_variable(ref: str) -> str | None:
    """The environment variable holding the key for the ref's provider, when it is a built-in one."""
    return KEY_VARIABLES.get(ref.partition("/")[0])


def thinking_level(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if value not in THINKING_LEVELS:
        raise ValueError(f"thinking is one of {', '.join(THINKING_LEVELS)}; got {value!r}")
    return value


# ---------------------------------------------------------------- the trial home's config


def trial_defaults(lemma: str) -> dict[str, Any]:
    """Config every trial home starts from, beneath the user's.

    The transport takes a free port, so it never meets a task's service on
    Lemma's default one. `ask_user` is off: nobody answers in a trial, and it
    would wait for a client before telling the model so. The agent's `lemma`
    is the installed wrapper, which needs no Node.js on the task's PATH.
    """
    return {
        "plugins": {
            "transport.server": {"config": {"port": 0}},
            "tools.ask": {"enabled": False},
            "agent.loop": {"config": {"cli": lemma}},
        }
    }


def merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    """`override` over `base`, objects merged key by key, anything else replaced."""
    merged = dict(base)
    for key, value in override.items():
        current = merged.get(key)
        merged[key] = merge(current, value) if isinstance(current, Mapping) and isinstance(value, Mapping) else value
    return merged


def strip_jsonc(text: str) -> str:
    """JSONC as JSON: comments and trailing commas outside strings removed."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif c == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
                i += 1
            else:
                out.append(c)
                i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def load_config(source: Mapping[str, Any] | str | Path | None) -> dict[str, Any] | None:
    """A Lemma config given to the agent (`--ak config=…`): inline, or a JSON or JSONC file."""
    if source is None:
        return None
    if isinstance(source, Mapping):
        return dict(source)
    path = Path(source)
    try:
        value = json.loads(strip_jsonc(path.read_text()))
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read the Lemma config {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"The Lemma config {path} is not an object")
    return value


def trial_config(lemma: str, user: Mapping[str, Any] | None) -> dict[str, Any]:
    return merge(trial_defaults(lemma), user or {})


# ---------------------------------------------------------------- what the run reports

USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
COST_KEYS = ("input", "output", "cacheRead", "cacheWrite", "total")


def empty_usage() -> dict[str, Any]:
    return {**{key: 0 for key in USAGE_KEYS}, "cost": {key: 0.0 for key in COST_KEYS}}


def add_usage(a: Mapping[str, Any], b: Mapping[str, Any] | None) -> dict[str, Any]:
    """Lemma's `addUsage`, tolerating missing fields."""
    if not isinstance(b, Mapping):
        return dict(a)
    cost_a, cost_b = a.get("cost") or {}, b.get("cost") or {}
    total = {key: (a.get(key) or 0) + (b.get(key) or 0) for key in USAGE_KEYS}
    if "reasoning" in a or "reasoning" in b:
        total["reasoning"] = (a.get("reasoning") or 0) + (b.get("reasoning") or 0)
    return {**total, "cost": {key: (cost_a.get(key) or 0) + (cost_b.get(key) or 0) for key in COST_KEYS}}


def cache_hit_rate(usage: Mapping[str, Any]) -> float | None:
    """Lemma's `cacheHitRate`: the share of input the provider's cache served."""
    read = usage.get("cacheRead") or 0
    total = (usage.get("input") or 0) + read + (usage.get("cacheWrite") or 0)
    return None if total == 0 else read / total


@dataclass
class Report:
    """How a trial's turn went, as Lemma recorded it."""

    # `run`: `lemma run --json`'s result; `log`: summed from the session log, when the run printed none (a timeout).
    source: str
    session: str | None = None
    reason: str | None = None
    error: str | None = None
    steps: int = 0
    tool_calls: int = 0
    duration_ms: int | None = None
    usage: dict[str, Any] = field(default_factory=empty_usage)

    def harbor_counts(self) -> dict[str, Any]:
        """Harbor's `AgentContext` totals: its input count includes cached input."""
        u = self.usage
        return {
            "n_input_tokens": (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0),
            "n_cache_tokens": u.get("cacheRead") or 0,
            "n_output_tokens": u.get("output") or 0,
            "cost_usd": (u.get("cost") or {}).get("total"),
        }

    def metadata(self) -> dict[str, Any]:
        value = {key: item for key, item in asdict(self).items() if item is not None}
        value["cache_hit_rate"] = cache_hit_rate(self.usage)
        return value


def parse_result(text: str | None) -> dict[str, Any] | None:
    """`lemma run --json`'s result: one JSON object (the last line that is one, should anything precede it)."""
    if not text or not text.strip():
        return None
    candidates = [text, *reversed(text.strip().splitlines())]
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict) and "reason" in value:
            return value
    return None


def report_from_result(result: Mapping[str, Any]) -> Report:
    usage = add_usage(empty_usage(), result.get("usage"))
    return Report(
        source="run",
        session=result.get("session"),
        reason=result.get("reason"),
        error=result.get("error"),
        steps=int(result.get("steps") or 0),
        tool_calls=int(result.get("toolCalls") or 0),
        duration_ms=result.get("duration"),
        usage=usage,
    )


def report_from_log(lines: Iterable[str]) -> Report | None:
    """The session's usage and steps summed from its log, as `trajectory` counts a turn's.

    A trial's session has one prompt and so one turn: its answers, its
    failed attempts, and its compactions' summaries are what it cost.
    """
    session = None
    usage = empty_usage()
    steps = tool_calls = 0
    started = ended = None
    reason = error = None
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "session":
            session = entry.get("id")
            continue
        data = entry.get("data")
        if not isinstance(data, dict):
            continue
        kind = data.get("type")
        if kind == "turn-start":
            started = entry.get("at")
        elif kind == "turn-end":
            ended, reason, error = entry.get("at"), data.get("reason"), data.get("error")
        elif kind == "step-start":
            steps += 1
        elif kind == "attempt":
            usage = add_usage(usage, (data.get("message") or {}).get("usage"))
        elif kind == "compaction":
            usage = add_usage(usage, data.get("usage"))
        elif kind == "message":
            message = data.get("message") or {}
            if message.get("role") == "assistant":
                usage = add_usage(usage, message.get("usage"))
                tool_calls += sum(1 for block in message.get("content") or [] if isinstance(block, dict) and block.get("type") == "toolCall")
    if session is None:
        return None
    duration = ended - started if isinstance(started, (int, float)) and isinstance(ended, (int, float)) else None
    return Report(
        source="log",
        session=session,
        reason=reason or "unfinished",
        error=error,
        steps=steps,
        tool_calls=tool_calls,
        duration_ms=duration,
        usage=usage,
    )


def read_report(logs_dir: Path) -> Report | None:
    """The trial's report from its agent logs: the run's result, else its session log."""
    run = logs_dir / "lemma-run.json"
    result = parse_result(run.read_text(errors="replace")) if run.is_file() else None
    if result is not None:
        return report_from_result(result)
    logs = sorted((logs_dir / "lemma-home" / "sessions").glob("*/*.jsonl"), key=lambda path: path.stat().st_mtime)
    if not logs:
        return None
    with logs[-1].open(errors="replace") as lines:
        return report_from_log(lines)
