# @lemma/plugin-workspace

Provides `Workspace` by reading the filesystem and running the `git` CLI: `status`, `browse`, `createDirectory`, `branches`, `createWorktree`, and `checkout`. Requires `Paths`.

Serves it to clients as the channels `WorkspaceChannels` declares (`workspace.status`, `workspace.branches`, …), and file search as `files.search` (`FileChannels`), with `serveWorkspace` and `serveFiles` from `@lemma/contracts`, which a replacement uses as well. File search is served here rather than by a file searcher so that the call stays while searchers come and go: it asks `FileSearchers` at each call, and with none fails `Unavailable`.

## Config

| Key         | Default                  | Meaning                                                               |
| ----------- | ------------------------ | --------------------------------------------------------------------- |
| `worktrees` | `<Lemma home>/worktrees` | Where `createWorktree` puts new worktrees, one folder per repository. |

## Behavior

- **Paths.** `~` and `~/…` expand against the OS home directory; absolute paths are normalized. A path that is still relative is treated as missing: there is no meaningful base to resolve it against. Errors and statuses report the expanded path.
- **Running git.** `execFile` without a shell, with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (so reads never refresh or lock the index), and `LC_ALL=C`; inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR` are dropped. Reads time out after 5s, `checkout` after 15s; output is capped at 16 MiB.
- **`status`** never fails. `exists` is false unless the path is a directory; `git` is absent outside a work tree (including when git fails or times out). It comes from `git status --porcelain=v2 --branch -z` plus `rev-parse --show-toplevel` and `rev-parse --short HEAD`: `branch` is null on a detached HEAD, `head` is absent before the first commit, and `changes` counts staged, unstaged, conflicted, and untracked entries (an untracked directory counts once).
- **`browse`** lists the directories in what `partialPath` names (`~/code/`), or in its parent filtered by its last segment (`~/code/ba`): a prefix match first, then the segment anywhere in the name, then its letters in order; at most 200. Dot directories show only when the segment starts with `.`; a symlink counts when it points at a directory.
- **`createDirectory`** makes the directory and its missing parents, and fails `Exists` when anything is already there.
- **`branches`** lists `refs/heads` by committer date, newest first, then `refs/remotes` refs whose name after the remote (`origin/x` → `x`) has no local branch; `*/HEAD` symrefs are skipped. Fails `NotFound` (not a directory) or `NotRepository` (not in a work tree).
- **`checkout`** first checks the name with `git check-ref-format --branch` and fails `InvalidName` for anything invalid, starting with `-`, or not literal (`@{-1}`). Then: `create` runs `git switch -c <name>`; an existing local branch runs `git switch <name>`; a remote-tracking ref `origin/x` switches to local `x`, creating it with `--track` if missing; anything else is left to `git switch <name>`. It never passes `--force` or `--discard-changes`, so git refuses rather than overwriting local changes; any git failure is `Failed` with git's trimmed stderr as the message. On success it returns a fresh `status`.
- **`createWorktree`** checks the branch name as `checkout` does, then runs `git worktree add -b <branch>` from `base` (default `HEAD`) into `<worktrees>/<repository>/<branch>`, with `/` in the branch written `-`. A branch or folder that exists already takes the first free suffix, `-2`, `-3`, … for both.
