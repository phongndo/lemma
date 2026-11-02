# workspace.local

Provides `Workspace` by reading the filesystem and running the `git` CLI. It
keeps `<Lemma home>/worktrees.json`, the worktrees it made or removed.

It serves `Workspace` to clients as the channels `WorkspaceChannels` declares
(`workspace.status`, `workspace.branches`, …), and file search as
`files.search` (`FileChannels`). It uses `serveWorkspace` and `serveFiles` from
`@lemma/workspace`, as a replacement does. File search is served here rather
than by a file searcher so that the call stays while searchers come and go. It
asks `FileSearchers` at each call, and with none fails `Unavailable`.

## Config

| Key         | Default                  | Meaning                                                               |
| ----------- | ------------------------ | --------------------------------------------------------------------- |
| `worktrees` | `<Lemma home>/worktrees` | Where `createWorktree` puts new worktrees, one folder per repository. |

## Behavior

[`Workspace`](../contract/src/workspace.ts) documents what each operation
returns and how it fails. This plugin adds:

- **Paths.** `~` and `~/…` expand against the OS home directory. A path still
  relative after that is treated as missing, since nothing meaningful resolves
  it. Errors and statuses report the expanded path.
- **Running git.** Git runs without a shell, with `GIT_TERMINAL_PROMPT=0`,
  `GIT_OPTIONAL_LOCKS=0` (so reads never lock the index), and `LC_ALL=C`.
  Inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR`
  are dropped. Reads time out after 5s, `checkout` after 15s, and a fetch after
  60s. Output is capped at 16 MiB.
- **`status`** never fails. `git` is absent outside a work tree, and when git
  fails or times out. An untracked directory counts as one change.
- **`checkout`** refuses a name `git check-ref-format --branch` rejects, one
  starting with `-`, or one not literal (`@{-1}`), as `InvalidName`. It never
  passes `--force` or `--discard-changes`, so git refuses rather than overwrite
  local changes.
- **`browse`** returns at most 200 directories. A symlink counts when it points
  at a directory.
- **`places`** asks git eight paths at a time, for the branch with
  `git branch --show-current`: a reftable repository's HEAD file names none. A
  bare repository's worktree is its own project.
- **`createWorktree`** puts a worktree in `<worktrees>/<repository>/<branch>`,
  with `/` in the branch written `-`. A branch or folder that exists already
  takes the first free suffix, `-2`, `-3`, …, for both. With `fromRemote`, a
  base with no remote branch is refused.
- **`worktrees`** reads a git before 2.36, which has no `-z`, line by line.
- **`restoreWorktree`** forgets a stale git entry with `git worktree remove`
  rather than a prune, which would forget every worktree whose folder is
  missing at the moment (one on a drive not mounted).
- **`worktrees.json`** maps each worktree made or removed, by its root, to its
  repository's main work tree and its branch. Entries outlive the worktree, so
  its threads stay under its project and it can be restored. It is written
  whole (`writeFileAtomic`), one write at a time. A failed write loses only the
  record, not the worktree.
