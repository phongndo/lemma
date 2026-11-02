# commands.registry

Provides `CommandRunner` (`@lemma/commands`), which lists and runs the actions
plugins add to `Commands`: what a person runs from any client, such as the web
app's command palette (Cmd+K on macOS, Ctrl+K elsewhere) or
`lemma commands run <id>`. A command that needs input asks for it with
`Interaction`, so every client that can answer questions can run it.

```ts
const greet = definePlugin({
  id: "greet",
  requires: { ask: Interaction },
  setup: function* ({ ask }, owner) {
    yield* owner.add(Commands, {
      id: "greet.hello",
      title: "Say hello…",
      category: "Examples",
      run: ({ cwd }) => Effect.map(ask.ask("Your name?"), (name) => ({ message: `Hello, ${name}, in ${cwd}` })),
    });
  },
});
```

Serves them to clients as the channels `CommandChannels` declares
(`commands.list`, `commands.run`, and `commands.changes`), with `serveCommands`
from `@lemma/commands`, which a replacement uses as well. A run whose client
names no `cwd` runs in the host's (`Paths`). No config.

## Behavior

- **Inspector.** `commands.registered` (in `Inspectors`) lists every command
  with its category and the plugin that added it.
- **Ownership.** A command's `source` is the plugin that added it. It leaves
  with that plugin, or when the removal `add` returns runs. An id another plugin
  holds fails `Conflict`, naming that plugin. A plugin's replacement takes its
  ids over in a reload, so contributors need not be `exclusive`.
- **Changes.** Every addition and removal, once live, publishes
  `CommandsChanged` with the full list, which `commands.changes` sends on.
- **Running.** `run` passes the caller's `cwd`, and `sessionId` when the client
  has a session open. A failure or defect is `CommandError` `Failed`, with the
  original message. A dismissed question is `Cancelled`, which clients treat as
  a quiet stop. An unknown id is `NotFound`.
- **Lifetime.** A command runs within the lifetime of the plugin that added it
  (`Registries.run`), so its work finds that plugin in `Admitted` (see
  `ChangeReport` for what that defers). A command found just as a reload
  replaced it runs on the replacement.
- **Interruption.** A dropped client interrupts the command. So does its removal
  while it runs, or this plugin stopping while `commands.run` waits on it. The
  client gets `Withdrawn` at once, rather than wait on a command that may wait
  on a question for good.
- `list` is sorted by category, then title.
