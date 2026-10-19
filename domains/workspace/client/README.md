# workspace.client

Projects and the directory the composer works in, for the web app: provides
`Workspace` ([`@lemma/workspace/web`](../contract/src/web/workspace.ts)), which
the sidebar, the composer, the workspace bar, and the palette read. It asks
the host through `WorkspaceChannels` (`workspace.status`,
`workspace.create-directory`, `workspace.create-worktree`). Requires `Client`,
`Notify`, and `Threads` (`@lemma/threads`); adds to no slot. No config.

## Behavior

- **Kept in this browser.** Projects added by hand, projects removed, each
  project's settings, and whether new threads start in a worktree live in
  `localStorage` (`lemma.projects`, `lemma.hiddenProjects`,
  `lemma.projectSettings`, `lemma.newWorktree`), not on the host, so another
  browser starts without them. Projects with threads come from the host's
  sessions, so every browser lists those.
- **No project.** While connected, with no thread open and no folder picked,
  it makes `standaloneDir` (`<home>/scratch` on the host) where a new thread
  starts when nothing else says (`Threads.startIn`), creating the folder when
  it is missing: a new chat never defaults to the host's own directory.
- **Status.** `workspace.status` is asked again when the working directory or
  the connection changes, when a turn starts or ends, when the window regains
  focus, and on `refresh` (which `commands.client` calls after each command).
  A failed refresh keeps the last status; one for a directory no longer
  current is dropped.
- **New worktrees.** With the worktree draft on and the working directory in a
  git repository, `newChatDir` creates a worktree on a branch named from the
  first message: `lemma/` and its first five words, lowercase letters, digits,
  and hyphens, at most 40 characters (`lemma/fix-the-login-redirect-please`;
  `lemma/task` when nothing is left). The host makes the name unique. The
  picked base branch is cleared after, and changing the working directory
  resets the draft to the project's `worktree` setting, else the global one.
- **Opening a folder** (`open`) also adds it to the projects added by hand,
  and starts a thread there: the thread shown, moved there while that is blank,
  as picking a project does. A path with no folder on the host shows an error
  and returns false.
