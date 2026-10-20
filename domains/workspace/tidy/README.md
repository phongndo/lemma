# workspace.tidy

Keeps worktrees from piling up: removes a worktree Lemma made once its last thread is archived or deleted, and makes it
again when one of its threads is unarchived. It hears archiving from any client (the web app, `lemma sessions`, a
script), since it watches the sessions on the host. Requires `Workspace`, `Sessions`, and `Agent`. Its web half puts
its setting in Settings › General › New threads.

## Config

| Key               | Default | Meaning                                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------------------- |
| `removeOnArchive` | `true`  | Remove a worktree once its threads are archived or deleted; off, they stay until removed |

## Behavior

- **What it removes.** Only a worktree this host made (`Place.made`: in `workspace.local`'s worktree directory), never
  one another tool made, nor a project's own checkout. It goes once every thread working in it (by real path, a folder
  in it too) is archived or deleted, no turn runs in it, and it holds nothing uncommitted (`status`'s `changes`: staged,
  unstaged, or untracked; ignored files do not count). One with uncommitted work stays, to be removed by hand. Its
  branch and commits stay (`Workspace.removeWorktree`).
- **When.** On a thread's archiving and deletion, and when the turn of a thread archived while it ran ends. A thread
  archived and then prompted (its worktree made again to work in) is not tidied when that turn ends: only archiving it
  again does.
- **Making it again.** Unarchiving a thread whose worktree is gone makes it again where it was, on its branch
  (`Workspace.restoreWorktree`), whether this plugin or a person removed it, while `workspace.local` has a record of it.
- **One at a time.** Its observers only note what changed; the git work is queued and done in order, after them, so a
  slow removal never holds up the events and two jobs on one worktree never race. What each job did (removed, kept and
  why, restored) is logged at debug level.
- **Turned off**, nothing is removed or made again on its own; worktrees are removed from the thread card's worktree
  menu or Settings › Projects.
