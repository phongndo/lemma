# commands.client

The host's commands, for the web app: provides `Commands`
([`@lemma/commands/web`](../contract/src/web.ts)), which lists and runs what
host plugins add to the host's `Commands` registry, and which the command
palette (`actions.palette`) shows. It keeps the list from `commands.changes`
and runs a command through `commands.run` (`CommandChannels` in
[`@lemma/commands`](../contract/src/commands.ts)). Requires `Client`,
`Notify`, `Threads` (`@lemma/threads`), and `Workspace`
(`@lemma/workspace/web`); adds to no slot. No config.

## Behavior

- **Where it runs.** A command runs in the composer's working directory
  (`Workspace.workingDir`) and, while a thread is open, with its `sessionId`.
- **How it went.** Success shows a toast with the command's `message`, or
  `<title>: done` without one; a failure is reported (`Notify.report`). A
  dismissed question (`Cancelled`) ends it quietly. `run` resolves false
  for both, so the palette stays open.
- **After it.** Every run, however it ends, refreshes `Workspace`'s status,
  since a command may have committed or switched branches.
- **The list** is the latest `commands.changes` sent, empty until the first;
  `Client.follow` opens it again after a reconnect, or when
  `commands.registry` restarts or is replaced.
