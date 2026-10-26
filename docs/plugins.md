# Writing plugins

Everything Lemma does is a plugin: the agent loop, each tool, the transcript,
the Plugins page. Your plugin is written against the same contracts, and it
stands where a bundled one does. So it can add to Lemma, or replace any part of
it by id.

- This guide covers writing a plugin.
- [Building on Lemma](building.md) walks through one from start to finish.
- [Configuration](configuration.md#your-plugins) covers where plugins go, and
  how they are turned on and off.

## A plugin in a file

A host half is a TypeScript or JavaScript module in `~/.lemma/plugins/`. This
one gives the model a tool:

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

The host loads it as soon as it is saved. The model has `greet` from its next
request. `lemma plugins` and Settings › Plugins list it, with a switch.

A host half imports only what the host supplies: `effect`, `@lemma/core`,
`@lemma/contracts`, and the domains' contracts. So it needs no install step.
As the host starts, it links them into `~/.lemma/node_modules`. There a plugin
file resolves them, and an editor finds their types.

A web half is a module beside it, named `.web.js`. It can also be `.web.ts`.
Its types are then stripped as it is served, so it may use erasable syntax
only, and no JSX. This one says how the chat shows `greet`'s calls:

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

Both halves define the id `greet`, so they are one plugin.

- One row in `config.jsonc` turns both on or off.
- The web app runs the web half only while the host half runs.

A plugin with several files is a folder. Its `package.json` names its halves,
as in [ticker](../examples/ticker/README.md) and
[todo](../examples/todo/README.md). Its manifest can also bring folders of
skills or modes (`"resources"`, see
[Configuration](configuration.md#your-plugins)). The bundled plugins are laid
out the same way, one package each under `domains/`.

## The five shapes

A plugin meets the others in five ways. Every domain's contract offers its
extension points in these forms:

| Shape     | What it does                                              | Host half                                                         | Web half                                                   |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Add       | Puts an item where others look: a tool, a command, a view | `add(Tools, tool)`: an item of a registry                         | `slots.add(Views, view)`: an item of a slot                |
| Intercept | Changes or stops an operation as it happens               | `on(ToolExecuteHook, (call, next) => next(call))`: a hook handler | An item of a part: draws instead of the bundled default    |
| Observe   | Hears what happened                                       | `observe(TurnEnded, (turn) => …)`: an event                       | A capability's signals: `threads.branch()`                 |
| Call      | Uses what another plugin provides                         | `requires: { sessions: Sessions }`                                | `requires: { threads: Threads }`; `client.channel.call(…)` |
| Serve     | Provides it: a capability, or a channel to clients        | `provides: { llm: Llm }`; `add(Channels, serveChannel(…))`        | `provides: { … }`                                          |

Sometimes the order of handlers or items means something. Then the hook,
registry, or slot declares named **phases** in its contract. A plugin says
which phase it belongs in, rather than picking a number.

- Compaction runs in `AgentRequestHook`'s `fit` phase. That is after every
  handler that shapes the request in `shape`.
- A slot or part that shows one item has the phases `replace` and `default`.
  So an item that names no phase shows instead of the bundled default.
- An `order` places an item within its phase
  ([the core](../packages/core/README.md#plugin-defined-hooks) says how).

Each hook and registry has an `@composition` line in its doc comment, where
your editor shows it. The line says:

- how its handlers or items compose;
- what a failing one does;
- what it checks of them.

A hook checks the shape of what a handler hands on and returns, where
TypeScript cannot, as in a plugin written in JavaScript. So a wrong shape fails
as that plugin's fault.

What a plugin adds, intercepts, or observes belongs to it, and leaves when it
stops. So a plugin cleans up nothing itself, except what it holds outside them,
such as a timer or a socket (`onCleanup`).

Settings › Plugins shows each plugin's wiring in these five shapes. Each
domain's README lists what its contract offers in each.

## What to plug into

| To                                                                     | Use                                                                                                                   | Domain                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Give the model a tool                                                  | Add to `Tools`                                                                                                        | [tools](../domains/tools/README.md)                                        |
| Check, and maybe refuse, a tool call                                   | Add to `Guards` ([approvals](../examples/approvals/README.md))                                                        | [tools](../domains/tools/README.md)                                        |
| Rewrite, time, or answer tool calls                                    | Intercept `ToolExecuteHook` ([redact](../examples/redact/README.md))                                                  | [tools](../domains/tools/README.md)                                        |
| Tell the model something with every request                            | Add to `PromptSections` ([todo](../examples/todo/README.md))                                                          | [agent](../domains/agent/README.md)                                        |
| Tell the model something once, where it happened (an email, a reading) | Append a `context` event to the session ([inbox](../examples/inbox/README.md))                                        | [sessions](../domains/sessions/README.md)                                  |
| Change a request before it is sent                                     | Intercept `AgentRequestHook`                                                                                          | [agent](../domains/agent/README.md)                                        |
| Decide whether a turn takes another step                               | Intercept `AgentContinueHook` ([budget](../examples/budget/README.md))                                                | [agent](../domains/agent/README.md)                                        |
| Act when a turn starts or ends                                         | Observe `TurnStarted`, `TurnEnded` ([budget](../examples/budget/README.md))                                           | [agent](../domains/agent/README.md)                                        |
| Offer a command in the palette and `lemma commands run`                | Add to `Commands`                                                                                                     | [commands](../domains/commands/README.md)                                  |
| Offer a `/` command in the prompt, with subcommands and arguments      | Add to `PromptCommands`                                                                                               | [threads](../domains/threads/README.md)                                    |
| Complete a word typed after a trigger (`@`, `$`)                       | Add to `ComposerCompletions`                                                                                          | [threads](../domains/threads/README.md)                                    |
| Give the agent instructions for a kind of task                         | A skill: `~/.lemma/skills/<name>/SKILL.md`                                                                            | [skills](../domains/skills/README.md)                                      |
| Give a thread an agent for something else (writing, research)          | A mode: `~/.lemma/modes/<name>.md` ([notes](../examples/notes/README.md), [writing](../examples/writing/README.md))   | [agent](../domains/agent/modes/README.md)                                  |
| Send a choice of yours with each prompt, logged with its turn          | Add to `TurnOptionSources`; read `plugins` in a section or hook                                                       | [threads](../domains/threads/README.md)                                    |
| Ask a model something small in passing (a title, a label)              | Call `SmallModel`: the model and reasoning set for it, else a small model of the thread's provider                    | [llm](../domains/llm/README.md)                                            |
| Add a model provider                                                   | Add to `Providers`                                                                                                    | [llm](../domains/llm/README.md)                                            |
| Time, gate, or wrap model calls and their streams                      | Intercept `LlmRequestHook` ([budget](../examples/budget/README.md))                                                   | [llm](../domains/llm/README.md)                                            |
| Bring an MCP server and its tools                                      | Add to `McpServers`                                                                                                   | [mcp](../domains/mcp/README.md)                                            |
| Search files another way                                               | Add to `FileSearchers`                                                                                                | [workspace](../domains/workspace/README.md)                                |
| Drive a browser another way (a remote one, the desktop app's pane)     | Provide `Browser`                                                                                                     | [browser](../domains/browser/README.md)                                    |
| Ask the person something: a yes or no, text, a choice, a form          | Call `Interaction` (`confirm`, `ask`, `select`, `form`)                                                               | the runtime's `Interaction`                                                |
| Serve your web half, or the CLI, data of your own                      | Serve a channel ([ticker](../examples/ticker/README.md))                                                              | the runtime's `Channels`                                                   |
| Add a command to the `lemma` command, or a check to `lemma doctor`     | Add to `CliCommands`, `CliChecks`                                                                                     | [cli](../domains/cli/README.md)                                            |
| Say what stopping the host would cut off                               | Add to `InProgress`                                                                                                   | [cli](../domains/cli/README.md)                                            |
| Show a tool's calls                                                    | Add to `ToolViews`                                                                                                    | [threads](../domains/threads/README.md)                                    |
| Show what your plugin tells the model (a `context` event)              | Add to `ContextViews`                                                                                                 | [threads](../domains/threads/README.md)                                    |
| Add a kind of agent a thread can hand tasks to (a reviewer)            | A mode that says `use: agent`, offered to `delegate`'s agents ([tools.delegate](../domains/tools/delegate/README.md)) | [agent](../domains/agent/modes/README.md)                                  |
| Add a view of a thread                                                 | Add to `Views` ([todo](../examples/todo/README.md))                                                                   | [threads](../domains/threads/README.md)                                    |
| Add a page at an address                                               | Add to `Pages`, with a `defineRoute` route                                                                            | the runtime's `Pages`                                                      |
| Add a settings section                                                 | Add to `SettingsSections`                                                                                             | [settings](../domains/settings/README.md)                                  |
| Add a theme, an accent, or a font                                      | Add to `Themes`, `Accents`, `Fonts`                                                                                   | [look](../domains/look/README.md)                                          |
| Add a key or a palette list                                            | Add to `Actions`, `PaletteSources`                                                                                    | [actions](../domains/actions/README.md)                                    |
| Draw a shared piece differently everywhere                             | Intercept its part (`IconPart`, `ChatToolPart`, …)                                                                    | [look](../domains/look/README.md), [threads](../domains/threads/README.md) |
| Replace a bundled plugin                                               | Give yours its id (below)                                                                                             |                                                                            |

## Two halves, and state

Give both halves the plugin's id.

- The web half waits for the host half. While the host half is off or failed,
  the web half does not run, and the Plugins page says why.
- The row's `config` goes to both halves. Declare all of it in the host half's
  `config` Schema. The host checks a row against that Schema, and the Plugins
  page edits it. In the web half, decode what it reads.

Keep state where it belongs. A plugin runs once for the whole host, not once
per session or agent.

- What it does for one session, it keys by the session. Every hook's and
  event's input names the session: `sessionId`.
- What it keeps for one session, it drops when the session goes
  (`SessionRemoved`).

State about a session goes in the session's log
([todo](../examples/todo/README.md)).

- A tool's result carries the state in `details`.
- Both halves read it back from the branch, with `latestDetails(branch, tool)`
  in `@lemma/sessions`. A web half has that in `api.contracts`. `customEvents`
  reads a plugin's own records.
- So the state follows the branch when the session is checked out elsewhere. It
  survives a restart with nothing stored.
- Such a tool is `direct`. So a tool that runs others (`codemode`) does not call
  it and keep its result as its own.
- It reads the branch its call is on (`ToolContext.leafId`). A prompt section
  gets the turn's `branch`. A checkout during the turn leaves that branch in
  place.

Live state the host half owns reaches its web half through a channel the host
half serves ([ticker](../examples/ticker/README.md)).

## Promises or Effects

`@lemma/core/plain` writes a plugin with promises.

- Its setup receives the services it requires, with their Effect methods as
  promises.
- It also receives a context with `add`, `on`, `observe`, `onCleanup`, and its
  `config`.
- The context starts timers, listeners, and callbacks as the plugin's own:
  `after`, `every`, `listen`, `task`, and `action`. They end when the plugin
  stops. What fails in them is the plugin's fault, named for it.

So a plugin gets Effect's supervision without writing Effects.

`definePlugin` from `@lemma/core` writes a plugin with Effects:

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

Each domain's contract has a version. Its package exports the version:
`TOOLS_CONTRACT` is `"lemma/tools@2"`. The plugin serving the domain implements
it. Say which versions your plugin is written against, as literals:

```ts
export default definePlugin({ id: "greet", uses: ["lemma/tools@2"], setup: … });
```

- A contract's version goes up after an incompatible change: something removed
  or renamed, or a meaning changed. An addition never raises it.
- A plugin written for the old version is then left out, and both versions are
  named. It does not fail at some later call.
- Using a contract starts nothing, and needs no plugin for it. With the
  domain's plugin off, yours still runs.
- A plugin that serves a domain says `implements: [TOOLS_CONTRACT]`. So plugins
  written for another version of it are told.
- The runtime's own contracts are versioned by `HostApi` and by a web half's
  `api` ([configuration](configuration.md#when-something-cannot-run)).
- `lemma plugins check` warns of a plugin that names no versions. `uses: []`
  says a plugin uses no domain's contract.

## Replacing a bundled plugin

A plugin with a bundled plugin's id takes its place. A plugin that provides
what a bundled plugin provides turns that one off, unless a row decides
([Configuration](configuration.md#your-plugins)).

To keep what the bundled one does and change part of it, wrap it rather than
copy it.

- A host half whose default export is a function receives `{ bundled }`.
- A web half receives `api.bundled` and `extendWebPlugin`
  ([the web app's README](../apps/web/README.md#writing-a-plugin)).

## Testing

A host half runs in a core of its own (`makeCore` from `@lemma/core`). Beside
it run the plugins it needs, or fakes of them.
[todo's tests](../examples/todo/tests/todo.test.ts) run its tool through
`tools.registry` against a fake `Sessions`. A tool alone runs with
`@lemma/tools/testing`.

To see what a plugin does to a real turn, compose it with these
([inbox's tests](../examples/inbox/tests/inbox.test.ts) do):

- the agent, the session log, and the tools;
- a scripted model, `scriptedLlm` from `@lemma/llm/testing`. It plays the
  answers and tool calls you give it, and records each request.

A folder plugin in this repository is a workspace package of its own, as the
examples are. `node scripts/examples-coverage.ts --list` says which extension
points the examples show.

A plugin that replaces a provider runs its contract's conformance suite. These
are the same tests the bundled provider passes:

| Replaces     | Suite                                                |
| ------------ | ---------------------------------------------------- |
| `Sessions`   | `sessionsConformance` from `@lemma/sessions/testing` |
| `Llm`        | `llmConformance` from `@lemma/llm/testing`           |
| `ToolRunner` | `toolsConformance` from `@lemma/tools/testing`       |
| `Agent`      | `agentConformance` from `@lemma/agent/testing`       |

A replacement agent can also run the harness simulator's workload and checks
(`World`'s `agent` in `@lemma/sim`).

`lemma plugins check [path]` runs a plugin file or folder as a host would,
before you install it. It starts a host in a home of its own, with the plugin
linked in. It reports:

- the plugin's state, or its fault;
- what it provides and requires, the hooks it handles, and what it adds;
- what the host warned of it.

It fails on any problem. A plugin of yours that fails to start would keep the
host down. So the check starts the host again with that plugin not required,
to report its fault.

When one misbehaves, [Debugging plugins](debugging.md) says where to look.

## Coming from Pi

Lemma's plugins do what [Pi's extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
do, in Lemma's shapes. This table follows Pi's docs at `c30840c`, 2026-10-05:

| Pi                                               | Lemma                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.registerTool()`                              | `add(Tools, tool)`                                                                                                                     |
| `pi.on("tool_call")`, blocking a call            | `add(Guards, { tool, guard })`, or intercept `ToolExecuteHook`                                                                         |
| `pi.on("tool_result")`                           | Intercept `ToolExecuteHook` after `next`; observe `ToolExecuted`                                                                       |
| `pi.on("before_agent_start")`, the system prompt | `add(PromptSections, section)`; intercept `AgentRequestHook`                                                                           |
| `pi.on("context")`                               | Intercept `AgentRequestHook`, appending events (a `compaction`)                                                                        |
| `pi.on("turn_end")`, continuing a turn           | Intercept `AgentContinueHook`; observe `TurnEnded`                                                                                     |
| `pi.on("input")`, rewriting or handling a prompt | Intercept `AgentInputHook`: place, rewrite, handle, or refuse it                                                                       |
| Compaction controls, a `compaction` entry        | Intercept `AgentRequestHook` in its `fit` phase, appending a `compaction` of your own ([fresh-loop](../examples/fresh-loop/README.md)) |
| A provider request's headers                     | A provider's `headers`: `add(Providers, provider)`, or a provider in `llm.pi-ai`'s config                                              |
| `pi.registerVirtualModel()`, routing a request   | Set the draft's `model` in `AgentRequestHook`, where the route is logged with the request                                              |
| `pi.sendUserMessage()`                           | `Agent.prompt` (the `agent.prompt` channel from a client)                                                                              |
| `pi.appendEntry()`                               | `Sessions.append` a `custom` event, which the model does not see                                                                       |
| `pi.sendMessage()`, a `custom_message`           | Append a `context` event, which the model reads as a user message, with a `display` for the transcript                                 |
| `pi.registerFlag()`                              | A `config` Schema: a row in `config.jsonc`, a settings form                                                                            |
| `session_start`, `session_shutdown`              | Setup and `onCleanup`: a plugin runs once per host, keying what it does for a session by its id until `SessionRemoved`                 |
| Session replacement, tree navigation             | `Sessions.checkout` (the `sessions.checkout` channel from a client); observe `SessionChanged`, whose `leaf` it moves                   |
| `ctx.ui.notify()`                                | Publish a `Notice` from the host, or call `Notify` in a web half                                                                       |
| `pi.registerCommand()`                           | `add(Commands, command)`: the palette and `lemma commands run`                                                                         |
| `pi.registerShortcut()`                          | A web half's `Actions` item                                                                                                            |
| `pi.registerProvider()`                          | `add(Providers, provider)`                                                                                                             |
| `pi.registerMcpServer()`                         | `add(McpServers, server)`; a tool's `exposure: "codemode"` is `nested: true`                                                           |
| A tool's `outputSchema` and `structuredContent`  | `Tool.output` and `ToolResult.structured`: what a codemode script's call resolves to                                                   |
| A tool's `namespace`                             | `Tool.namespace`, naming what `add(ToolNamespaces, namespace)` adds: scripts search by it and read its instructions                    |
| `ctx.modelRegistry.generateImages()`             | `Llm.generateImages` (codemode scripts call it as `models.generateImages`)                                                             |
| `pi.registerToolRenderer()`, `renderCall`        | A web half's `ToolViews` item, or the `ChatToolPart` part                                                                              |
| `ctx.ui` widgets and components                  | A web half's slots and parts: views, pages, layers, settings sections                                                                  |
| Tool-result `details` for branch state           | The same: a result's `details` in the session log                                                                                      |
| `pi.events` between extensions                   | A contract of your own: a capability, a registry, a hook, or an event                                                                  |
| `~/.pi/agent/extensions/`                        | `~/.lemma/plugins/`                                                                                                                    |

Lemma has nothing yet for two of Pi's events:

- prompt-cache warming (`cache_warming_decision`);
- a shell command typed by the user (`user_bash`).

Where Pi has one extension object, Lemma has two halves of one plugin. That is
because Lemma's interface is a web app the host serves. Lemma's own parts, such
as the agent loop, the tools, and the transcript, are plugins on the same
footing. So there is no fixed core to extend around: any of them can be turned
off or replaced by id.
