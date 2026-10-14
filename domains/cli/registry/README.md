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

- **An invocation outlives its stream.** `cli.run` starts one and sends
  `started` with its id, then what the command prints, then its `result`.
  When the stream ends early (a dropped connection), the command runs on;
  the client opens `cli.run` again with `resume: { invocation, received }`
  and gets what it missed, then the rest, so nothing is shown twice and the
  command never runs twice. One left without a reader for `resumeGraceMs` is
  interrupted, as Ctrl+C would; `cli.cancel` interrupts one at once. A
  client that fell further behind than `bufferLimit` gets `Expired`.
- **Within its plugin's lifetime.** A command runs as work with the
  contribution that added it (`Registries.run`), and stops at once, ending
  `Withdrawn`, when that plugin stops or reloads, rather than hold up its
  stop. This plugin's own reload ends every invocation the same way.
- **Questions.** A command runs with `InteractionOrigin` set to the client's
  `origin`, so its questions reach that client.
- **Errors.** An unknown path is `UnknownCommand` (with the path meant, when a
  typo is close), input its spec rejects `Usage`, a dismissed question
  `Cancelled`; any other failure keeps its code (`asHostError`).
- **Checks** run concurrently, each for at most 10 seconds; one that fails or
  throws reports `fail` with why.
- **Inspector.** `cli.commands` lists every command and the invocations
  running now.
