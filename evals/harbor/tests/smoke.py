"""Real Harbor trials of Lemma against the scripted provider: no API key, but Docker (or Podman) and the network.

    uv run --project evals/harbor --locked python evals/harbor/tests/smoke.py [--env podman] [--revision HEAD]

It makes two tasks whose container serves `scripts/mock-openai.ts`, runs them
with `harbor run`, and checks what Harbor records. `tally` gets a bash call
that writes `tally.log`: the reward, the tokens reported, and the session log
kept. `slowly` gets a command that runs until its host stops, and a timeout:
the host is stopped before the verifier runs, and usage still comes back,
from the session log.
"""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from lemma_harbor.source import default_repo
from lemma_harbor.summary import main as summary

PORT = 7499
TASK_TOML = """schema_version = "1.4"

[task]
name = "lemma/smoke-{name}"

[agent]
timeout_sec = {timeout}

[verifier]
timeout_sec = 60.0

[environment]
build_timeout_sec = 600.0

[environment.healthcheck]
command = "node -e \\"fetch('http://127.0.0.1:{port}/').then(() => process.exit(0), () => process.exit(1))\\""
interval_sec = 1.0
start_interval_sec = 1.0
start_period_sec = 30.0
retries = 3
"""
DOCKERFILE = """FROM docker.io/library/node:24-bookworm-slim
COPY mock-openai.ts entrypoint.sh /mock/
RUN chmod 755 /mock/entrypoint.sh && mkdir /app
WORKDIR /app
ENTRYPOINT ["/mock/entrypoint.sh"]
"""
ENTRYPOINT = f"""#!/bin/sh
PORT={PORT} PACE_MS=0 node /mock/mock-openai.ts </dev/null >/tmp/mock-openai.log 2>&1 &
exec "$@"
"""
# Each task's check, writing its reward. `kill -[0]` matches the slow command's loop, not this grep.
TESTS = {
    "tally": "grep -q '^call_' /app/tally.log 2>/dev/null",
    "slowly": "! grep -qs 'kill -[0]' /proc/[0-9]*/cmdline",
}
TIMEOUTS = {"tally": 300.0, "slowly": 20.0}
CONFIG = {
    "plugins": {
        "llm.pi-ai": {
            "config": {"providers": [{"id": "mock", "api": "openai-completions", "baseUrl": f"http://127.0.0.1:{PORT}/v1", "models": [{"id": "scripted"}]}]}
        }
    }
}


def make_tasks(root: Path) -> Path:
    tasks = root / "tasks"
    for name, check in TESTS.items():
        task = tasks / name
        (task / "environment").mkdir(parents=True)
        (task / "tests").mkdir()
        (task / "task.toml").write_text(TASK_TOML.format(name=name, timeout=TIMEOUTS[name], port=PORT))
        (task / "instruction.md").write_text(f"{name}\n")
        (task / "environment" / "Dockerfile").write_text(DOCKERFILE)
        (task / "environment" / "entrypoint.sh").write_text(ENTRYPOINT)
        shutil.copy(default_repo() / "scripts" / "mock-openai.ts", task / "environment" / "mock-openai.ts")
        test = task / "tests" / "test.sh"
        test.write_text(f"#!/bin/bash\nif {check}; then echo 1; else echo 0; fi >/logs/verifier/reward.txt\n")
        test.chmod(0o755)
    return tasks


def trial(jobs: Path, name: str) -> tuple[Path, dict]:
    results = [path for path in (jobs / "jobs" / "smoke").glob("*/result.json") if json.loads(path.read_text())["task_name"].endswith(name)]
    assert len(results) == 1, results
    return results[0].parent, json.loads(results[0].read_text())


def smoke(env: str, revision: str, jobs: Path) -> None:
    config = jobs / "mock.json"
    config.write_text(json.dumps(CONFIG))
    command = [
        "harbor", "run", "-p", str(make_tasks(jobs)), "-e", env,
        "-a", "lemma_harbor.agent:LemmaAgent", "-m", "mock/scripted",
        "--ak", f"config={config}", "--ak", f"revision={revision}",
        "-n", "2", "-k", "1", "-o", str(jobs / "jobs"), "--job-name", "smoke", "-y",
    ]  # fmt: skip
    subprocess.run(command, check=True, timeout=1200)

    directory, result = trial(jobs, "tally")
    agent = directory / "agent"
    if result.get("exception_info"):
        detail = "\n".join(path.read_text() for path in (agent / "lemma-run.stderr", agent / "lemma-serve.log") if path.exists())
        raise AssertionError(f"{result['exception_info']['exception_type']}: {result['exception_info']['exception_message']}\n{detail}")
    assert result["verifier_result"]["rewards"]["reward"] == 1, result["verifier_result"]
    context = result["agent_result"]
    # The scripted provider reports 120 input and 24 output tokens a call; the turn makes two.
    assert (context["n_input_tokens"], context["n_output_tokens"], context["n_cache_tokens"]) == (240, 48, 0), context
    lemma = context["metadata"]["lemma"]
    assert (lemma["source"], lemma["reason"], lemma["steps"], lemma["tool_calls"]) == ("run", "done", 2, 1), lemma
    logs = list((agent / "lemma-home" / "sessions").glob("*/*.jsonl"))
    assert len(logs) == 1 and lemma["session"] in logs[0].name, logs
    assert not (agent / "lemma-home" / "token").exists()

    directory, result = trial(jobs, "slowly")
    assert (result.get("exception_info") or {}).get("exception_type") == "AgentTimeoutError", result.get("exception_info")
    assert result["verifier_result"]["rewards"]["reward"] == 1, "the slow command outlived the trial's timeout"
    lemma = result["agent_result"]["metadata"]["lemma"]
    assert (lemma["source"], lemma["reason"], lemma["steps"], lemma["tool_calls"]) == ("log", "unfinished", 1, 1), lemma
    assert result["agent_result"]["n_input_tokens"] == 120, result["agent_result"]

    summary([str(jobs / "jobs" / "smoke")])
    print("Harbor smoke passed: a turn's reward, usage, and session log; a timeout's stopped host and usage from the log")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--env", default="docker", help="Harbor environment: docker (default) or podman")
    parser.add_argument("--revision", default="HEAD", help="the Lemma revision to install")
    parser.add_argument("--keep", type=Path, help="a directory to keep the tasks and job in, rather than a temporary one")
    args = parser.parse_args()
    if args.keep is not None:
        args.keep.mkdir(parents=True, exist_ok=True)
        smoke(args.env, args.revision, args.keep)
    else:
        with tempfile.TemporaryDirectory(prefix="lemma-harbor-smoke-") as directory:
            smoke(args.env, args.revision, Path(directory))
