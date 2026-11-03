# workspace.tidy

Keeps worktrees from piling up. It removes a worktree Lemma made once its last
thread is archived or deleted, and makes it again when one of its threads is
unarchived. It watches the sessions on the host, so it hears archiving from any
client (the web app, `lemma sessions`, a script). Its web half puts its setting
in Settings › General › New threads.

## Config

| Key               | Default | Meaning                                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------------------- |
| `removeOnArchive` | `true`  | Remove a worktree once its threads are archived or deleted; off, they stay until removed |

## Behavior

- **What it removes.** Only a worktree this host made (`Place.made`, in
  `workspace.local`'s worktree directory), never another tool's or a project's
  own checkout. It removes one once every thread working in it is archived or
  deleted, no turn runs in it, and it holds nothing uncommitted (ignored files
  do not count). One with uncommitted work stays, to be removed by hand. Its
  branch and commits stay.
- **When.** On a thread's archiving or deletion, and when the turn of a thread
  archived while it ran ends. A thread archived and then prompted is tidied
  only when archived again.
- **Making it again.** Unarchiving a thread whose worktree is gone makes it
  again on its branch, whoever removed it, while `workspace.local` has a record
  of it.
- **One at a time.** The git work is queued and done in order, after the
  observers, so a slow removal never holds up events and two jobs on one
  worktree never race. Each job's outcome is logged at debug level.
- **Turned off**, nothing is removed or made again on its own. Remove
  worktrees from the thread card's worktree menu or Settings › Projects.
