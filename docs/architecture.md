# Architecture

Every part of Lemma is a plugin on one kernel, [`@lemma/core`](../packages/core/README.md).

- The host's plugins provide the agent, models, tools, and sessions.
- The web app's plugins draw them.
- A plugin is one id, with a host half, a web half, or both.
- Plugins meet in five shapes ([writing plugins](plugins.md)).
- So any plugin can be turned off or replaced by id
  ([configuration](configuration.md)).

The plugins are written against the runtime. The host and the web app provide
the runtime themselves (the kernel's
[`provide`](../packages/core/README.md#capabilities-the-application-provides)).
So no row turns it off, and no plugin replaces it.

- The host's runtime is in `packages/host`.
- The web app's runtime is in its boot (`apps/web/src/runtime`).
- Both plan what runs with `packages/composition`.
- The runtime's contracts are `@lemma/contracts`. The web app's are
  `@lemma/web`.

The runtime holds no domain ([AGENTS.md](../AGENTS.md#design)).

- Each domain is a folder under `domains/`.
- A domain's contract is a package of its own: `domains/<domain>/contract`,
  named `@lemma/<domain>`.
- A domain's README names its plugins, and says what the contract offers.
- A domain reaches clients through channels of its own (below).

| Path                                                          | Responsibility                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/core`](../packages/core/README.md)                 | The plugin kernel: capabilities, hooks, events, registries, reloads ([design](../packages/core/DESIGN.md))                                                                                                   |
| [`packages/contracts`](../packages/contracts/src/index.ts)    | The runtime's contracts: what the host and the web app give every plugin, and what clients reach the host by                                                                                                 |
| [`domains/*/contract`](../domains)                            | Each domain's contract, `@lemma/<domain>`: its capabilities, hooks, events, channels, and projections                                                                                                        |
| [`packages/web`](../packages/web/src/index.ts)                | The web app's plugin API: its runtime's contracts, `defineWebPlugin`, slots and parts, and helpers any web plugin may use                                                                                    |
| [`packages/client`](../packages/client/src/index.ts)          | The host RPC client the web app and CLI share. It is the only reader of the host's streams. It reconnects, types channel calls, reopens streams by one policy (`follow`), and sends prompts once (`/prompt`) |
| [`packages/host`](../packages/host/README.md)                 | The host and its runtime: paths, plugin control, questions, and its trace. It reads config, and loads and hot-reloads plugins                                                                                |
| [`packages/composition`](../packages/composition/README.md)   | The runtime's planner: what runs from the known plugins and config rows, for the host and web app alike                                                                                                      |
| [`domains/*/*`](../domains)                                   | The bundled plugins, host and web halves. Each is a package in its domain (`domains/<domain>/<name>`, id `<domain>.<name>`), and names its halves in its `lemma` manifest                                    |
| [`apps/web`](../apps/web/README.md)                           | The web client: plugins on the same kernel, written against its boot's runtime. `transport.server` serves it                                                                                                 |
| [`apps/cli`](../apps/cli/README.md)                           | The `lemma` command. It starts and keeps hosts, sets them up, and looks inside them. Each domain's commands come from its host plugins ([cli](../domains/cli/README.md))                                     |
| [`apps/desktop`](../apps/desktop/README.md)                   | The web app in a desktop window, attaching to a running host or starting one                                                                                                                                 |
| [`packages/router`](../packages/router/README.md)             | A router whose routes come and go at runtime, typed by each route; the web app's addresses                                                                                                                   |
| [`packages/router-solid`](../packages/router-solid/README.md) | The router's SolidJS bindings                                                                                                                                                                                |
| [`packages/testing`](../packages/testing/README.md)           | Test support: a simulated disk for crash tests, and contract conformance suites                                                                                                                              |
| [`packages/sim`](../packages/sim/README.md)                   | A deterministic simulator of the harness: the real plugins in simulated time, on a simulated disk, replayable from a seed                                                                                    |
| [`examples/*`](../examples)                                   | Plugins written as a user writes them: files, and folders with both halves                                                                                                                                   |

Clients reach the host through the [transport](../domains/transport/server/README.md)
plugin's RPC, over a WebSocket or HTTP. A host plugin serves its own calls and
streams there as [channels](../packages/contracts/src/channels.ts). That needs
no change to the contracts or the transport.

The [session log](../domains/sessions/files/README.md) is the source of truth.
Every model request can be rebuilt from it (`rebuildRequest` in the sessions
domain's contract, [`@lemma/sessions`](../domains/sessions/contract/src/derive.ts)).
The rebuilt request also says:

- which plugins contributed each part;
- which handlers changed it;
- who shaped each tool result.

The `credit` vocabulary in `@lemma/contracts` names these.

Each request extends the one before it, so a provider's cache of its prefix
serves it. So what changed in the system prompt is appended as a
`prompt-update` event, not rewritten
([append-only requests](../domains/agent/loop/README.md#append-only-requests)).

The host's trace, kept in memory, shows the same work as it ran. It keeps a
span for each piece of its plugins' work as the work ends. You can sort the
spans out by session, turn, step, and plugin
([devtools.trace](../domains/devtools/trace/README.md)).
