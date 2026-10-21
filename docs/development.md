# Development

The dev shell supplies Node.js 24 and pnpm from [`flake.nix`](../flake.nix),
for CI too. Node runs the TypeScript sources directly through type stripping,
so source must use erasable syntax only (`erasableSyntaxOnly` enforces it).
Processes run with `--conditions=lemma-source`, which selects `@lemma/core`'s
and `@lemma/router`'s sources over their builds; the condition is Lemma's own because dependencies
publish a `source` condition for files they do not ship.

The type checker is [tsrs](https://github.com/oxc-project/tsrs), a Rust port of
TypeScript 7's compiler: each package's `check` is `tsrs --noEmit`, and the
core's and router's builds are `tsrs -p`. It reports what TypeScript does, a few
times faster and in under half the memory. It follows a TypeScript nightly,
which its version names, so a message can differ slightly from a released
`tsc`'s. The packed-package check (`pnpm package:check`) still type-checks a
consumer with TypeScript itself, as the packages' users do. Its Linux binary
links against glibc: on NixOS it runs through `programs.nix-ld`.

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm check          # build, import boundaries, test hygiene, lint, format check, type-check
nix develop -c pnpm test           # every package's tests
nix develop -c pnpm run ci         # check, then test: CI's check and test jobs in one
nix develop -c pnpm format         # write the formatting `pnpm check` expects
nix develop -c hk install          # git hooks (hk.pkl), below
```

`pnpm run ci` needs `run`: `pnpm ci` is pnpm's own clean install.

The hooks format and lint-fix the staged files on commit, and run `pnpm run ci`
on push; the push check sees the working tree, uncommitted changes included.
They call the dev shell's `hk`: commit and push from inside `nix develop`, or
set `HK=0` to skip them once.

CI (`.github/workflows/check.yml`) runs its checks as parallel jobs, in the dev
shell on Linux: `pnpm check`, the packed-package and browser checks, and
`pnpm test` and the web app's `ui:check`, each in two halves on runners of
their own (`--shard=1/2`, `--shard=2/2`); macOS runs `pnpm test` in thirds,
with plain Node.js and pnpm. The tests' shards are split by how long each file
took (`scripts/test-shards.ts`, from `scripts/test-durations.json`), so they end
together; when they drift apart, `nix develop -c pnpm test:durations` measures
again. The `passed` job succeeds only when every
other job does, so it is the one check a branch rule needs to require. Each commit on main also uploads its
bundle size and benchmark numbers (`metrics-<sha>`). Daily it reruns
every job on main, unchanged, so a failure there is a flake to fix, and runs the
tests with fresh seeds and many more random cases, the mutation checks, and the
performance checks; a failure prints the command that repeats it.
`.github/workflows/bench.yml` compares the core's and the harness's benchmarks with a base
revision (by hand, or on a pull request labelled `performance`); locally,
`node scripts/bench-compare.ts` (see [the core's README](../packages/core/README.md#develop)).
`pnpm harness:bench` measures what the harness does per step, in simulated
time, as a session grows ([`@lemma/sim`](../packages/sim/README.md#the-harness-benchmark)):
its counts are the same on every machine, and hard budgets.

`pnpm check` also holds the runtime (what no plugin can replace: the kernel,
the runtime's contracts, the host and web runtimes, the planner, the client)
to a size budget in lines (`scripts/size.ts`), and prints how many extension
points each domain's contract declares. A change that needs more raises the
budget in the same change. It reports, failing nothing, how many of those
points the examples and the bundled plugins use, and names any neither does
(`scripts/examples-coverage.ts`; `--list` says which examples show each).

Tests wait for a condition, never a fixed time, and make their temporary files
with `mkdtemp`: `scripts/check-boundaries.ts` (in `pnpm check`) counts fixed
waits and fixed temporary names per file, and fails when a count rises above
its recorded ceiling. To show that a test is flaky, or no longer is, run it
many times at once:

```sh
nix develop -c pnpm stress apps/cli/tests/turns.test.ts --runs 30 --jobs 8
```

Keep `pnpm dev` running while you work: it starts the host, the web app's dev
server, and the desktop window on them. The host restarts when its code changes
and the web app hot-reloads. Quitting the window leaves the rest running;
Ctrl+C stops everything.

```sh
nix develop -c pnpm dev            # host (restarting on edits), dev server, and window; prints a browser link too
nix develop -c pnpm dev:desktop    # the window again, while `pnpm dev` runs
nix develop -c pnpm lemma status   # the CLI from the checkout, on the host `pnpm dev` runs
```

What runs from the checkout (`pnpm dev`, `dev:desktop`, `dev:web`, `desktop`,
`start`, `lemma`) uses its own home, `~/.lemma-dev`, unless `LEMMA_HOME` names
another, and `pnpm dev`'s host listens on port 7434: a Lemma you
[installed](installation.md) runs beside it, on `~/.lemma` and port 7433, its
sessions and settings out of a development build's reach. `pnpm dev:web` alone
proxies to the host running on that home, else to 7434, unless
`LEMMA_HOST_URL` names another. Log in to a provider
there once. Every checkout shares `~/.lemma-dev`, which has one host at a
time; another host from the checkout (`pnpm desktop`, `pnpm lemma serve`)
beside an installed one needs a port of its own, which
`~/.lemma-dev/config.jsonc` can give every one:
`{ "plugins": { "transport.server": { "config": { "port": 7434 } } } }`.

Browser checks (the web app's `ui:check`, the core's `browser:check`) run in
the `browser` shell, which supplies pinned Chromium on Linux. On macOS, install
one with `nix develop .#browser -c pnpm exec playwright install chromium`, or
set `LEMMA_CHROMIUM` to an existing executable.

Randomized tests run a fixed number of seeded cases in `pnpm test` and many
more nightly, through `pnpm test:random`; a failure prints the seed and path
that replay it:

| Test                                              | Checks                                                                                                                            | Variables (`_RUNS`, `_SEED`, `_PATH`) |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/core/tests/sequences.test.ts`           | the kernel's load, reload, fail, and restart sequences                                                                            | `LEMMA_SEQUENCE_*`                    |
| `domains/sessions/files/tests/simulation.test.ts` | the session log on a simulated disk that crashes, tears writes, and fails ([README](../domains/sessions/files/README.md#testing)) | `LEMMA_SIM_*`                         |
| `domains/agent/loop/tests/conversation.test.ts`   | random conversations and checkouts: every request is well formed and rebuilds from the log                                        | `LEMMA_CONVERSATION_*`                |
| `packages/sim/tests/world.test.ts`                | the harness in simulated time under a seed's workload and faults, crashes, and restarts ([README](../packages/sim/README.md))     | `LEMMA_HARNESS_*` (`_TICKS`)          |

Code a simulation runs (the sessions store, the agent loop, the tool registry,
compaction, the kernel's step timings) takes its disk as a `FileSystem`
(`@lemma/contracts/fs`), its time and timers from Effect's `Clock`, and its
randomness from Effect's `Random` or, where it must stay unguessable, the
`IdSource` it is made with (`@lemma/contracts`), so these tests control all of
them; `scripts/check-boundaries.ts` fails on a seamed file that reaches around
them (the wall clock, a timer, a random source, `node:fs`). Its invariants are
`assert`ed (`@lemma/core`), on in production; checks too costly for every call
run only under `Verify`, which a simulation turns on. [`@lemma/testing`](../packages/testing/README.md) holds the
simulated disk and the contract conformance suites.

`scripts/mock-openai.ts` is a scripted provider for end-to-end runs without an
API key; `scripts/e2e.ts` starts it and a host for tests.

`pnpm torture` tests the harness from the outside, under process faults
(`scripts/torture.ts`, nightly):

- **Setup.** A real host, the scripted provider over HTTP, and the CLI.
- **Workload.** A seeded workload sends, retries, cancels, and withdraws
  prompts. Meanwhile the host is killed (`kill -9`) and restarted, or stopped
  (`SIGSTOP`) and continued.
- **Liveness.** Then every prompt is asked for again by its request id, and
  must reach the end of a turn.
- **Safety.** The logs, read back through the CLI, must show:
  - parents in order;
  - turns in pairs;
  - each tool call answered once;
  - each request placed at most once;
  - no command unsafe to repeat run twice.

`--seed` (`LEMMA_TORTURE_SEED`) replays the workload. The processes' timing is
not replayed, so a failing run is not reproduced bit for bit, as the
simulator's is. `--seconds` (`LEMMA_TORTURE_SECONDS`, default 30) sets how
long the workload runs.

Whether the agent solves tasks is measured on benchmarks instead:
[`evals/harbor`](../evals/harbor/README.md) runs Lemma on Harbor's datasets
(Terminal-Bench, SWE-bench) and summarizes pass rate, cost, cache hit rate, and
steps, to compare two revisions. It needs Docker, uv, and a provider's key, so
neither `pnpm check` nor CI runs it.

A failing simulation seed, fault-point test, or torture run saves its evidence
before its temporary files go: the seed and the command that replays it, what
the run did last, and the disk or home it left, never credentials. It goes
under `LEMMA_TEST_ARTIFACTS` (the OS temp directory by default), which CI
uploads when a job fails ([`@lemma/testing`](../packages/testing/README.md#failure-evidence)).

`nix develop -c pnpm test:mutations` checks that the tests still catch what
they are for: in a copy of the working tree, it puts back faults the harness
has had, and faults a replacement provider could have, one at a time, and
fails when a fault's focused test no longer fails with an assertion
(`scripts/test-mutations.ts` lists them).

The web app's conventions are in [its AGENTS.md](../apps/web/AGENTS.md), and
the core's checks and benchmarks in [its README](../packages/core/README.md#develop).

## Releases

A release is an archive for each platform with the `lemma` command, the host,
the built web app, their production dependencies, and the Node.js they run on
([installation](installation.md)). `nix develop -c pnpm dist` builds this
platform's into `dist/` at the checkout's version (`scripts/dist.ts`;
`--target all` builds every platform's, `--version` sets the version).
`nix develop -c pnpm dist:check` installs it with `scripts/install.sh`, outside
the checkout and with a `node` on PATH that fails, and runs it: the host and
its plugins, the web app, a TypeScript plugin file, the file search, the CLI
the agent is told of, and a turn on the scripted provider. CI's `dist` job
runs both for Linux on x64.

An archive says what it is in `release.json` (its version, the commit it was
built from, and when), and carries the installer, which `lemma update` runs
([versioning](versioning.md)). The archive keeps the workspace's layout, as
Lemma runs its TypeScript sources: Node.js strips types only outside `node_modules`, and the host finds
the web app and each bundled plugin by its path in the workspace. One machine
builds every platform's, as pnpm installs another platform's prebuilt packages
when told it (`--os`, `--cpu`, `--libc`); nothing compiles at install, so a
dependency that must would fail that platform's check. `scripts/dist-config.ts`
pins the Node.js an archive carries, by version and checksum; update them
together.

Every build is a release, and stable is the one marked latest:

- **Nightly** (`.github/workflows/nightly.yml`), daily and by hand, takes the
  newest commit on `main` whose Check run passed, unless the last release has
  it already. It numbers it the next patch in the line `apps/cli/package.json`
  names (`0.2.0` is the line `0.2`: `v0.2.0`, `v0.2.1`, …), builds every
  platform's archive on one runner, installs and runs each on its platform,
  and publishes them as a GitHub prerelease with the installer, its notes
  listing the pull requests since the release before. Nightlies a month old
  that were not promoted are deleted, with their tags.
- **Promote** (`.github/workflows/promote.yml`), by hand, makes a nightly (the
  newest, or the version you give) the stable release: it marks it latest and
  not a prerelease, and rewrites its notes to cover everything since the last
  stable release. Nothing is rebuilt. It refuses a release older than the
  stable one unless asked to roll back: then that release is the stable one
  again, and `lemma update` and Settings › About take stable users back to it.

To ship a change: merge it, let a nightly carry it (or run the Nightly
workflow), use that nightly yourself, then promote it:
`gh workflow run promote.yml -f version=0.2.7`. To start a new line, set
`apps/cli/package.json`'s version (`0.3.0`) in a pull request; the next
nightly is `v0.3.0`. A run that fails publishes nothing and is safe to run
again. A published release's files are never changed; a fix is the next
nightly. When a stable release turns out bad and the fix is not ready, put the
one before back: `gh workflow run promote.yml -f version=0.2.5 -f rollback=true`.

The Nightly workflow attests each archive's build provenance before
publishing it (`actions/attest`): a signed statement, kept by GitHub, that the
archive was built by that workflow, in this repository, from the commit it
names ([verifying](installation.md#verifying-a-release)).
