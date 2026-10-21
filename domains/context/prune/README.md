# context.prune

Shortens old, long tool results in what the model sees, in place of a summary
[`context.compaction`](../compaction/README.md) was about to write. Off until a
row turns it on:

```jsonc
{ "plugins": { "context.prune": { "enabled": true } } }
```

It handles `CompactionHook`. When compaction is about to summarize because the
conversation passed its threshold, it shortens the qualifying tool results
instead and skips the summary, if that leaves the request at least `room` of
the window below the threshold (estimated at four characters a token). A
shortened result keeps its start and end with a note of how much was left
out (its images stay), through a `context-edit` event on the turn's branch
(`CompactionRequest.append`), and an info `Notice` says how many were
shortened. When shortening would not leave that room, compaction summarizes
as before; an overflow, or `/compact`, is always compaction's.

A result qualifies once the model has answered it, when it is older than the
latest `keepRecent` tokens of the conversation, longer than `minChars`, not
shortened already, and from a tool that is not `irreplaceable` (`@lemma/tools`:
the person's answers to `ask_user`, another agent's work from
`lemma_delegate`) or in `exclude`. A call a script makes (`codemode`) is part
of the script's result, which is shortened or not as `codemode` is. The log
keeps every result whole, and the request still rebuilds from it
(`rebuildRequest`); the model can run the tool again for the rest. It requires
`ToolRunner` (`tools.registry`), whose list says which tools are
`irreplaceable`.

An edit changes what earlier requests sent, so the request after it declares
its prompt afresh ([append-only
requests](../../agent/loop/README.md#append-only-requests)): the provider
caches it anew, and Anthropic's newest models lose the thinking made before
it. A summary does the same, so shortening in its place costs no more, loses
less, and needs no model call; it is not done at any other time.

| Config       | Default | What it does                                                                                  |
| ------------ | ------- | --------------------------------------------------------------------------------------------- |
| `room`       | `0.1`   | Share of the window shortening must leave free below compaction's threshold, or it summarizes |
| `minChars`   | `4000`  | Characters a tool result's text must exceed to be shortened                                   |
| `keepChars`  | `1000`  | Characters of a shortened result kept, half from its start, half its end                      |
| `keepRecent` | `20000` | Tokens of the latest conversation whose tool results are left whole                           |
| `exclude`    | `[]`    | Tools whose results are left whole, besides the `irreplaceable` ones                          |

Add a tool to `exclude` when running it again would not give its result back
and it does not say so itself, such as an MCP server's memory tool.

It is off by default until it is measured to help, on
[Harbor](../../../evals/harbor/README.md): shortening a result the model still
needs costs it a tool call to get it back.
