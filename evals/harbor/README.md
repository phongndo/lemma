# Harbor evals

Runs Lemma on [Harbor](https://github.com/laude-institute/harbor)'s datasets
(`terminal-bench@2.0`, `swebench-verified@1.0`, the rest of
[its registry](https://hub.harborframework.com/datasets)) as an installed
agent, and summarizes the jobs: pass rate with its 95% interval, cost, cache
hit rate, steps, errors, and timeouts. The simulator and `pnpm torture` test that the
harness holds up ([Development](../../docs/development.md)); this measures
whether the agent solves tasks, which is how a harness change is judged.

## Prerequisites

- Docker, or another of Harbor's environments (`-e podman`, `-e daytona`, …).
- [uv](https://docs.astral.sh/uv/) (`nix shell nixpkgs#uv`): it installs the
  pinned Harbor from `uv.lock`.
- The provider's API key in your environment (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …; `KEY_VARIABLES` in
  [`trial.py`](src/lemma_harbor/trial.py)). Only the model's provider's key goes
  into the task's container; pass any other with `--ae NAME=value`.
- Network in the task's container while it installs (nodejs.org, the npm
  registry) and runs (the provider).

## Run

From the repository root. A smoke run on Terminal-Bench's 10-task sample:

```sh
export ANTHROPIC_API_KEY=…
uv run --project evals/harbor --locked harbor run -d terminal-bench-sample@2.0 \
  -a lemma_harbor.agent:LemmaAgent -m anthropic/claude-sonnet-5-5 \
  -n 4 -o jobs --job-name sample-sonnet
uv run --project evals/harbor --locked lemma-harbor-summary jobs/sample-sonnet
```

The full benchmark, each task five times:

```sh
uv run --project evals/harbor --locked harbor run -d terminal-bench@2.0 \
  -a lemma_harbor.agent:LemmaAgent -m anthropic/claude-sonnet-5-5 \
  -k 5 -n 16 -o jobs --job-name tb2-sonnet
```

`-m` takes a Lemma model ref, `<provider>/<model>` (`lemma models --all` lists
them; OpenRouter's are `openrouter/<vendor>/<model>`). LiteLLM's provider names,
which Harbor's other agents take, are mapped (`gemini/` is `google/`).
Options go in as `--ak name=value`:

| Option         | Default                   | What it does                                                                                    |
| -------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `revision`     | `HEAD`                    | The git revision installed: committed files only (`git archive`), so a result names what ran    |
| `repo`         | the checkout this is in   | Another Lemma repository                                                                        |
| `thinking`     | Lemma's                   | `off` to `max`; Harbor's `--effort` sets it too                                                 |
| `config`       | none                      | A Lemma config (a JSON or JSONC file, or inline JSON), merged key by key over the trial's below |
| `node_version` | the dev shell's (24.21.0) | The Node.js build installed                                                                     |

Harbor records the agent's version as the commit (12 characters), with a
digest of `config` and `thinking` appended when either is given, so setups of
one commit stay apart. `harbor view jobs` shows the trials.

## Comparing two revisions

Run each on the same dataset, model, and `-k`, under the same conditions (at
the same time, with the same `-n` and environment), then give the baseline
first:

```sh
for revision in main my-change; do
  uv run --project evals/harbor --locked harbor run -d terminal-bench@2.0 \
    -a lemma_harbor.agent:LemmaAgent -m anthropic/claude-sonnet-5-5 \
    --ak revision=$revision -k 5 -n 16 -o jobs --job-name tb2-$revision
done
uv run --project evals/harbor --locked lemma-harbor-summary jobs/tb2-main jobs/tb2-my-change
```

The summary prints each version, then the difference in pass rate from the
baseline with its 95% interval: one that includes 0 is no evidence either way.
A config change compares the same way, with `--ak config=…` on one run. A
change can help one model family and hurt another, so measure it on each family
it is meant for.

## What a trial does

- **Setup** (about 20 s): uploads the revision's `git archive` (made once per
  commit, in `~/.cache/lemma-harbor`) and runs [`install.sh`](src/lemma_harbor/install.sh)
  as root: Node.js's official build into `/installed-agent/lemma`, the pnpm the
  checkout's `packageManager` names, and `pnpm install --frozen-lockfile --prod`
  of the `lemma` command and what it needs, which is the host and its bundled
  plugins (no web or desktop app). Node.js stays off the task's `PATH`.
- **Run**: [`run.sh`](src/lemma_harbor/run.sh), as the task's user in its
  directory, starts a host in the trial's home (`lemma serve --detach`), sends
  the instruction with `lemma run new --json --model <ref>`, and stops the host.
  On Harbor's timeout the adapter stops the host, so the turn's commands do not
  run on while the verifier does.
- **Config**: the trial's home starts from a free port for the transport,
  `tools.ask` off (nobody answers in a trial), and the agent's `lemma` set to
  the installed one; `config` goes over it. No approvals plugin runs: the
  container is the sandbox.
- **Reported**: Harbor's `n_input_tokens` (input, cache reads, and cache writes),
  `n_cache_tokens` (cache reads), `n_output_tokens`, and `cost_usd`, from the
  turn's usage in `lemma run --json`, or summed from the session log when the
  run printed none (a timeout). `metadata.lemma` adds how the turn ended, its
  steps and tool calls, Lemma's usage, and the cache hit rate.
- **Kept** in each trial's `agent/`: `lemma-home/` (the session log under
  `sessions/`, in [this format](../../domains/sessions/files/README.md#storage);
  the host's log under `logs/`; `config.jsonc`), `lemma-run.json`, and
  `lemma-serve.log`.
- A turn that ends in `error` fails the trial with Harbor's classification of
  its error (a rate limit, a missing key, an unknown model), which
  `--max-retries` with `--retry-include` can retry; one that ends at
  `max-steps` is graded like a finished one.

## The summary

`lemma-harbor-summary <job>…` (or `python3 evals/harbor/src/lemma_harbor/summary.py`,
which needs only Python) reads every trial's `result.json` and groups them by
agent version and model. A trial passes when its reward is at least 1; one
without a reward counts as failed. The cache hit rate is cache reads over input,
cache reads, and cache writes, over all the group's tokens. Steps are Lemma's
model calls per trial. `--json` prints the same as JSON.

The pass rate's interval (Wilson) treats each trial as an independent draw.
For a fixed task set run several times that is conservative, and it says
nothing about tasks outside the set. The difference between two versions uses
Newcombe's interval, built from the two Wilson intervals.

## Caveats

- **Infrastructure noise.** Provider errors and rate limits, installs over the
  network, and the machine's load all fail trials that say nothing about the
  harness, and a failed trial counts as a fail. Read the errors and timeouts
  lines before a difference, and compare runs made under the same conditions.
- **glibc images only.** Node.js's Linux builds need glibc: a task on Alpine
  fails at setup.
- **No ATIF trajectory.** Harbor's viewer shows each trial's result but not its
  steps; the session log is the trajectory.
- **Harbor is pinned** (`pyproject.toml`): its installed-agent interface changes
  between releases, so a bump goes with the tests below.
- **Cost** is priced from Lemma's model catalog; a custom provider's models
  cost nothing unless its config gives them a `cost`.

## Develop

```sh
uv run --project evals/harbor --locked python -m unittest discover -s evals/harbor/tests
uv run --project evals/harbor --locked python evals/harbor/tests/smoke.py   # Docker; --env podman
```

The unit tests need neither Docker nor a key. The smoke test runs two real
trials against the scripted provider ([`scripts/mock-openai.ts`](../../scripts/mock-openai.ts)),
served from the task's container: one that passes, and one that times out with
a command still running, which must be stopped before the verifier runs.
