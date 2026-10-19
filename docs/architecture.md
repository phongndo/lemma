# Architecture

Every part of Lemma is a plugin on one kernel, [`@lemma/core`](../packages/core/README.md):
the host's plugins provide the agent, models, tools, and sessions, and the web
app's plugins draw them. A plugin is one id with a host half, a web half, or
both, and meets the others in five shapes ([writing plugins](plugins.md)), so
any plugin can be turned off or replaced by id ([configuration](configuration.md)).

The plugins are written against the runtime, which the host and the web app
provide themselves (the kernel's
[`provide`](../packages/core/README.md#capabilities-the-application-provides)),
so no row turns it off and no plugin replaces it. The host's is in
`packages/host`, the web app's in its boot (`apps/web/src/runtime`), and both
plan what runs with `packages/composition`. Its contracts are
`@lemma/contracts` and the web app's `@lemma/web`. It holds no domain
([AGENTS.md](../AGENTS.md#design)): each domain is a folder under `domains/`,
its contract a package of its own (`domains/<domain>/contract`, named
`@lemma/<domain>`), its README naming its plugins and what the contract
offers, and it reaches clients through channels of its own, below.

| Path                                                          | Responsibility                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/core`](../packages/core/README.md)                 | The plugin kernel: capabilities, hooks, events, registries, reloads ([design](../packages/core/DESIGN.md))                                                                                       |
| [`packages/contracts`](../packages/contracts/src/index.ts)    | The runtime's contracts: what the host and the web app give every plugin, and what clients reach the host by                                                                                     |
| [`domains/*/contract`](../domains)                            | Each domain's contract, `@lemma/<domain>`: its capabilities, hooks, events, channels, and projections                                                                                            |
| [`packages/web`](../packages/web/src/index.ts)                | The web app's plugin API: its runtime's contracts, `defineWebPlugin`, slots and parts, and helpers any web plugin may use                                                                        |
| [`packages/client`](../packages/client/src/index.ts)          | The host RPC client the web app and CLI share, the only reader of the host's streams: reconnecting, typed channel calls, one reopen policy for streams (`follow`), prompts sent once (`/prompt`) |
| [`packages/host`](../packages/host/README.md)                 | The host and its runtime (paths, plugin control, questions, its trace): reads config, loads and hot-reloads plugins                                                                              |
| [`packages/composition`](../packages/composition/README.md)   | The runtime's planner: what runs from the known plugins and config rows, for the host and web app alike                                                                                          |
| [`domains/*/*`](../domains)                                   | The bundled plugins, host and web halves, each a package in its domain (`domains/<domain>/<name>`, id `<domain>.<name>`) naming its halves in its `lemma` manifest                               |
| [`apps/web`](../apps/web/README.md)                           | The web client: plugins on the same kernel, written against its boot's runtime, served by `transport.server`                                                                                     |
| [`apps/cli`](../apps/cli/README.md)                           | The `lemma` command: starts and keeps hosts, sets them up, and looks inside them; every domain's commands come from its host plugins ([cli](../domains/cli/README.md))                           |
| [`apps/desktop`](../apps/desktop/README.md)                   | The web app in a desktop window, attaching to a running host or starting one                                                                                                                     |
| [`packages/router`](../packages/router/README.md)             | A router whose routes come and go at runtime, typed by each route; the web app's addresses                                                                                                       |
| [`packages/router-solid`](../packages/router-solid/README.md) | The router's SolidJS bindings                                                                                                                                                                    |
| [`packages/testing`](../packages/testing/README.md)           | Test support: a simulated disk for crash tests, and contract conformance suites                                                                                                                  |
| [`packages/sim`](../packages/sim/README.md)                   | A deterministic simulator of the harness: the real plugins in simulated time, on a simulated disk, replayable from a seed                                                                        |
| [`examples/*`](../examples)                                   | Plugins written as a user writes them: files, and folders with both halves                                                                                                                       |

Clients reach the host through the [transport](../domains/transport/server/README.md)
plugin's RPC, over a WebSocket or HTTP. A host plugin serves its own calls and
streams there as [channels](../packages/contracts/src/channels.ts), with no
change to the contracts or the transport.

The [session log](../domains/sessions/files/README.md) is the source of truth: every
model request can be rebuilt from it (`rebuildRequest` in the sessions domain's
contract, [`@lemma/sessions`](../domains/sessions/contract/src/derive.ts)), along
with which plugins contributed each part, which handlers changed it, and who
shaped each tool result (the `credit` vocabulary in `@lemma/contracts`). Each
request extends the one before it, so a provider's cache of its prefix serves it:
what changed in the system prompt is appended as a `prompt-update` event rather than
rewritten ([append-only requests](../domains/agent/loop/README.md#append-only-requests)). The
host's trace, in memory, shows the same work as it ran: every span its plugins'
work ends, by session, turn, step, and plugin
([devtools.trace](../domains/devtools/trace/README.md)).
