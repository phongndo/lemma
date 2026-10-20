# workspace.client

Projects and the directory the composer works in, for the web app: provides
`Workspace` ([`@lemma/workspace/web`](../contract/src/web/workspace.ts)), which
the sidebar, the composer, a new thread's start line, the thread card, and
the palette read. It asks the host through `WorkspaceChannels` (`workspace.places`,
`workspace.status`, `workspace.create-directory`, `workspace.create-worktree`). Requires `Client`,
`Notify`, and `Threads` (`@lemma/threads`); adds to no slot. No config.

## Behavior

- **Kept in this browser.** Projects added by hand, projects removed, each
  project's settings, whether new threads start in a worktree, and whether a
  new worktree starts from the remote live in `localStorage` (`lemma.projects`,
  `lemma.hiddenProjects`, `lemma.projectSettings`, `lemma.newWorktree`,
  `lemma.worktreeFromRemote`), not on the host, so another
  browser starts without them. Projects with threads come from the host's
  sessions, so every browser lists those.
- **Places.** Where each thread's folder and each folder added by hand sits
  (`place`), and so the project it belongs to (`projectOf`), is asked for
  every folder not yet asked about, in one `workspace.places` call, and again
  for one where a turn ended or that `refreshPlaces` names; an answer to an
  older call that arrives after a newer one is dropped. A worktree's threads
  belong to its repository's project, so `projects` never lists a worktree,
  and a folder not yet placed waits rather than show as a project of its own.
  A folder the host could not place (the call failed, or a replacement serves
  no places) is its own project until asked again: when the connection comes
  back, or a turn there ends. `projectName`, `projectSettings`, and
  `configureProject` go by the project too.
- **New threads start in the project** of the thread shown, not in its
  worktree: it keeps `Threads.startIn` at that project, where `newThread`
  starts a thread when not told where (`/new` keeps the thread's own folder).
  A project removed (`remove`) is no longer where new threads start, so a
  thread deleted with it does not bring it back.
- **No project.** While connected, with no thread open and no folder picked,
  it makes `standaloneDir` (`<home>/scratch` on the host) where a new thread
  starts when nothing else says (`Threads.startIn`), creating the folder when
  it is missing: a new chat never defaults to the host's own directory.
- **Status.** `workspace.status` is asked again when the working directory or
  the connection changes, when a turn starts or ends, when the window regains
  focus, and on `refresh` (which `commands.client` calls after each command).
  A failed refresh keeps the last status; one for a directory no longer
  current is dropped.
- **New worktrees.** With the worktree draft on and the working directory a
  checkout of a git repository that is not a worktree already (`newWorktree`),
  `newChatDir` creates a worktree on a branch named from the
  first message: `lemma/` and its first five words, lowercase letters, digits,
  and hyphens, at most 40 characters (`lemma/fix-the-login-redirect-please`;
  `lemma/task` when nothing is left). The host makes the name unique. The
  base branch is the picked one, else the current; with `fromRemote` on, the
  host fetches it and starts from its remote version. The thread works in the
  same folder of the worktree as in the project (a monorepo package's, its
  package), or the worktree's root when the new branch has no such folder;
  the host places it before the thread moves there. The picked base branch
  is cleared after, and changing the working directory resets the draft to the
  project's `worktree` setting, else the global one.
- **Opening a folder** (`open`) adds its project to the projects added by
  hand (a worktree's, its repository), and starts a thread in the folder: the thread shown, moved there while that is blank,
  as picking a project does. A path with no folder on the host shows an error
  and returns false.
