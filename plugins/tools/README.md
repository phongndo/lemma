# @lemma/plugin-tools

Provides `Tools` (`@lemma/contracts`): the registry the agent lists and executes
tools through. Tool plugins require `Tools` and register during activation.

```ts
const greet = definePlugin({
  id: "greet",
  requires: [Tools],
  exclusive: true, // the registry rejects duplicate names; see below
  layer: Layer.scopedDiscard(
    Effect.flatMap(Tools, (tools) =>
      tools.register({
        name: "greet",
        description: "Greets someone by name.",
        input: Schema.Struct({ name: Schema.String }),
        execute: async ({ name }, { signal }) => new ToolResult({ content: [{ type: "text", text: `Hello, ${name}` }] }),
      }),
    ),
  ),
});
```

## Config

| Key              | Default  | Meaning                                                                                                                                                                          |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxResultChars` | `100000` | Text characters one result may carry to the model. Longer text is cut with a marker; images are kept. A safety net for third-party tools; builtin tools truncate far below this. |

## Behavior

- **Inspector.** `tools.registered` (in `Inspectors`) lists every tool with the plugin
  that registered it, and the guards: the devtools' Inspectors panel and
  `lemma inspectors` show it.
- `register` records the caller's `PluginContext` id as the tool's `source` and
  unregisters when the caller's scope closes. A duplicate name fails with
  `InvalidInput`, so contributors should be `exclusive` to reload cleanly.
- A tool that only reads declares `replay: "safe"`: a call a host restart cut
  off then runs again when the turn resumes, where any other is reported to the
  model as interrupted (see the [agent](../agent/README.md#durability)). One
  that may run alongside others declares `parallel: "safe"`: the agent runs a
  run of consecutive such calls of one response at once. `list` carries both.
- `list` is sorted by name, so re-registration after a reload does not reorder
  (and re-log) the tool list. Parameters come from `JSONSchema.make(tool.input)`
  with `$schema`, ids, and Effect's generated titles removed and every `$ref`
  inlined; the root is always an object with `properties`.
- `execute(invocation, signal)`:
  1. unknown tool: fails with `ToolError` `NotFound` (message lists available tools);
  2. input decoded with the tool's schema: failure is an error result with the formatted parse error;
  3. `ToolExecuteHook`, whose terminal re-decodes input a handler rewrote, runs the
     guards, then the tool;
  4. throws, rejections, Effect failures, defects, malformed results, handler
     failures, and denials all become `isError` results; but the core shutting
     down under the call (`CoreClosed` from the hook) is a defect, as the call
     failed for that alone and its caller may run it again later;
  5. an aborted `signal` fails with `Cancelled`, interrupting the tool. Promise
     tools see the abort on `ToolContext.signal`.
- `guard(name, guard)`: `name` is the tool the guard applies to, or `*` for every
  tool. Guards run in registration order; the first `deny` wins and its reason is
  the result text (`details.deniedBy` names the guarding plugin).
- `ToolExecuted` is published for every result, with its duration.
