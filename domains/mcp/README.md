# mcp

Model Context Protocol servers: the tools they offer the model, and how a person sees and changes them. Its contract is [`@lemma/mcp`](contract/src/mcp.ts).

| Plugin                             | Halves | What it does                                                                                            |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| [`mcp.servers`](servers/README.md) | host   | Connects the servers in `~/.lemma/mcp.json` and those plugins add, and adds their tools: provides `Mcp` |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Add       | `McpServers`: a server a plugin brings, in the shape of an `mcp.json` entry with its name                       |
| Intercept | Nothing: a server's tool calls go through the tools domain's `ToolExecuteHook` and `Guards`, as every tool's do |
| Observe   | `McpChanged`: every server's state, whenever one connects, fails, changes, or the file does                     |
| Call      | `Mcp`: the servers' state, reconnect one, configure one; clients call `McpChannels`                             |
| Serve     | `Mcp`, with `serveMcp` for its channels: a plugin providing it replaces `mcp.servers`                           |
