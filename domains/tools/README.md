# tools

What the model can call, and how calls run. Its contract is [`@lemma/tools`](contract/src/tools.ts), with helpers for tools that bound their output, touch files (`/files`), and test themselves (`/testing`).

| Plugin                                 | Halves     | What it does                                                                        |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| [`tools.registry`](registry/README.md) | host       | Lists and runs the tools: provides `ToolRunner`, checking each call with the guards |
| [`tools.read`](read/README.md)         | host + web | The `read` tool, and how its calls show                                             |
| [`tools.write`](write/README.md)       | host + web | The `write` tool, and how its calls show                                            |
| [`tools.edit`](edit/README.md)         | host + web | The `edit` tool, and how its calls show                                             |
| [`tools.bash`](bash/README.md)         | host + web | The `bash` tool, and how its calls show                                             |
| [`tools.codemode`](codemode/README.md) | host       | The `codemode` tool: JavaScript in a sandbox that calls the other tools             |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `Tools`: a tool; `Guards`: a check every call of a tool (or `*`) passes before it runs. A tool's web half adds how its calls show to the threads domain's `ToolViews` |
| Intercept | `ToolExecuteHook`: around every call (rewrite it, time it, answer it)                                                                                                 |
| Observe   | `ToolExecuted`: each result, with its duration; `ToolOutput`: a running tool's output                                                                                 |
| Call      | `ToolRunner`: list and run the tools                                                                                                                                  |
| Serve     | `ToolRunner`: a plugin providing it replaces `tools.registry`                                                                                                         |
