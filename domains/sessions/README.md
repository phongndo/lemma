# sessions

The session log, the source of truth every request is rebuilt from, and its store. Its contract is [`@lemma/sessions`](contract/src/sessions.ts), with the projections every reader shares.

| Plugin                              | Halves | What it does                                                                                         |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| [`sessions.files`](files/README.md) | host   | Stores each session as a JSONL file: provides `Sessions`, and serves it as the `sessions.*` channels |
| [`sessions.cli`](cli/README.md)     | host   | The `lemma` command's `sessions …`, `inspect` among them: adds them to `CliCommands`                 |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | Events: a `context` event tells the model something where it happened (an email, a reading); a `custom` one keeps a plugin's own data, unseen     |
| Intercept | `SessionRemoveHook`: a session about to be deleted; `SessionCheckoutHook`: a session's leaf about to move                                         |
| Observe   | `SessionAppended`, `SessionChanged`, `SessionCheckedOut`, `SessionRemoved`                                                                        |
| Call      | `Sessions`: create, append, read a branch, check out, move an empty one, fork a branch into a new session, search; clients call `SessionChannels` |
| Serve     | `Sessions`, with `serveSessions`: a plugin providing it replaces `sessions.files`                                                                 |
