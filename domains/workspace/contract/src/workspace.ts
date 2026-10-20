import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { defineChannel, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";

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

/**
 * Where a directory sits among projects. A thread is filed under its directory's project, so a worktree's threads
 * are its repository's, and a worktree is never a project of its own.
 */
export const Place = Schema.Struct({
  /** The absolute path asked about, `~` expanded. */
  path: Schema.String,
  exists: Schema.Boolean,
  /**
   * The project it belongs to. In a git work tree, the same folder within its repository's main work tree, as git
   * names it (symlinks resolved): a linked worktree's root belongs to the main work tree, a folder in it to that folder
   * there, so a repository reached by two paths is one project. That holds once a worktree this host made or removed
   * is gone, too. Outside git, the path itself.
   */
  project: Schema.String,
  /** It is a linked worktree of `project`'s repository, or was one this host made or removed. */
  worktree: Schema.Boolean,
  /** The branch checked out, null on a detached HEAD; for a worktree this host made or removed that is gone, its branch. */
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  /** A worktree in this host's worktree directory, where `createWorktree` makes them: the host's to tidy away. */
  made: Schema.optional(Schema.Boolean),
});
export type Place = typeof Place.Type;

/** A linked worktree of a repository, as `git worktree list` gives it. */
export const Worktree = Schema.Struct({
  path: Schema.String,
  /** Null on a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  /** Its folder is gone; git lists it until it is pruned or removed. */
  missing: Schema.optional(Schema.Boolean),
});
export type Worktree = typeof Worktree.Type;

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
 * change the repository (no index refresh, no fetch); its writes are
 * `checkout`, which does what `git switch` would, and the worktrees it makes,
 * removes, and restores, and they refuse rather than discard work.
 * Its provider serves it to clients as `WorkspaceChannels` (`serveWorkspace`).
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    readonly status: (path: string) => Effect.Effect<WorkspaceStatus>;
    /** Where each path sits (`Place`), in the order asked; cheaper than `status`, for many at once. Never fails. */
    readonly places: (paths: readonly string[]) => Effect.Effect<readonly Place[]>;
    /** Never fails: an unreadable or missing parent lists nothing. */
    readonly browse: (partialPath: string) => Effect.Effect<DirectoryListing>;
    /** Create the directory (and missing parents) unless something already exists there. */
    readonly createDirectory: (path: string) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
    /** Local branches first by recency, then remote-tracking ones without a local counterpart. */
    readonly branches: (path: string) => Effect.Effect<readonly GitBranch[], WorkspaceError>;
    /**
     * Create a linked worktree of the repository at `path` on a new branch
     * `branch` (made unique with a numeric suffix if taken), started from `base`
     * (default HEAD). With `fromRemote`, it starts from `base`'s version on its
     * remote instead (its upstream, else `origin`'s branch of the name), fetched
     * first, and does not track it, so the new branch pushes as itself. Worktrees
     * live under the host's worktree directory, one folder per repository.
     * Returns the new worktree's status.
     */
    readonly createWorktree: (
      path: string,
      options: { readonly branch: string; readonly base?: string; readonly fromRemote?: boolean },
    ) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
    /** The linked worktrees of the repository at `path` (or of one of its worktrees), not its main work tree. */
    readonly worktrees: (path: string) => Effect.Effect<readonly Worktree[], WorkspaceError>;
    /**
     * Removes the linked worktree at `path`, or holding it: its whole folder goes, and its branch and commits stay.
     * Refuses one with uncommitted changes or untracked files (`Failed`, git's reason) unless `force`, and a folder that
     * is not in a linked worktree (`NotRepository`).
     */
    readonly removeWorktree: (path: string, options?: { readonly force?: boolean }) => Effect.Effect<void, WorkspaceError>;
    /**
     * Makes again the worktree this host made or removed at `path`, or holding it, where it was on its branch, and
     * returns the status of `path`. Fails `NotFound` for one it has no record of, `Exists` while something is where it
     * was, and `Failed` once its branch is gone.
     */
    readonly restoreWorktree: (path: string) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
    /** Switch to `branch`, creating it from HEAD when `create` is set. Returns the new status. */
    readonly checkout: (path: string, branch: string, options?: { readonly create?: boolean }) => Effect.Effect<WorkspaceStatus, WorkspaceError>;
  }
>()("lemma/Workspace") {}

const AtPath = Schema.Struct({ path: Schema.String });

/**
 * What clients call on `Workspace`, a channel per operation, served by its
 * provider (`serveWorkspace`). A refused call fails with its `WorkspaceError`'s
 * reason as the code (`NotRepository`, `Exists`) and the expanded path as the
 * subject.
 */
export const WorkspaceChannels = {
  status: defineChannel({
    kind: "call",
    id: "workspace.status",
    access: "read",
    title: "Workspace status",
    description: "Whether a directory exists, and its git state when it is in a work tree; never fails",
    payload: AtPath,
    success: WorkspaceStatus,
    repeatable: true,
  }),
  places: defineChannel({
    kind: "call",
    id: "workspace.places",
    access: "read",
    title: "Places",
    description:
      "For each directory, the project it belongs to (a linked worktree's is its repository's main work tree), whether it is a worktree, and its branch; never fails",
    payload: Schema.Struct({ paths: Schema.Array(Schema.String) }),
    success: Schema.Array(Place),
    repeatable: true,
  }),
  browse: defineChannel({
    kind: "call",
    id: "workspace.browse",
    access: "read",
    title: "Browse directories",
    description: "The directories a partly typed path completes to (`~/code/ba`), best match first; never fails",
    payload: Schema.Struct({ partialPath: Schema.String }),
    success: DirectoryListing,
    repeatable: true,
  }),
  createDirectory: defineChannel({
    kind: "call",
    id: "workspace.create-directory",
    access: "operate",
    title: "Create directory",
    description: "Creates a directory and its missing parents, and gives its status; fails Exists when something is there already",
    payload: AtPath,
    success: WorkspaceStatus,
  }),
  createWorktree: defineChannel({
    kind: "call",
    id: "workspace.create-worktree",
    access: "operate",
    title: "Create worktree",
    description:
      "Creates a linked worktree of the repository at `path` on a new branch started from `base` (default HEAD), or from its remote version, fetched first (`fromRemote`), and gives its status",
    payload: Schema.Struct({ path: Schema.String, branch: Schema.String, base: Schema.optional(Schema.String), fromRemote: Schema.optional(Schema.Boolean) }),
    success: WorkspaceStatus,
  }),
  worktrees: defineChannel({
    kind: "call",
    id: "workspace.worktrees",
    access: "read",
    title: "Worktrees",
    description: "The linked worktrees of the repository at `path`, not its main work tree",
    payload: AtPath,
    success: Schema.Array(Worktree),
    repeatable: true,
  }),
  removeWorktree: defineChannel({
    kind: "call",
    id: "workspace.remove-worktree",
    access: "operate",
    title: "Remove worktree",
    description:
      "Removes the linked worktree at `path`, keeping its branch and commits; refuses one with uncommitted changes or untracked files unless `force`",
    payload: Schema.Struct({ path: Schema.String, force: Schema.optional(Schema.Boolean) }),
    success: Schema.Void,
  }),
  restoreWorktree: defineChannel({
    kind: "call",
    id: "workspace.restore-worktree",
    access: "operate",
    title: "Restore worktree",
    description: "Makes again a worktree this host made or removed, at its path on its branch, and gives its status",
    payload: AtPath,
    success: WorkspaceStatus,
  }),
  branches: defineChannel({
    kind: "call",
    id: "workspace.branches",
    access: "read",
    title: "Branches",
    description: "Local branches by recency, then remote-tracking ones without a local counterpart",
    payload: AtPath,
    success: Schema.Array(GitBranch),
    repeatable: true,
  }),
  checkout: defineChannel({
    kind: "call",
    id: "workspace.checkout",
    access: "operate",
    title: "Switch branch",
    description: "Switches to `branch` as `git switch` would, creating it from HEAD with `create`, and gives the new status",
    payload: Schema.Struct({ path: Schema.String, branch: Schema.String, create: Schema.optional(Schema.Boolean) }),
    success: WorkspaceStatus,
  }),
};

/** `WorkspaceChannels` served by `workspace`: what a provider of `Workspace` adds to `Channels`. */
export const serveWorkspace = (workspace: Context.Service.Shape<typeof Workspace>): readonly Channel[] => [
  serveChannel(WorkspaceChannels.status, ({ path }) => workspace.status(path)),
  serveChannel(WorkspaceChannels.places, ({ paths }) => workspace.places(paths)),
  serveChannel(WorkspaceChannels.browse, ({ partialPath }) => workspace.browse(partialPath)),
  serveChannel(WorkspaceChannels.createDirectory, ({ path }) => workspace.createDirectory(path)),
  serveChannel(WorkspaceChannels.createWorktree, ({ path, branch, base, fromRemote }) =>
    workspace.createWorktree(path, { branch, ...(base === undefined ? {} : { base }), ...(fromRemote === undefined ? {} : { fromRemote }) }),
  ),
  serveChannel(WorkspaceChannels.worktrees, ({ path }) => workspace.worktrees(path)),
  serveChannel(WorkspaceChannels.removeWorktree, ({ path, force }) => workspace.removeWorktree(path, force === undefined ? undefined : { force })),
  serveChannel(WorkspaceChannels.restoreWorktree, ({ path }) => workspace.restoreWorktree(path)),
  serveChannel(WorkspaceChannels.branches, ({ path }) => workspace.branches(path)),
  serveChannel(WorkspaceChannels.checkout, ({ path, branch, create }) => workspace.checkout(path, branch, create === undefined ? undefined : { create })),
];
