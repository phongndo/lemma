# threads.prompt-commands

The `/` menu. It adds the source `prompt-commands` (`Commands`) to
`ComposerCompletions`, with `span: "line"`. It offers the commands plugins add
to `PromptCommands` ([`@lemma/threads`](../contract/src/threads.ts)), and the
thread's own commands. No config.

## Behavior

- **A command is a tree.** A `PromptCommands` item is named by its id, and may
  have `aliases`, `subcommands` (to any depth), and `args`. The words of a line
  name the command and each subcommand under it (`resolveCommand`). The words
  after them are its arguments.
- **Arguments** may be optional, take the `rest` of the line, or `repeat`. The
  menu offers an argument's `PromptCommandArgument.values`, asked with the path
  and the arguments before it, so a tool's values follow its server.
- **Hints.** Each row hints at what the line takes once picked
  (`<server> <tool> <exposure>`). A free-text argument shows its hint after the
  cursor and keeps the menu closed.
- **Sending.** Enter on a row that leaves nothing required sends the prompt; Tab
  only completes it. A command whose tree runs nothing here is sent as typed,
  for a host plugin to answer (`/compact`).

| Command                                                   | From                                                       | What it does                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `/new` (`/clear`)                                         | here                                                       | A new thread in the open thread's directory, unless it is blank |
| `/rename <title>`                                         | here                                                       | Renames the open thread                                         |
| `/copy`                                                   | here                                                       | Copies the last reply                                           |
| `/compact [focus]`                                        | [`context.compaction`](../../context/compaction/README.md) | Summarizes the conversation (the host answers it)               |
| `/model <model>`, `/thinking <level>`                     | `llm.model-picker`                                         | The composer's model and its reasoning                          |
| `/settings [section]`                                     | [`settings.page`](../../settings/page/README.md)           | Opens settings                                                  |
| `/mcp <list\|reconnect\|enable\|disable\|exposure\|tool>` | [`mcp.servers`](../../mcp/servers/README.md)               | The MCP servers and how their tools reach the model             |
