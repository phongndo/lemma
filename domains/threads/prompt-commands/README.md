# threads.prompt-commands

The `/` menu. Adds the source `prompt-commands` (`Commands`) to
`ComposerCompletions`, with `span: "line"`, over the commands plugins add to
`PromptCommands` ([`@lemma/threads`](../contract/src/threads.ts)), and the
thread's own commands. Requires `Slots`, `Threads`, and `Notify`. No config.

## Behavior

- **A command is a tree.** A `PromptCommands` item is a command, named by its
  id; it may have `aliases`, `subcommands` (each a command of its own, to any
  depth), and `args`. The words of a line name the command and then each
  subcommand under it (`resolveCommand`); the words after them are its
  arguments. An argument may be optional, take the `rest` of the line, or
  `repeat`.
- **Each word in turn.** `/` lists the commands in slot order; past a name, the
  menu offers the subcommands to choose, then the values of the argument being
  typed (`PromptCommandArgument.values`, asked with the path and the arguments
  before it, so a tool's values follow its server). Every list narrows fuzzily
  by name, marking the letters found; an alias that matches shows as itself,
  with the command it stands for.
- **Hints.** Each row hints at what the line takes once it is picked
  (`<server> <tool> <exposure>`, `<list|reconnect|tool>`), and the prompt shows
  the rest of the active row and that hint muted after the cursor: `/mcp rec`
  reads `/mcp reconnect <server>`. Where nothing is to be picked (a free-text
  argument), the hint is what the word takes, and the menu stays closed.
- **Sending.** Enter on a row that leaves nothing required sends the prompt;
  Tab only completes it. The composer runs the command named (`run`), says what
  it still needs when a subcommand or an argument is missing, and sends a
  command whose tree runs nothing here as typed, for a host plugin to answer
  (`/compact`).

| Command                                                   | From                                                       | What it does                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `/new` (`/clear`)                                         | here                                                       | A new thread in the open thread's directory, unless it is blank |
| `/rename <title>`                                         | here                                                       | Renames the open thread                                         |
| `/copy`                                                   | here                                                       | Copies the last reply                                           |
| `/compact [focus]`                                        | [`context.compaction`](../../context/compaction/README.md) | Summarizes the conversation (the host answers it)               |
| `/model <model>`, `/thinking <level>`                     | `llm.model-picker`                                         | The composer's model and its reasoning                          |
| `/settings [section]`                                     | [`settings.page`](../../settings/page/README.md)           | Opens settings                                                  |
| `/mcp <list\|reconnect\|enable\|disable\|exposure\|tool>` | [`mcp.servers`](../../mcp/servers/README.md)               | The MCP servers and how their tools reach the model             |
