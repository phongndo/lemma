# Development

The dev shell supplies Node.js 24 and pnpm from [`flake.nix`](../flake.nix),
for CI too. Node runs the TypeScript sources directly through type stripping,
so source must use erasable syntax only (`erasableSyntaxOnly` enforces it).
Processes run with `--conditions=lemma-source`, which selects `@lemma/core`'s
and `@lemma/router`'s sources over their builds; the condition is Lemma's own because dependencies
publish a `source` condition for files they do not ship.

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
shell on Linux: `pnpm check`, `pnpm test` in two halves (`--shard=1/2`,
`--shard=2/2`), the packed-package and browser checks, and the web app's
`ui:check`; macOS runs `pnpm test`, in halves too, with plain Node.js and pnpm.
The `passed` job succeeds only when every other job does, so it is the
one check a branch rule needs to require. Each commit on main also uploads its
bundle size and benchmark numbers (`metrics-<sha>`). Daily it reruns
every job on main, unchanged, so a failure there is a flake to fix, and runs the
tests with fresh seeds and many more random cases, and the performance checks;
a failure prints the command that repeats it.
`.github/workflows/bench.yml` compares the core's benchmarks with a base
revision (by hand, or on a pull request labelled `performance`); locally,
`node scripts/bench-compare.ts` (see [the core's README](../packages/core/README.md#develop)).

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
```

Browser checks (the web app's `ui:check`, the core's `browser:check`) run in
the `browser` shell, which supplies pinned Chromium on Linux. On macOS, install
one with `nix develop .#browser -c pnpm exec playwright install chromium`, or
set `LEMMA_CHROMIUM` to an existing executable.

Randomized tests run a fixed number of seeded cases in `pnpm test` and many
more nightly, through `pnpm test:random`; a failure prints the seed and path
that replay it:

| Test                                        | Checks                                                                                                                      | Variables (`_RUNS`, `_SEED`, `_PATH`) |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/core/tests/sequences.test.ts`     | the kernel's load, reload, fail, and restart sequences                                                                      | `LEMMA_SEQUENCE_*`                    |
| `plugins/sessions/tests/simulation.test.ts` | the session log on a simulated disk that crashes, tears writes, and fails ([README](../plugins/sessions/README.md#testing)) | `LEMMA_SIM_*`                         |
| `plugins/agent/tests/conversation.test.ts`  | random conversations and checkouts: every request is well formed and rebuilds from the log                                  | `LEMMA_CONVERSATION_*`                |

Storage code takes its disk as a `FileSystem` (`@lemma/contracts/fs`), its
time from Effect's `Clock`, and its randomness from Effect's `Random` or, where
it must stay unguessable, a seedable source (the session ids' `IdBytes`), so
these tests control all three; `scripts/check-boundaries.ts` fails on a seamed file that reaches
around them. [`@lemma/testing`](../packages/testing/README.md) holds the
simulated disk and the contract conformance suites that every implementation
of a contract, a test's fake included, runs.

`scripts/mock-openai.ts` is a scripted provider for end-to-end runs without an
API key; `scripts/e2e.ts` starts it and a host for tests.

The web app's conventions are in [its AGENTS.md](../apps/web/AGENTS.md), and
the core's checks and benchmarks in [its README](../packages/core/README.md#develop).
