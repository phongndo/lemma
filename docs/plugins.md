# Writing plugins

Everything Lemma does is a plugin: the agent loop, each tool, the transcript,
the Plugins page. Yours is written against the same contracts and stands
where a bundled one does, so it can add to Lemma or replace any part of it
by id. This guide covers writing one. [Configuration](configuration.md#your-plugins)
covers where plugins go and how they are turned on and off.

## A plugin in a file

A host half is a TypeScript (or JavaScript) module in `~/.lemma/plugins/`.
This one gives the model a tool:

```ts
// ~/.lemma/plugins/greet.ts
import { Schema } from "effect";
import { definePlugin } from "@lemma/core/plain";
import { ToolResult, Tools } from "@lemma/tools";

export default definePlugin({
  id: "greet",
  setup: (_, { add }) => {
    add(Tools, {
      name: "greet",
      description: "Greets someone by name.",
      input: Schema.Struct({ name: Schema.String }),
      execute: async ({ name }) => new ToolResult({ content: [{ type: "text", text: `Hello, ${name}` }] }),
    });
  },
});
```

The host loads it as soon as it is saved, and the model has `greet` from its
next request. `lemma plugins` and Settings › Plugins list it, with a switch.
A host half imports only what the host supplies (`effect`, `@lemma/core`,
`@lemma/contracts`, and the domains' contracts), so it needs no install step:
the host links them into `~/.lemma/node_modules` as it starts, where a plugin
file resolves them and an editor finds their types.

A web half is a module beside it, named `.web.js` (or `.web.ts`, its types
stripped as it is served: erasable syntax only, no JSX). Here, how the chat
shows `greet`'s calls:

```js
// ~/.lemma/plugins/greet.web.js
export default ({ defineWebPlugin, contracts: { Slots, ToolViews } }) =>
  defineWebPlugin({
    id: "greet",
    requires: { slots: Slots },
    setup: ({ slots }) => {
      slots.add(ToolViews, { id: "greet", icon: "chat", summary: (args) => ({ primary: args?.name }) });
    },
  });
```

Both halves define the id `greet`, so they are one plugin: one row in
`config.jsonc` turns both on or off, and the web app runs the web half only
while the host half runs. A plugin with several files is a folder whose
`package.json` names its halves, as [ticker](../examples/ticker/README.md) and
[todo](../examples/todo/README.md) are; its manifest can also bring folders
of skills or profiles (`"resources"`, see
[Configuration](configuration.md#your-plugins)). The bundled plugins are laid out the
same way, one package each under `domains/`.

## The five shapes

A plugin meets the others in five ways, and every domain's contract offers
its extension points in these forms:

| Shape     | What it does                                              | Host half                                                         | Web half                                                   |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Add       | Puts an item where others look: a tool, a command, a view | `add(Tools, tool)`: an item of a registry                         | `slots.add(Views, view)`: an item of a slot                |
| Intercept | Changes or stops an operation as it happens               | `on(ToolExecuteHook, (call, next) => next(call))`: a hook handler | An item of a part: draws instead of the bundled default    |
| Observe   | Hears what happened                                       | `observe(TurnEnded, (turn) => …)`: an event                       | A capability's signals: `threads.branch()`                 |
| Call      | Uses what another plugin provides                         | `requires: { sessions: Sessions }`                                | `requires: { threads: Threads }`; `client.channel.call(…)` |
| Serve     | Provides it: a capability, or a channel to clients        | `provides: { llm: Llm }`; `add(Channels, serveChannel(…))`        | `provides: { … }`                                          |

Where the order of handlers or items means something, the hook, registry, or
slot declares named **phases** in its contract, and a plugin says which one it
belongs in rather than picking a number: compaction runs in
`AgentRequestHook`'s `fit`, after every handler shaping the request in
`shape`, and a slot or part that shows one item has `replace` and `default`,
so an item that names no phase shows instead of the bundled default. An
`order` places an item within its phase ([the core](../packages/core/README.md#plugin-defined-hooks)
says how).

Each hook and registry says how its handlers or items compose, what a
failing one does, and what it checks of them, in the `@composition` line of
its doc comment, where your editor shows it. A hook checks the shape of what
a handler hands on and returns where TypeScript cannot (a plugin written in
JavaScript), so a wrong shape fails as that plugin's fault.

What a plugin adds, intercepts, or observes belongs to it and leaves when it
stops, so it cleans up nothing itself but what it holds outside them (a
timer, a socket: `onCleanup`). Settings › Plugins shows each plugin's wiring
in these five shapes, and each domain's README lists what its contract offers
in each.

## What to plug into

| To                                                                     | Use                                                             | Domain                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Give the model a tool                                                  | Add to `Tools`                                                  | [tools](../domains/tools/README.md)                                        |
| Check, and maybe refuse, a tool call                                   | Add to `Guards` ([approvals](../examples/approvals/README.md))  | [tools](../domains/tools/README.md)                                        |
| Rewrite, time, or answer tool calls                                    | Intercept `ToolExecuteHook`                                     | [tools](../domains/tools/README.md)                                        |
| Tell the model something with every request                            | Add to `PromptSections` ([todo](../examples/todo/README.md))    | [agent](../domains/agent/README.md)                                        |
| Tell the model something once, where it happened (an email, a reading) | Append a `context` event to the session                         | [sessions](../domains/sessions/README.md)                                  |
| Change a request before it is sent                                     | Intercept `AgentRequestHook`                                    | [agent](../domains/agent/README.md)                                        |
| Decide whether a turn takes another step                               | Intercept `AgentContinueHook`                                   | [agent](../domains/agent/README.md)                                        |
| Act when a turn starts or ends                                         | Observe `TurnStarted`, `TurnEnded`                              | [agent](../domains/agent/README.md)                                        |
| Offer a command in the palette and `lemma commands run`                | Add to `Commands`                                               | [commands](../domains/commands/README.md)                                  |
| Offer a `/` command in the prompt, with subcommands and arguments      | Add to `PromptCommands`                                         | [threads](../domains/threads/README.md)                                    |
| Complete a word typed after a trigger (`@`, `$`)                       | Add to `ComposerCompletions`                                    | [threads](../domains/threads/README.md)                                    |
| Give the agent instructions for a kind of task                         | A skill: `~/.lemma/skills/<name>/SKILL.md`                      | [skills](../domains/skills/README.md)                                      |
| Give a thread an agent for something else (writing, research)          | A profile: `~/.lemma/profiles/<name>.md`                        | [agent](../domains/agent/profiles/README.md)                               |
| Send a choice of yours with each prompt, logged with its turn          | Add to `TurnOptionSources`; read `plugins` in a section or hook | [threads](../domains/threads/README.md)                                    |
| Add a model provider                                                   | Add to `Providers`                                              | [llm](../domains/llm/README.md)                                            |
| Time, gate, or wrap model calls and their streams                      | Intercept `LlmRequestHook`                                      | [llm](../domains/llm/README.md)                                            |
| Bring an MCP server and its tools                                      | Add to `McpServers`                                             | [mcp](../domains/mcp/README.md)                                            |
| Search files another way                                               | Add to `FileSearchers`                                          | [workspace](../domains/workspace/README.md)                                |
| Serve your web half, or the CLI, data of your own                      | Serve a channel ([ticker](../examples/ticker/README.md))        | the runtime's `Channels`                                                   |
| Add a command to the `lemma` command, or a check to `lemma doctor`     | Add to `CliCommands`, `CliChecks`                               | [cli](../domains/cli/README.md)                                            |
| Say what stopping the host would cut off                               | Add to `InProgress`                                             | [cli](../domains/cli/README.md)                                            |
| Show a tool's calls                                                    | Add to `ToolViews`                                              | [threads](../domains/threads/README.md)                                    |
| Add a view of a thread                                                 | Add to `Views` ([todo](../examples/todo/README.md))             | [threads](../domains/threads/README.md)                                    |
| Add a page at an address                                               | Add to `Pages`, with a `defineRoute` route                      | the runtime's `Pages`                                                      |
| Add a settings section                                                 | Add to `SettingsSections`                                       | [settings](../domains/settings/README.md)                                  |
| List a kind of thing in Settings › Integrations                        | Add to `IntegrationKinds`                                       | [integrations](../domains/integrations/README.md)                          |
| Add a theme, an accent, or a font                                      | Add to `Themes`, `Accents`, `Fonts`                             | [look](../domains/look/README.md)                                          |
| Add a key or a palette list                                            | Add to `Actions`, `PaletteSources`                              | [actions](../domains/actions/README.md)                                    |
| Draw a shared piece differently everywhere                             | Intercept its part (`IconPart`, `ChatToolPart`, …)              | [look](../domains/look/README.md), [threads](../domains/threads/README.md) |
| Replace a bundled plugin                                               | Give yours its id (below)                                       |                                                                            |

## Two halves, and state

Give both halves the plugin's id. The web half waits for the host half: while
the host half is off or failed, the web half does not run, and the Plugins page
says why. Its row's `config` goes to both halves: declare all of it in the host
half's `config` Schema, which the host checks a row against and the Plugins
page edits, and decode in the web half what it reads.

Keep state where it belongs. A plugin runs once for the whole host, not once
per session or agent: what it does for one session, it keys by the session
(every hook's and event's input names it: `sessionId`), and what it keeps for
one, it drops when the session goes (`SessionRemoved`). State about a session
goes in the session's log:
a tool's result carries it in `details`, and both halves read it back from
the branch (`latestDetails(branch, tool)` in `@lemma/sessions`, which a web
half has in `api.contracts`; `customEvents` reads a plugin's own records), so
it follows the branch when the session is checked out
elsewhere and survives a restart with nothing stored
([todo](../examples/todo/README.md)). Such a tool is `direct`, so a tool that
runs others (`codemode`) does not call it and keep its result as its own, and
it reads the branch its call is on (`ToolContext.leafId`; a prompt section
gets the turn's `branch`), which a checkout during the turn leaves in place. Live state the host half owns reaches its
web half through a channel the host half serves
([ticker](../examples/ticker/README.md)).

## Promises or Effects

`@lemma/core/plain` writes a plugin with promises: its setup receives the
services it requires with their Effect methods as promises, and a context
with `add`, `on`, `observe`, `onCleanup`, and its `config`. The context also
starts timers, listeners, and callbacks as the plugin's own (`after`, `every`,
`listen`, `task`, `action`): they end when it stops, and what fails in them is
its fault, named for it, so a plugin gets Effect's supervision without writing
Effects. `definePlugin`
from `@lemma/core` writes one with Effects:

```ts
export default definePlugin({
  id: "greet",
  setup: function* (_, owner) {
    yield* owner.add(Tools, greetTool);
  },
});
```

Both are the same plugin to the kernel. A tool's `execute`, a guard, a
command's `run`, and a section's `text` may return a value, a promise, or an
Effect. The [kernel's README](../packages/core/README.md) covers the rest:
`config` Schemas, `requires` and `provides`, reloads, and faults.

## Contract versions

Each domain's contract has a version, which its package exports
(`TOOLS_CONTRACT` is `"lemma/tools@1"`) and the plugin serving the domain
implements. Say which versions yours is written against, as literals:

```ts
export default definePlugin({ id: "greet", uses: ["lemma/tools@1"], setup: … });
```

After an incompatible change to a contract (something removed or renamed, or a
meaning changed; never an addition), its version goes up, and a plugin written
for the old one is left out, both versions named, rather than failing at some
later call. Using a contract starts nothing and needs no plugin for it: with
the domain's plugin off, yours still runs. A plugin that serves a domain says
`implements: [TOOLS_CONTRACT]`, so plugins written for another version of it
are told. The runtime's own contracts are versioned by `HostApi` and a web
half's `api` ([configuration](configuration.md#when-something-cannot-run)).
`lemma plugins check` warns of a plugin that names no versions (`uses: []`
says it uses no domain's contract).

## Replacing a bundled plugin

A plugin with a bundled plugin's id takes its place, and one providing what a
bundled plugin provides turns that one off unless a row decides
([Configuration](configuration.md#your-plugins)). To keep what the bundled
one does and change part of it, wrap it rather than copy it. A host half whose
default export is a function receives `{ bundled }`, and a web half receives
`api.bundled` and `extendWebPlugin`
([the web app's README](../apps/web/README.md#writing-a-plugin)).

## Testing

A host half runs in a core of its own (`makeCore` from `@lemma/core`) beside
the plugins it needs, or fakes of them; [todo's tests](../examples/todo/tests/todo.test.ts)
run its tool through `tools.registry` against a fake `Sessions`. A tool alone
runs with `@lemma/tools/testing`. A folder plugin is a workspace package of
its own when it lives in this repository, as the examples are.

A plugin that replaces a provider runs its contract's conformance suite, the
same tests the bundled provider passes: `sessionsConformance` from
`@lemma/sessions/testing` for a `Sessions`, `llmConformance` from
`@lemma/llm/testing` for an `Llm`, `toolsConformance` from
`@lemma/tools/testing` for a `ToolRunner`, and `agentConformance` from
`@lemma/agent/testing` for an `Agent`. A replacement agent can also run the
harness simulator's workload and checks (`World`'s `agent` in `@lemma/sim`).

`lemma plugins check [path]` runs a plugin file or folder as a host would
before you install it. It starts a host in a home of its own with the plugin
linked in, and reports:

- the plugin's state, or its fault;
- what it provides and requires, the hooks it handles, and what it adds;
- what the host warned of it.

It fails on any problem. A plugin of yours that fails to start would keep the
host down, so the check starts the host again with that plugin not required,
to report its fault.

When one misbehaves, [Debugging plugins](debugging.md) says where to look.

## Coming from Pi

Lemma's plugins do what [Pi's extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
do (as of Pi's docs at `c30840c`, 2026-10-05), in Lemma's shapes:

| Pi                                               | Lemma                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi.registerTool()`                              | `add(Tools, tool)`                                                                                                                         |
| `pi.on("tool_call")`, blocking a call            | `add(Guards, { tool, guard })`, or intercept `ToolExecuteHook`                                                                             |
| `pi.on("tool_result")`                           | Intercept `ToolExecuteHook` after `next`; observe `ToolExecuted`                                                                           |
| `pi.on("before_agent_start")`, the system prompt | `add(PromptSections, section)`; intercept `AgentRequestHook`                                                                               |
| `pi.on("context")`                               | Intercept `AgentRequestHook`, appending events (a `compaction`)                                                                            |
| `pi.on("turn_end")`, continuing a turn           | Intercept `AgentContinueHook`; observe `TurnEnded`                                                                                         |
| `pi.on("input")`, rewriting or handling a prompt | Intercept `AgentInputHook`: place, rewrite, handle, or refuse it                                                                           |
| Compaction controls, a `compaction` entry        | Intercept `CompactionHook` (`@lemma/context`): write the summary, move the cut, or skip it                                                 |
| `pi.on("provider_stream_event")`                 | Observe `LlmProviderStreamEvent` (with `llm.pi-ai`'s `providerEvents` on), and `LlmProviderResponse` for the response's status and headers |
| A provider request's headers                     | Intercept `LlmProviderHeadersHook`                                                                                                         |
| `pi.registerVirtualModel()`, routing a request   | Set the draft's `model` in `AgentRequestHook`, where the route is logged with the request                                                  |
| `pi.sendUserMessage()`                           | `Agent.prompt` (the `agent.prompt` channel from a client)                                                                                  |
| `pi.appendEntry()`                               | `Sessions.append` a `custom` event, which the model does not see                                                                           |
| `pi.sendMessage()`, a `custom_message`           | Append a `context` event, which the model reads as a user message, with a `display` for the transcript                                     |
| `pi.registerFlag()`                              | A `config` Schema: a row in `config.jsonc`, a settings form                                                                                |
| `session_start`, `session_shutdown`              | Setup and `onCleanup`: a plugin runs once per host, keying what it does for a session by its id until `SessionRemoved`                     |
| Session replacement, tree navigation             | Intercept `SessionCheckoutHook`; observe `SessionCheckedOut`                                                                               |
| `ctx.ui.notify()`                                | Publish a `Notice` from the host, or call `Notify` in a web half                                                                           |
| `pi.registerCommand()`                           | `add(Commands, command)`: the palette and `lemma commands run`                                                                             |
| `pi.registerShortcut()`                          | A web half's `Actions` item                                                                                                                |
| `pi.registerProvider()`                          | `add(Providers, provider)`                                                                                                                 |
| `pi.registerMcpServer()`                         | `add(McpServers, server)`; a tool's `exposure: "codemode"` is `nested: true`                                                               |
| `pi.registerToolRenderer()`, `renderCall`        | A web half's `ToolViews` item, or the `ChatToolPart` part                                                                                  |
| `ctx.ui` widgets and components                  | A web half's slots and parts: views, pages, layers, settings sections                                                                      |
| Tool-result `details` for branch state           | The same: a result's `details` in the session log                                                                                          |
| `pi.events` between extensions                   | A contract of your own: a capability, a registry, a hook, or an event                                                                      |
| `~/.pi/agent/extensions/`                        | `~/.lemma/plugins/`                                                                                                                        |

Lemma has nothing yet for prompt-cache warming (`cache_warming_decision`), or a
shell command typed by the user (`user_bash`).

Where Pi has one extension object, Lemma has two halves of one plugin,
because its interface is a web app the host serves. Lemma's own parts (the
agent loop, the tools, the transcript) are plugins on the same footing, so
there is no fixed core to extend around: any of them can be turned off or
replaced by id.
