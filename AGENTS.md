# Lemma

Lemma is an agent harness in which every part, including the agent loop
and the web app's views, is a plugin that can be turned off or replaced by id.
The runtime is the API they are written against, provided by the host and the
web app. The bundled plugins are defaults on the same footing as a user's
plugin file, so the runtime and the extension points have to be good enough
for Lemma's own plugins.

## Working in the repository

Use:

- [Architecture](docs/architecture.md) for which package owns what;
- [Writing plugins](docs/plugins.md) for the five shapes plugins meet in, and a
  domain's README (`domains/<domain>/README.md`) for its plugins and what its
  contract offers in each;
- [Kernel design](packages/core/DESIGN.md) and the [core README](packages/core/README.md) when changing `packages/core`;
- a plugin's README for its contract and rationale when changing that plugin;
- [the web app's AGENTS.md](apps/web/AGENTS.md) when changing the web app;
- [Configuration](docs/configuration.md) for config files, turning plugins on and off, project trust, and profiles;
- [Development](docs/development.md) for the dev shell, checks, git hooks, and releases; and
- [Versioning](docs/versioning.md) for what each version means and when it goes up.

## Design

- Build a bundled plugin so a user could have written it: it meets other
  plugins only through contracts, the runtime's (`@lemma/contracts`, and in the
  web app `@lemma/web`) and each domain's (`domains/<domain>/contract`). Its
  package names its halves in its `lemma` manifest, as a user's folder plugin
  does, and a host plugin's web half shares its package and id.
- Offer an extension point in one of the five shapes ([Writing
  plugins](docs/plugins.md#the-five-shapes)): what plugins add is a registry or a
  slot in the domain's contract, not a service method. Name it in the domain's
  README, and say how its handlers or items compose, and what a failing one
  does, in an `@composition` line of its doc comment; `scripts/check-boundaries.ts`
  fails one missing either.
- Keep `@lemma/core` domain-neutral: application contracts, persistence,
  transports, and UI belong to plugins.
- Add to the runtime only what no plugin could provide, since nothing replaces
  it. It holds no domain (the agent, sessions, models, tools): no domain
  contract, logic, or call, as a domain serves its own calls to clients as
  channels. `scripts/check-boundaries.ts` fails when the runtime's code reaches
  a domain contract, however indirectly; [Architecture](docs/architecture.md)
  says where the runtime lives.
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
