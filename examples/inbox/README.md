# Inbox (an example of telling the model something where it happened)

Inbox triage, an agent for something other than code. Messages arrive as
files in a folder of the project (`inbox/`, a message a file: header lines
such as `From:` and `Subject:`, a blank line, then the body, as an email
is), and the agent sorts them.

The [host half](inbox.ts) appends a `context` event when something new is
there, before the request that follows its arrival, so a message that
arrives during a turn is seen at its next step. The event holds each
message's id, sender, subject, and first lines; the model reads one in full
with `inbox_read` and files it in a folder (`reply`, `later`, `done`) with
`inbox_file`, which moves it out of the inbox. A prompt section would repeat
the inbox in every request, and change the system prompt (and lose the
provider's cache) whenever mail arrived; a `context` event tells the model
once, where it happened, and the log keeps what it was shown and when, so
the request still rebuilds from the log. The transcript shows it there too.
A branch shows each message once: a `custom` event records the ids it showed.

Its package brings the `triage` mode ([`modes/triage.md`](modes/triage.md))
by naming the folder in its manifest (`"resources": { "modes": "./modes" }`):
pick **triage** in the composer and the agent is offered only the inbox's
tools, with instructions for sorting.

| Shape     | What it uses                                                            |
| --------- | ----------------------------------------------------------------------- |
| Add       | `Tools` (`inbox_read`, `inbox_file`)                                    |
| Intercept | `AgentRequestHook`, in `shape`, appending `context` and `custom` events |

The folder is `inbox` in the session's directory; its row's `config.dir`
names another.

To use it:

```sh
ln -s "$PWD/examples/inbox" ~/.lemma-dev/plugins/inbox   # or copy the folder, into ~/.lemma/plugins for an installed Lemma
```

`nix develop -c pnpm --filter @lemma/example-inbox test` runs it in real
turns, with the agent, the session log, and a scripted model
(`scriptedLlm` from `@lemma/llm/testing`).
