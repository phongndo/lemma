# Development

The dev shell supplies Node.js 24 and pnpm from [`flake.nix`](../flake.nix),
for CI too. Node runs the TypeScript sources directly through type stripping,
so source must use erasable syntax only (`erasableSyntaxOnly` enforces it).
Processes run with `--conditions=lemma-source`, which selects `@lemma/core`'s
sources over its build; the condition is Lemma's own because dependencies
publish a `source` condition for files they do not ship.

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm check          # build, import boundaries, lint, format check, type-check
nix develop -c pnpm test           # every package's tests
nix develop -c pnpm format         # write the formatting `pnpm check` expects
nix develop -c hk install          # git hooks (hk.pkl): format and lint-fix staged files on commit
```

The hooks call the dev shell's `hk`: commit from inside `nix develop`, or set
`HK=0` to skip them once.

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

`scripts/mock-openai.ts` is a scripted provider for end-to-end runs
without an API key.

The web app's conventions are in [its AGENTS.md](../apps/web/AGENTS.md), and
the core's checks and benchmarks in [its README](../packages/core/README.md#develop).
