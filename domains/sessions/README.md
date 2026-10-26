# sessions

The session log, the source of truth every request is rebuilt from, and its store. Its contract is [`@lemma/sessions`](contract/src/sessions.ts), with the projections every reader shares.

| Plugin                              | Halves | What it does                                                                                         |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| [`sessions.files`](files/README.md) | host   | Stores each session as a JSONL file: provides `Sessions`, and serves it as the `sessions.*` channels |
| [`sessions.cli`](cli/README.md)     | host   | The `lemma` command's `sessions …`, `inspect` among them: adds them to `CliCommands`                 |

A plugin replacing `sessions.files` runs `sessionsConformance` from `@lemma/sessions/testing`: the tests `sessions.files` passes, against the contract alone.

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | Events: a `context` event tells the model something where it happened (an email, a reading); a `custom` one keeps a plugin's own data, unseen                                                                                                                                |
| Intercept | Nothing                                                                                                                                                                                                                                                                      |
| Observe   | `SessionAppended`, `SessionChanged`, `SessionRemoved`                                                                                                                                                                                                                        |
| Call      | `Sessions`: create, append, read a branch, check out, move an empty one, fork a branch into a new session, search; clients call `SessionChannels`. A session made as an agent of another names it (`SessionInfo.parent`, fixed when it is made: `create` and `fork` take it) |
| Serve     | `Sessions`, with `serveSessions`: a plugin providing it replaces `sessions.files`                                                                                                                                                                                            |
