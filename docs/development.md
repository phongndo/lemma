# Development

The dev shell supplies Node.js 24 and pnpm from [`flake.nix`](../flake.nix),
for CI too. Node runs the TypeScript sources directly through type stripping,
so source must use erasable syntax only (`erasableSyntaxOnly` enforces it).
Processes run with `--conditions=lemma-source`, which selects `@lemma/core`'s
sources over its build; the condition is Lemma's own because dependencies
publish a `source` condition for files they do not ship.

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm check          # build, import boundaries, test hygiene, lint, format check, type-check
nix develop -c pnpm test           # every package's tests
nix develop -c pnpm format         # write the formatting `pnpm check` expects
nix develop -c hk install          # git hooks (hk.pkl): format and lint-fix staged files on commit
```

The hooks call the dev shell's `hk`: commit from inside `nix develop`, or set
`HK=0` to skip them once.

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

Storage code takes its disk as a `FileSystem` (`@lemma/contracts/fs`), its
time from Effect's `Clock`, and its randomness from Effect's `Random` or, where
it must stay unguessable, a seedable source (the session ids' `IdBytes`), so
a simulation controls all three; `scripts/check-boundaries.ts` fails on a seamed file that reaches
around them. [`@lemma/testing`](../packages/testing/README.md) holds the
simulated disk and the contract conformance suites that every implementation
of a contract, a test's fake included, runs.

`scripts/mock-openai.ts` is a scripted provider for end-to-end runs without an
API key; `scripts/e2e.ts` starts it and a host for tests.

The web app's conventions are in [its AGENTS.md](../apps/web/AGENTS.md), and
the core's checks and benchmarks in [its README](../packages/core/README.md#develop).
