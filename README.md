# Lemma

A coding-agent harness in which every part, including the agent loop, is a
plugin that can be replaced by id. Plugins are composed by the core in
[`packages/core`](#core).

| Path                                                       | Responsibility                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`packages/contracts`](packages/contracts/src/index.ts)    | Capability contracts: session log, agent, LLM, tools, credentials, interaction, host RPC      |
| [`plugins/*`](plugins)                                     | The default plugins, one README each                                                          |
| [`packages/router`](packages/router/README.md)             | A router whose routes come and go at runtime, typed by each route; the web app's addresses    |
| [`packages/router-solid`](packages/router-solid/README.md) | The router's SolidJS bindings: a signal per route, and an outlet whose pages fail alone       |
| [`packages/host`](packages/host/src/main.ts)               | Reads config, loads plugins, hot-reloads on config change                                     |
| [`apps/web`](apps/web/README.md)                           | The web client: plugins on the same kernel, each replaceable; served by `transport`           |
| [`apps/cli`](apps/cli/README.md)                           | The `lemma` command: everything the web app does, from a shell, for people and agents         |
| [`apps/desktop`](apps/desktop/README.md)                   | The web app in a desktop window (Electron), attaching to a running host or starting one       |
| [`examples/*`](examples)                                   | Plugin files written as a user writes them, such as [approvals](examples/approvals/README.md) |

```sh
nix develop -c pnpm start          # build the web app, start the host, print its URL
nix develop -c pnpm desktop        # the same app in a desktop window
nix develop -c pnpm lemma status   # query the running host; `pnpm lemma --help` lists commands
```

To run the host on one machine and use it from another, see [remote access](docs/remote.md).

With no config, every bundled plugin runs. `~/.lemma/config.jsonc` and
`<project>/.lemma/config.jsonc` patch that by plugin id (`enabled: false`, or a
replacement `config`). The Plugins settings page and `lemma plugins enable|disable`
write those rows for you and apply them; turning a plugin off also unloads the
plugins that require what it provides (they say so, and return with it), turning
on a plugin that provides what another provides turns that one off (a capability
has one provider), and the `host` and `transport` plugins, plus everything they
need, cannot be turned off.
Plugin files in `~/.lemma/plugins/` or
`<project>/.lemma/plugins/` load automatically and shadow a bundled plugin with
the same id. The web app is composed the same way from its own plugins, which
`"ui"` rows and files in `~/.lemma/ui/` change: see [its README](apps/web/README.md).
A plugin's config Schema is also its settings form, on the Plugins page and
through `lemma plugins config`. Project files and plugins can run code and redirect credentials, so
they load only for projects listed (or under a directory listed) in
`"trustedProjects"` in `~/.lemma/config.jsonc`; otherwise the host warns and
ignores them. Providers come from pi-ai (`plugins/llm-pi-ai`): log in from the
key icon in the web app, or set a provider's API key environment variable.

The session log is the source of truth: every model request can be rebuilt from
it (`rebuildRequest` in the contracts) and records which plugins contributed
each part. `scripts/fixtures/mock-openai.ts` is a scripted provider for
end-to-end runs without an API key.

## Core

The core is a domain-neutral TypeScript plugin framework. It provides typed capabilities, plugin-defined hooks, events, and registries, scoped resources,
failure supervision, and reloads. Applications define their own contracts and choose
their own plugins. The core has no required server, transport, persistence,
user interface, or domain model.

The library lives in [`packages/core`](packages/core/README.md). Its only runtime
dependency is Effect 3.22.2. Effect supplies lifecycle and cancellation machinery;
capability contracts can expose ordinary values, functions, and promises.

| Path                                                        | Responsibility                                      |
| ----------------------------------------------------------- | --------------------------------------------------- |
| [`packages/core/src`](packages/core/src/index.ts)           | Public interface and runtime implementation         |
| [`packages/core/tests`](packages/core/tests)                | Contract, lifecycle, failure, and property tests    |
| [`packages/core/examples`](packages/core/examples/hello.ts) | A capability extended through a plugin-defined hook |
| [`packages/core/bench`](packages/core/bench/core.ts)        | Framework microbenchmarks                           |
| [`docs/kernel.md`](docs/kernel.md)                          | Design rationale and limits                         |

## Develop

Use the Nix shell on Linux or Apple silicon macOS. Both development shells supply
Node.js 24 and pnpm from [`flake.nix`](flake.nix), including CI. Node runs TypeScript
sources directly through type stripping, so source must use erasable syntax only
(enforced by `erasableSyntaxOnly`).

```sh
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm check          # build JavaScript/declarations and type-check
nix develop -c pnpm test           # core tests (Vitest), including lifecycle regressions
nix develop -c pnpm lint           # oxlint; warnings fail (also run by pnpm check)
nix develop -c pnpm format         # oxfmt writes the formatting pnpm check expects
nix develop -c hk install          # git hooks (hk.pkl): format and lint-fix staged files on commit
nix develop -c pnpm example        # compose plugins and invoke a hook
nix develop -c pnpm package:check  # install the packed library into a temporary consumer
nix develop -c pnpm core:bench     # warm framework microbenchmarks
nix develop -c pnpm core:stress    # requires a build; lifecycle churn and memory
nix develop .#browser -c pnpm browser:check # packed consumers plus Chromium
```

The pre-commit hook calls `hk`, which the dev shell provides: commit from inside
`nix develop` (outside it the hook cannot run and the commit stops), or set `HK=0`
to skip the hook once.

`package:check` checks the emitted declarations and runs the consumer on Node.js.
It tests provider replacement, dependent reconstruction, and cleanup through the
package export, outside this workspace. Its temporary install may need network
access for dependencies.

The `browser` shell supplies pinned Chromium on Linux. On macOS, install the
development browser with `nix develop .#browser -c pnpm exec playwright install chromium`
first, or set `LEMMA_CHROMIUM` to an existing executable. Linux Chromium is the
locally verified browser environment; other browsers/platforms need their own runs.

`perf:check` builds and runs the microbenchmarks and sustained workload. Performance results
are advisory by default; set `LEMMA_PERF_ENFORCE=1` on a comparable idle machine to
enforce the [documented budgets](packages/core/bench/budgets.ts), and
`LEMMA_BENCH_OUTPUT_DIR` to an artifact directory. The [CI workflow](.github/workflows/check.yml)
runs correctness checks on changes and extended checks weekly or on demand.

## Use the core in another application

The package is currently private and can be packed locally:

```sh
nix develop -c pnpm build
nix develop -c pnpm --filter @lemma/core pack --pack-destination /tmp
```

Install the resulting tarball in the consuming application and import `@lemma/core`.
The package contains ESM JavaScript, TypeScript declarations, and the example;
Effect remains an external dependency. See the [library README](packages/core/README.md)
for composition and plugin authoring.

Plugins execute as trusted code in the application's process. Scope ownership and
cooperative cancellation organize their lifetimes; they do not provide process
isolation. Performance claims require measured application workloads; the included
benchmarks measure framework overhead only.
