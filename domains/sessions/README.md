# sessions

The session log, the source of truth every request is rebuilt from, and its store. Its contract is [`@lemma/sessions`](contract/src/sessions.ts), with the projections every reader shares.

| Plugin                              | Halves | What it does                                                                                         |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| [`sessions.files`](files/README.md) | host   | Stores each session as a JSONL file: provides `Sessions`, and serves it as the `sessions.*` channels |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                             |
| --------- | ------------------------------------------------------------------------------------ |
| Add       | Nothing: what a session holds is its events                                          |
| Intercept | `SessionRemoveHook`: a session about to be deleted                                   |
| Observe   | `SessionAppended`, `SessionChanged`, `SessionRemoved`                                |
| Call      | `Sessions`: create, append, read a branch, check out; clients call `SessionChannels` |
| Serve     | `Sessions`, with `serveSessions`: a plugin providing it replaces `sessions.files`    |
