# cli

The `lemma` command's plugin side: the commands and checks host plugins add to
it. Its contract is [`@lemma/cli`](contract/src/index.ts): how a command line
becomes a command's input (`CommandSpec`, `parseInput`), the commands and
checks plugins add, and the channels a client runs them by. The command
itself is [`apps/cli`](../../apps/cli/README.md), a client that holds no domain:
its own commands are the runtime's and this machine's, and every other comes
from the host it talks to.

| Plugin                               | Halves | What it does                                                                                 |
| ------------------------------------ | ------ | -------------------------------------------------------------------------------------------- |
| [`cli.registry`](registry/README.md) | host   | Lists and runs what plugins add: provides `CliRunner`, and serves it as the `cli.*` channels |

Each domain adds its own commands with a plugin of its own, named `<domain>.cli`:
[`sessions.cli`](../sessions/cli/README.md), [`agent.cli`](../agent/cli/README.md),
[`llm.cli`](../llm/cli/README.md), [`workspace.cli`](../workspace/cli/README.md), and
[`commands.cli`](../commands/cli/README.md).

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `CliCommands`: a command (`defineCliCommand`); `CliChecks`: a check `lemma doctor` runs once a host is up; `InProgress`: work stopping the host would cut off, which `lemma stop`, `lemma status`, and the desktop app's quit show |
| Intercept | None of its own: a command's questions go through the host's `InteractionHook`                                                                                                                                                     |
| Observe   | None                                                                                                                                                                                                                               |
| Call      | `CliRunner`: list, run, cancel, the checks, and what is in progress; clients call `CliChannels`. `callHere` and `followHere` reach another domain's channels from a command                                                        |
| Serve     | `CliRunner`, with `serveCli`: a plugin providing it replaces `cli.registry`                                                                                                                                                        |

## A command

```ts
import { CliCommands, defineCliCommand } from "@lemma/cli";

export default definePlugin({
  id: "greet",
  setup: function* (_, owner) {
    yield* owner.add(
      CliCommands,
      defineCliCommand({
        path: ["greet"],
        summary: "Greet someone",
        args: [{ name: "name", description: "Who", required: true }],
        flags: { loud: { type: "boolean", description: "Shout" } },
        run: ({ args, flags }) => {
          const text = `hello, ${args.name}`;
          return { json: { greeted: args.name }, text: flags.loud ? text.toUpperCase() : text };
        },
      }),
    );
  },
});
```

`lemma greet ada --loud` runs it, `lemma help greet` prints its help, and
`lemma help --json` lists it with a JSON Schema of what it takes.

- **Where it runs.** On the host, with what the host has: a command reaches
  its own domain through its capability or, to go on across that domain's
  reloads as a client would, through its channels (`callHere`,
  `followHere`). The client parses the words, so a usage error never reaches
  the host, and reads a `file` flag's file itself, so a host on another
  machine receives its content.
- **What it prints.** It returns a `CliResult`: `json` for `--json`, `text`
  otherwise, `ids` for `--quiet`, `failed` to exit 1. On the way it prints
  through `out` (text, or JSON lines when the client asked for JSON), asks the
  client to open a page (`out.open`), names the questions the client answers
  besides its own (`out.answer`), and gives the command line that runs it
  again safely (`out.rerun`: a run's, with its session and `--request-id`).
- **Its errors.** A `CliCommandError`'s `reason` is the client's error code:
  `Usage` exits 2, as a bad command line does; anything else exits 1. A
  domain's own error keeps its reason or tag.
- **Paths.** The `lemma` command's own commands come first: a path under one
  of them (`config edit`, say) is never reached. A path is one plugin's at a
  time.
