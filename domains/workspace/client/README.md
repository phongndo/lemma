# workspace.client

Provides `Workspace`
([`@lemma/workspace/web`](../contract/src/web/workspace.ts)) for the web app:
projects, and the directory the composer works in. The sidebar, the composer, a
new thread's start line, the thread card, and the palette read it. It asks the
host through `WorkspaceChannels` (`workspace.places`, `workspace.status`,
`workspace.create-directory`, `workspace.create-worktree`). It adds to no slot.
No config.

## Behavior

- **Kept in this browser** (`localStorage`): projects added by hand
  (`lemma.projects`), projects removed (`lemma.hiddenProjects`), each
  project's settings (`lemma.projectSettings`), and whether new threads start
  in a worktree (`lemma.newWorktree`) made from the remote
  (`lemma.worktreeFromRemote`). Another browser starts without them. Projects
  with threads come from the host's sessions, so every browser lists those.
- **Projects.** A worktree's threads belong to its repository's project, so
  `projects` never lists a worktree. A folder not yet placed waits rather than
  show as a project. A folder the host could not place is its own project
  until asked again, when the connection comes back or a turn there ends.
- **New threads start in the project** of the thread shown, not its worktree
  (`Threads.startIn`). `/new` keeps the thread's own folder. A removed project
  is no longer where new threads start. With no thread open and no folder
  picked, new threads start in `<home>/scratch` on the host, never in the
  host's own directory.
- **Status** is asked again when the working directory or the connection
  changes, a turn starts or ends, the window regains focus, or `refresh` runs
  (`commands.client` calls it after each command). A failed refresh keeps the
  last status.
- **New worktrees.** With the worktree draft on, in a git checkout that is not
  a worktree, `newChatDir` creates a worktree on a branch named from the first
  message: `lemma/` and its first five words, at most 40 characters
  (`lemma/fix-the-login-redirect-please`, else `lemma/task`). The host makes
  the name unique. The base is the picked branch, else the current one; with
  `fromRemote`, the host fetches it and starts from its remote version. The
  thread works in the same subfolder of the worktree as in the project, else
  its root.
- **Opening a folder** (`open`) adds its project (a worktree's repository) and
  starts a thread there. A path with no folder on the host shows an error and
  returns false.
