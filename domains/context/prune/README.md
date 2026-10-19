# context.prune

Shortens old, long tool results in what the model sees, before a conversation
needs summarizing. Off until a row turns it on:

```jsonc
{ "plugins": { "context.prune": { "enabled": true, "config": { "at": 0.5 } } } }
```

Handles `AgentRequestHook` in its phase `fit`, before
[`context.compaction`](../compaction/README.md). Once the conversation fills
`at` of the model's window (estimated at four characters a token), each tool
result in the model's view longer than `minChars`, and older than the latest
`keepTurns` turns, becomes its start and end with a note of how much was left
out, through a `context-edit` event on the turn's branch (`RequestDraft.append`).
The log keeps every result whole, and the request still rebuilds from it
(`rebuildRequest`). It hands compaction the request with its edits, so
compaction measures the shortened conversation and summarizes only if
shortening was not enough: the cheapest relief first, then the costly one.
A result is shortened once; the model can run the tool again for the rest.
Requires `Llm` (for the model's window).

| Config      | Default | What it does                                                               |
| ----------- | ------- | -------------------------------------------------------------------------- |
| `at`        | `0.5`   | Share of the window the conversation may fill before results are shortened |
| `minChars`  | `4000`  | Characters a tool result's text must exceed to be shortened                |
| `keepChars` | `1000`  | Characters of a shortened result kept, half from its start, half its end   |
| `keepTurns` | `2`     | Turns, the latest first, whose tool results are left whole                 |

It is off by default until it is measured to help: shortening a result the
model still needs costs it a tool call to get it back.
