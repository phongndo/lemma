# commands.registry

Provides `CommandRunner` (`@lemma/commands`), which lists and runs the actions
plugins add to `Commands`: what a person runs from any client, such as the web
app's command palette (Cmd+K on macOS, Ctrl+K elsewhere) or `lemma commands run <id>`. A
command that needs input asks for it with `Interaction`, so every client that
can answer questions can run it.

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
from `@lemma/commands`, which a replacement uses as well. Requires `Paths`: a
run whose client names no `cwd` runs in the host's. No config.

## Behavior

- **Inspector.** `commands.registered` (in `Inspectors`) lists every command with its
  category and the plugin that added it.
- A command's `source` is the plugin that added it, and it leaves with that plugin, or sooner when the removal `add` returns runs. An id another plugin holds fails `Conflict`, naming that plugin, failing the plugin adding it; a plugin's replacement takes its ids over when a reload swaps them, so contributors need not be `exclusive`.
- Every addition and removal, once live, publishes `CommandsChanged` with the full list, which `commands.changes` sends its clients after the list they open it with.
- `run` passes the caller's context (`cwd`, and `sessionId` when the client has a session open). Failures and defects become `CommandError` with reason `Failed` and the original message. A dismissed question becomes `Cancelled`, which clients treat as a quiet stop rather than an error. An unknown id is `NotFound`.
- `run` makes the command part of the lifetime of the plugin that added it (`Registries.run`), so what the command does finds that plugin in `Admitted` (see `ChangeReport` for what that defers); through `commands.run` it is also part of this plugin's call. A command found just as a reload replaced it runs on the replacement.
- Interruption, such as a dropped client, interrupts the command, and so does the command being removed while it runs (the plugin that added it stopping or reloading, or its removal running), or this plugin stopping or reloading while `commands.run` waits on it: the client gets `Withdrawn` at once either way (`run` itself fails `Withdrawn` when the command is removed), rather than a plugin waiting for a command that may wait on a question for good. Running it again reaches a replacement, if there is one.
- `list` is sorted by category, then title.
