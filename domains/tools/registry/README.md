# tools.registry

Provides `ToolRunner` (`@lemma/tools`), which the agent lists and runs tools
through: the tools plugins add to `Tools`, checked by the guards they add to
`Guards`. A tool plugin needs no capability, only the registry:

```ts
const greet = definePlugin({
  id: "greet",
  setup: function* (_, owner) {
    yield* owner.add(Tools, {
      name: "greet",
      description: "Greets someone by name.",
      input: Schema.Struct({ name: Schema.String }),
      execute: async ({ name }, { signal }) => new ToolResult({ content: [{ type: "text", text: `Hello, ${name}` }] }),
    });
  },
});
```

## Config

| Key              | Default  | Meaning                                                                                                                                                                          |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxResultChars` | `100000` | Text characters one result may carry to the model. Longer text is cut with a marker; images are kept. A safety net for third-party tools; builtin tools truncate far below this. |

## Behavior

- **Inspector.** `tools.registered` (in `Inspectors`) lists every tool with the plugin
  that added it, and the guards: the devtools' Inspectors panel and
  `lemma inspectors` show it.
- A tool's `source` is the plugin that added it, and it leaves with that
  plugin, or sooner when the removal `add` returns runs. `Tools` refuses what is
  not a tool (no name, description, input Schema, or `execute`), and a name
  another plugin holds fails `Conflict`, naming that plugin, either way failing
  the plugin adding it; a plugin's replacement takes its names over when a
  reload swaps them, so contributors need not be `exclusive`.
- A tool that only reads declares `replay: "safe"`: a call a host restart cut
  off then runs again when the turn resumes, where any other is reported to the
  model as interrupted (see the [agent](../../agent/loop/README.md#durability)). One
  that may run alongside others declares `parallel: "safe"`: the agent runs a
  run of consecutive such calls of one response at once. `list` carries both,
  and `direct` (only the model calls it), `nests` (it runs others, as
  `codemode` does), and `nested` (only a tool that runs others calls it, so a
  request offering one does not declare it to the model: `declaredTools`);
  `Tools` refuses a tool both `direct` and `nested`.
- `list` is sorted by name, so a tool added again after a reload does not reorder
  (and re-log) the tool list. Parameters are the draft-07 JSON Schema of the
  input's encoded side (Effect's `SchemaRepresentation` compiler), closed
  (`additionalProperties: false`), with `$schema`, ids, and titles removed and
  every `$ref` inlined; the root is always an object with `properties`. Effect
  describes JSON, so it would offer `null` for an optional field and the strings
  `"NaN"`/`"Infinity"` for a number; the decoder accepts neither, so an optional
  field is offered as its value type and a number as `number`. To show the
  model other parameters than the schema implies (an input that repairs
  malformed shapes before decoding), put a check with a `toJsonSchema`
  annotation on its encoded side, as the builtin `edit` tool does. Each tool's
  is made the first time it is listed or run, and kept while the tool is there.
  A tool whose input or output has no JSON Schema form is left out of `list`,
  and warned of once, rather than fail the list of every tool; it is no tool to
  run either.
- `execute(invocation, signal)`:
  1. unknown tool, or one the request did not offer (`ToolInvocation.offered`),
     or, for the model's own call, did not declare to it (`declared`): fails
     with `ToolError` `NotFound`, the message listing the tools the call may name;
  2. input decoded with the tool's schema: failure is an error result with the formatted parse error;
  3. `ToolExecuteHook`, whose terminal re-decodes input a handler rewrote, runs the
     guards, then the tool;
  4. throws, rejections, Effect failures, defects, malformed results, handler
     failures, and denials all become `isError` results; but the core shutting
     down under the call (`CoreClosed` from the hook) is a defect, as the call
     failed for that alone and its caller may run it again later;
  5. an aborted `signal` fails with `Cancelled`, interrupting the tool. Promise
     tools see the abort on `ToolContext.signal`.
- A guard in `Guards` (`{ tool, guard }`) applies to the tool it names, or with
  `*` to every tool. Guards run in the registry's order; the first `deny` wins
  and its reason is the result text (`details.deniedBy` names the guarding
  plugin).
- `ToolExecuted` is published for every result, with its duration.

## Testing

The registry runs the `ToolRunner` contract's suite, [`toolsConformance`](../../../packages/testing/README.md#conformance-suites), beside its own tests.
