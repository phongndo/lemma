# cli.registry

Provides `CliRunner` (`@lemma/cli`), which lists and runs the commands plugins
add to `CliCommands` and the checks they add to `CliChecks`, and serves it to
clients as the channels `CliChannels` declares (`cli.commands`, `cli.run`,
`cli.cancel`, `cli.checks`) with `serveCli`, which a replacement uses as well.

| Config          | Default | Meaning                                                                                                                                  |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `resumeGraceMs` | `30000` | How long a command runs on once its client's connection drops, for the client to rejoin it; and how long a finished one's output is kept |
| `bufferLimit`   | `10000` | How many of a command's elements are kept for a client to rejoin from                                                                    |

## Behavior

- **An invocation outlives its stream.** `cli.run` sends `started` with the
  invocation's id, then the command's output, then its `result`. A command whose
  stream ends early (a dropped connection) runs on. Open `cli.run` again with
  `resume: { invocation, received }` to get what was missed, then the rest, so
  nothing shows or runs twice.
- **Limits.** An invocation left without a reader for `resumeGraceMs` is
  interrupted, as Ctrl+C would. `cli.cancel` interrupts one at once. A client
  further behind than `bufferLimit` gets `Expired`.
- **Within its plugin's lifetime.** A command runs with the contribution that
  added it (`Registries.run`). It ends `Withdrawn` at once when that plugin, or
  this one, stops or reloads, rather than hold up the stop.
- **Questions** reach the client that ran the command (`InteractionOrigin` is
  its `origin`).
- **Errors.** An unknown path is `UnknownCommand`, naming a close match. Input
  its spec rejects is `Usage`. A dismissed question is `Cancelled`. Any other
  failure keeps its code (`asHostError`).
- **Checks** run concurrently, each for at most 10 seconds. One that fails or
  throws reports `fail` with why.
- **Inspector.** `cli.commands` lists every command and the invocations running
  now.
