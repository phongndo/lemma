# @lemma/plugin-commands

Provides `Commands` (`@lemma/contracts`): the registry of actions a person can
run from any client, such as the web app's command palette (Cmd+K on macOS,
Ctrl+K elsewhere) or `lemma do <id>`. Command plugins require `Commands` and
register during activation. A command that needs input asks for it with
`Interaction`, so every client that can answer questions can run it.

```ts
const greet = definePlugin({
  id: "greet",
  requires: [Commands, Interaction],
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const [commands, ask] = yield* Effect.all([Commands, Interaction]);
      yield* commands.register({
        id: "greet.hello",
        title: "Say hello…",
        category: "Examples",
        run: ({ cwd }) => Effect.map(ask.ask("Your name?"), (name) => ({ message: `Hello, ${name}, in ${cwd}` })),
      });
    }),
  ),
});
```

Serves `Commands` to clients as the channels `CommandChannels` declares
(`commands.list`, `commands.run`, and `commands.changes`), with `serveCommands`
from `@lemma/contracts`, which a replacement uses as well. Requires `Paths`: a
run whose client names no `cwd` runs in the host's. No config.

## Behavior

- **Inspector.** `commands.registered` (in `Inspectors`) lists every command with its
  category and the plugin that added it.
- `register` records the registering plugin's id as `source` and removes the command when that plugin's scope closes. An id another plugin holds fails `Failed`, naming that plugin; a plugin's replacement takes its ids over when a reload swaps them, so contributors need not be `exclusive`.
- Every registration and removal, once live, publishes `CommandsChanged` with the full list, and `changes` gives that list.
- `run` passes the caller's context (`cwd`, and `sessionId` when the client has a session open). Failures and defects become `CommandError` with reason `Failed` and the original message. A dismissed question becomes `Cancelled`, which clients treat as a quiet stop rather than an error. An unknown id is `NotFound`. Interruption, such as a dropped client, interrupts the command.
- `list` is sorted by category, then title.
