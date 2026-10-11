# Architecture

Every part of Lemma is a plugin on one kernel, [`@lemma/core`](../packages/core/README.md):
the host's plugins provide the agent, models, tools, and sessions, and the web
app's plugins draw them. A plugin requires and provides capabilities, so any
plugin can be turned off or replaced by id ([configuration](configuration.md)).

The plugins are written against the runtime, which the host and the web app
provide themselves (the kernel's
[`provide`](../packages/core/README.md#capabilities-the-application-provides)),
so no row turns it off and no plugin replaces it. The host's is in
`packages/host`, the web app's in its boot (`apps/web/src/runtime`), and both
plan what runs with `packages/composition`. Its contracts are
`@lemma/contracts` and the web app's `ui/runtime.ts`. It holds no domain
([AGENTS.md](../AGENTS.md#design)): each domain is a folder under `domains/`,
its contract a package of its own (`domains/<domain>/contract`, named
`@lemma/<domain>`), and it reaches clients through channels of its own, below.

| Path                                                          | Responsibility                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/core`](../packages/core/README.md)                 | The plugin kernel: capabilities, hooks, events, registries, reloads ([design](../packages/core/DESIGN.md))                                                                                       |
| [`packages/contracts`](../packages/contracts/src/index.ts)    | The runtime's contracts: what the host and the web app give every plugin, and what clients reach the host by                                                                                     |
| [`domains/*/contract`](../domains)                            | Each domain's contract, `@lemma/<domain>`: its capabilities, hooks, events, channels, and projections                                                                                            |
| [`packages/client`](../packages/client/src/index.ts)          | The host RPC client the web app and CLI share, the only reader of the host's streams: reconnecting, typed channel calls, one reopen policy for streams (`follow`), prompts sent once (`/prompt`) |
| [`packages/host`](../packages/host/README.md)                 | The host and its runtime (paths, plugin control, questions): reads config, loads and hot-reloads plugins                                                                                         |
| [`packages/composition`](../packages/composition/README.md)   | The runtime's planner: what runs from the known plugins and config rows, for the host and web app alike                                                                                          |
| [`domains/*/*`](../domains)                                   | The host's bundled plugins, each in its domain (`domains/<domain>/<name>`, id `<domain>.<name>`), one README each                                                                                |
| [`apps/web`](../apps/web/README.md)                           | The web client: plugins on the same kernel, written against its boot's runtime, served by `transport`                                                                                            |
| [`apps/cli`](../apps/cli/README.md)                           | The `lemma` command: everything the web app does, from a shell                                                                                                                                   |
| [`apps/desktop`](../apps/desktop/README.md)                   | The web app in a desktop window, attaching to a running host or starting one                                                                                                                     |
| [`packages/router`](../packages/router/README.md)             | A router whose routes come and go at runtime, typed by each route; the web app's addresses                                                                                                       |
| [`packages/router-solid`](../packages/router-solid/README.md) | The router's SolidJS bindings                                                                                                                                                                    |
| [`packages/testing`](../packages/testing/README.md)           | Test support: a simulated disk for crash tests, and contract conformance suites                                                                                                                  |
| [`examples/*`](../examples)                                   | Plugin files written as a user writes them                                                                                                                                                       |

Clients reach the host through the [transport](../domains/transport/server/README.md)
plugin's RPC, over a WebSocket or HTTP. A host plugin serves its own calls and
streams there as [channels](../packages/contracts/src/channels.ts), with no
change to the contracts or the transport.

The [session log](../domains/sessions/files/README.md) is the source of truth: every
model request can be rebuilt from it (`rebuildRequest` in the contracts), along
with which plugins contributed each part.
