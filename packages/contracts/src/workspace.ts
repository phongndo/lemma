import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";

/** A directory's version-control state. `branch` is null on a detached HEAD. */
export const GitStatus = Schema.Struct({
  root: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** Abbreviated commit id; absent in a repository with no commits. */
  head: Schema.optional(Schema.String),
  /** Changed, staged, or untracked paths. */
  changes: Schema.Number,
  upstream: Schema.optional(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  /** Set in a linked worktree: the repository's main work tree. */
  worktreeOf: Schema.optional(Schema.String),
});
export type GitStatus = typeof GitStatus.Type;

/** What a client needs to show a project: whether the path is usable, and its git state if any. */
export const WorkspaceStatus = Schema.Struct({
  /** The absolute path asked about, `~` expanded. */
  path: Schema.String,
  exists: Schema.Boolean,
  git: Schema.optional(GitStatus),
});
export type WorkspaceStatus = typeof WorkspaceStatus.Type;

export const GitBranch = Schema.Struct({
  name: Schema.String,
  current: Schema.Boolean,
  /** Remote-tracking refs (`origin/x`); checking one out creates or switches to the local `x`. */
  remote: Schema.Boolean,
  /** Epoch milliseconds of the tip commit, for recency ordering. */
  updatedAt: Schema.Number,
  /** Checked out in another worktree at this path; git will not check it out a second time. */
  worktree: Schema.optional(Schema.String),
});
export type GitBranch = typeof GitBranch.Type;

/** A directory offered while typing a path; `git` marks a repository root. */
export const DirectoryEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  git: Schema.Boolean,
  /** Indices into `name` that matched the typed filter, for highlighting. */
  matches: Schema.Array(Schema.Number),
});
export type DirectoryEntry = typeof DirectoryEntry.Type;

/**
 * Completion for a partly typed path: `~/code/bs` lists the directories in
 * `~/code` whose names contain `b` then `s` (prefix matches first, then
 * substring, then scattered); `~/code/` lists all of them. Hidden directories
 * appear only when the typed name starts with a dot.
 */
export const DirectoryListing = Schema.Struct({
  /** The absolute directory that was listed. */
  parent: Schema.String,
  entries: Schema.Array(DirectoryEntry),
  /** More matched than were returned. */
  truncated: Schema.Boolean,
});
export type DirectoryListing = typeof DirectoryListing.Type;

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly path: string;
  readonly reason: "NotFound" | "NotRepository" | "InvalidName" | "Exists" | "Failed";
  /** For `Failed`, git's own explanation (a dirty tree blocking checkout, say). */
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The directories sessions run in. Paths may start with `~`. Reads never
 * change the repository (no index refresh, no fetch); `checkout` is the only
 * write and does what `git switch` would, refusing rather than discarding work.
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    readonly status: (path: string) => Effect.Effect<WorkspaceStatus>;
    /** Never fails: an unreadable or missing parent lists nothing. */
    readonly browse: (partialPath: string) => Effect.Effect<DirectoryListing>;
    /** Create the directory (and missing parents) unless something already exists there. */
    readonly createDirectory: (path: string) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
    /** Local branches first by recency, then remote-tracking ones without a local counterpart. */
    readonly branches: (path: string) => Effect.Effect<readonly GitBranch[], WorkspaceError>;
    /**
     * Create a linked worktree of the repository at `path` on a new branch
     * `branch` (made unique with a numeric suffix if taken), started from `base`
     * (default HEAD). Worktrees live under the host's worktree directory, one
     * folder per repository. Returns the new worktree's status.
     */
    readonly createWorktree: (path: string, options: { readonly branch: string; readonly base?: string }) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
    /** Switch to `branch`, creating it from HEAD when `create` is set. Returns the new status. */
    readonly checkout: (path: string, branch: string, options?: { readonly create?: boolean }) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
  }
>()("lemma/Workspace") {}
