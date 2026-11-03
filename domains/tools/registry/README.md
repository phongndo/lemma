# tools.registry

Provides `ToolRunner` (`@lemma/tools`), which the agent lists and runs tools
through. Plugins add tools to `Tools` and guards to `Guards`. A tool plugin
needs no capability, only the registry:

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

| Key              | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxResultChars` | `50000` | Text characters one result carries to the model: the one budget every tool's output is bounded by (`ToolContext.maxResultChars`). Longer text keeps its start and its end around a marker, the whole in a temp file the model can read (`boundOutput`); images are kept. A tool bounding its own output keeps under it (`outputBudget`), so the registry cuts only a tool that does not. |

## Behavior

- **Inspector.** `tools.registered` (in `Inspectors`) lists every tool with its
  plugin, and the guards. The devtools' Inspectors panel and `lemma inspectors`
  show it.
- **Flags.** `list` carries each tool's `replay`, `parallel`, `direct`, `nests`,
  and `nested`, which [the contract](../contract/src/tools.ts) explains. `Tools`
  refuses a tool that is both `direct` and `nested`.
- **Order.** `list` is sorted by name, so a tool added again after a reload
  does not reorder (and re-log) the tool list.
- **Parameters** are the closed draft-07 JSON Schema of the input's encoded
  side, under an object root. An optional field is offered as its value type
  and a number as `number`, since the decoder accepts neither Effect's `null`
  nor `"NaN"`. A check with a `toJsonSchema` annotation on the encoded side
  shows the model other parameters, as the `edit` tool does.
- **No JSON Schema form.** A tool whose input or output has none is left out of
  `list`, and warned of once, rather than failing the whole list.
- **Running.** `execute(invocation, signal)` fails `ToolError` `NotFound` for a
  tool unknown, not offered (`ToolInvocation.offered`), or not declared to the
  model (`declared`). Otherwise it decodes the input, then runs
  `ToolExecuteHook`, the guards, and the tool.
- **Errors are results.** Invalid input, throws, failures, defects, malformed
  results, and denials become `isError` results. The core shutting down under
  the call (`CoreClosed`) is a defect instead, so its caller may run the call
  again later. An aborted `signal` fails `Cancelled`.
- **Guards** (`{ tool, guard }`) apply to the tool named, or with `*` to every
  tool. They run in the registry's order, and the first `deny` wins. Its reason
  is the result's text, and `details.deniedBy` names the guarding plugin.
- `ToolExecuted` is published for every result, with its duration.

## Testing

The registry runs the `ToolRunner` contract's suite,
[`toolsConformance`](../../../packages/testing/README.md#conformance-suites),
beside its own tests.
