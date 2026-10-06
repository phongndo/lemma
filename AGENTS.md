# Lemma

Lemma is a coding-agent harness in which every part, including the agent loop
and the web app, is a plugin that can be turned off or replaced by id. The
bundled plugins are defaults on the same footing as a user's plugin file, so
the extension points have to be good enough for Lemma's own plugins.

## Working in the repository

Use:

- [Architecture](docs/architecture.md) for which package owns what;
- [Kernel design](docs/kernel.md) and the [core README](packages/core/README.md) when changing `packages/core`;
- a plugin's README for its contract and rationale when changing that plugin;
- [the web app's AGENTS.md](apps/web/AGENTS.md) when changing the web app;
- [Configuration](docs/configuration.md) for config files, turning plugins on and off, and project trust; and
- [Development](docs/development.md) for the dev shell, checks, and git hooks.

## Design

- Build a bundled plugin so a user could have written it: it meets other
  plugins only through the contracts in `packages/contracts` (in the web app,
  `ui/contracts.ts`).
- Keep `@lemma/core` domain-neutral: application contracts, persistence,
  transports, and UI belong to plugins.
- Keep the session log the source of truth: every model request stays
  rebuildable from it (`rebuildRequest`), with each part attributed to the
  plugin that contributed it.
- Document a contract where it is declared. A README holds what a user or
  plugin author needs: use, configuration, constraints, and reasons the code
  does not show. It links to other docs rather than repeating them.

## Verification

`nix develop -c pnpm check` and `nix develop -c pnpm test` run locally without
credentials; run them, and the focused package tests while working, without
asking. A web app change also runs `ui:check` ([its AGENTS.md](apps/web/AGENTS.md)).
Commit and push from inside `nix develop` so the hooks run. Report the commands run and
any failing or blocked checks.
