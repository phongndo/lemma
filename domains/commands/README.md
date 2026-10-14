# commands

Actions a person runs from any client: the web app's palette, `lemma commands run`. Its contract is [`@lemma/commands`](contract/src/commands.ts), with the web app's side in `@lemma/commands/web`.

| Plugin                                    | Halves | What it does                                                                                      |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| [`commands.registry`](registry/README.md) | host   | Lists and runs the commands: provides `CommandRunner`, and serves it as the `commands.*` channels |
| [`commands.host`](host/README.md)         | host   | The host's own commands: reload the config, restart a plugin, turn one on or off                  |
| [`commands.client`](client/)              | web    | The commands the host offers, for the palette                                                     |
| [`commands.cli`](cli/README.md)           | host   | The `lemma` command's `commands` and `commands run`: adds them to `CliCommands`                   |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                  |
| --------- | ----------------------------------------------------------------------------------------- |
| Add       | `Commands`: a command, which asks for what it needs with `Interaction`                    |
| Intercept | None of its own: a command's questions go through the host's `InteractionHook`            |
| Observe   | `CommandsChanged`: the whole list, whenever one comes or goes                             |
| Call      | `CommandRunner`: list and run; clients call `CommandChannels`; in the web app, `Commands` |
| Serve     | `CommandRunner`, with `serveCommands`: a plugin providing it replaces `commands.registry` |

Other domains' commands live in those domains: `llm.commands`, `workspace.commands`.
