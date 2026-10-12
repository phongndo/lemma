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
`@lemma/contracts`, and the domains' contracts), so it needs no install step.

A web half is a JavaScript module beside it, named `.web.js`. Here, how the
chat shows `greet`'s calls:

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
[todo](../examples/todo/README.md) are. The bundled plugins are laid out the
same way, one package each under `domains/`.

## The five shapes

A plugin meets the others in five ways, and every domain's contract offers
its extension points in these forms:

| Shape     | What it does                                              | Host half                                                         | Web half                                                    |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Add       | Puts an item where others look: a tool, a command, a view | `add(Tools, tool)`: an item of a registry                         | `slots.add(Views, view)`: an item of a slot                 |
| Intercept | Changes or stops an operation as it happens               | `on(ToolExecuteHook, (call, next) => next(call))`: a hook handler | An item of a part below `DEFAULT_PART_ORDER`: draws instead |
| Observe   | Hears what happened                                       | `observe(TurnEnded, (turn) => …)`: an event                       | A capability's signals: `threads.branch()`                  |
| Call      | Uses what another plugin provides                         | `requires: { sessions: Sessions }`                                | `requires: { threads: Threads }`; `client.channel.call(…)`  |
| Serve     | Provides it: a capability, or a channel to clients        | `provides: { llm: Llm }`; `add(Channels, serveChannel(…))`        | `provides: { … }`                                           |

What a plugin adds, intercepts, or observes belongs to it and leaves when it
stops, so it cleans up nothing itself but what it holds outside them (a
timer, a socket: `onCleanup`). Settings › Plugins shows each plugin's wiring
in these five shapes, and each domain's README lists what its contract offers
in each.

## What to plug into

| To                                                | Use                                                            | Domain                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Give the model a tool                             | Add to `Tools`                                                 | [tools](../domains/tools/README.md)                                        |
| Check, and maybe refuse, a tool call              | Add to `Guards` ([approvals](../examples/approvals/README.md)) | [tools](../domains/tools/README.md)                                        |
| Rewrite, time, or answer tool calls               | Intercept `ToolExecuteHook`                                    | [tools](../domains/tools/README.md)                                        |
| Tell the model something with every request       | Add to `PromptSections` ([todo](../examples/todo/README.md))   | [agent](../domains/agent/README.md)                                        |
| Change a request before it is sent                | Intercept `AgentRequestHook`                                   | [agent](../domains/agent/README.md)                                        |
| Decide whether a turn takes another step          | Intercept `AgentContinueHook`                                  | [agent](../domains/agent/README.md)                                        |
| Act when a turn starts or ends                    | Observe `TurnStarted`, `TurnEnded`                             | [agent](../domains/agent/README.md)                                        |
| Offer a command in the palette and `lemma do`     | Add to `Commands`                                              | [commands](../domains/commands/README.md)                                  |
| Add a model provider                              | Add to `Providers`                                             | [llm](../domains/llm/README.md)                                            |
| Change model requests or their streams            | Intercept `LlmRequestHook`                                     | [llm](../domains/llm/README.md)                                            |
| Search files another way                          | Add to `FileSearchers`                                         | [workspace](../domains/workspace/README.md)                                |
| Serve your web half, or the CLI, data of your own | Serve a channel ([ticker](../examples/ticker/README.md))       | the runtime's `Channels`                                                   |
| Show a tool's calls                               | Add to `ToolViews`                                             | [threads](../domains/threads/README.md)                                    |
| Add a view of a thread                            | Add to `Views` ([todo](../examples/todo/README.md))            | [threads](../domains/threads/README.md)                                    |
| Add a page at an address                          | Add to `Pages`, with a `defineRoute` route                     | the runtime's `Pages`                                                      |
| Add a settings section                            | Add to `SettingsSections`                                      | [settings](../domains/settings/README.md)                                  |
| Add a theme, an accent, or a font                 | Add to `Themes`, `Accents`, `Fonts`                            | [look](../domains/look/README.md)                                          |
| Add a key or a palette list                       | Add to `Actions`, `PaletteSources`                             | [actions](../domains/actions/README.md)                                    |
| Draw a shared piece differently everywhere        | Intercept its part (`IconPart`, `ChatToolPart`, …)             | [look](../domains/look/README.md), [threads](../domains/threads/README.md) |
| Replace a bundled plugin                          | Give yours its id (below)                                      |                                                                            |

## Two halves, and state

Give both halves the plugin's id. The web half waits for the host half: while
the host half is off or failed, the web half does not run, and the Plugins page
says why. Its row's `config` goes to both halves.

Keep state where it belongs. State about a session goes in the session's log:
a tool's result carries it in `details`, and both halves read it back from
the branch, so it follows the branch when the session is checked out
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
with `add`, `on`, `observe`, `onCleanup`, and its `config`. `definePlugin`
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

## Coming from Pi

Lemma's plugins do what [Pi's extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
do (as of Pi's docs at `c30840c`, 2026-10-05), in Lemma's shapes:

| Pi                                               | Lemma                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `pi.registerTool()`                              | `add(Tools, tool)`                                                    |
| `pi.on("tool_call")`, blocking a call            | `add(Guards, { tool, guard })`, or intercept `ToolExecuteHook`        |
| `pi.on("tool_result")`                           | Intercept `ToolExecuteHook` after `next`; observe `ToolExecuted`      |
| `pi.on("before_agent_start")`, the system prompt | `add(PromptSections, section)`; intercept `AgentRequestHook`          |
| `pi.on("context")`                               | Intercept `AgentRequestHook`, appending events (a `compaction`)       |
| `pi.on("turn_end")`, continuing a turn           | Intercept `AgentContinueHook`; observe `TurnEnded`                    |
| `pi.registerCommand()`                           | `add(Commands, command)`: the palette and `lemma do`                  |
| `pi.registerShortcut()`                          | A web half's `Actions` item                                           |
| `pi.registerProvider()`                          | `add(Providers, provider)`                                            |
| `pi.registerToolRenderer()`, `renderCall`        | A web half's `ToolViews` item, or the `ChatToolPart` part             |
| `ctx.ui` widgets and components                  | A web half's slots and parts: views, pages, layers, settings sections |
| Tool-result `details` for branch state           | The same: a result's `details` in the session log                     |
| `pi.events` between extensions                   | A contract of your own: a capability, a registry, a hook, or an event |
| `~/.pi/agent/extensions/`                        | `~/.lemma/plugins/`                                                   |

Where Pi has one extension object, Lemma has two halves of one plugin,
because its interface is a web app the host serves. Lemma's own parts (the
agent loop, the tools, the transcript) are plugins on the same footing, so
there is no fixed core to extend around: any of them can be turned off or
replaced by id.
