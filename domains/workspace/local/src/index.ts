import { execFile } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import type { Context } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import { Channels, Paths } from "@lemma/contracts";
import { serveFiles, serveWorkspace, Workspace, WORKSPACE_CONTRACT, WorkspaceError } from "@lemma/workspace";
import type { DirectoryEntry, DirectoryListing, GitBranch, GitStatus, Place, Worktree, WorkspaceStatus } from "@lemma/workspace";
import { expandHome, isInside, kindOf, readJsonFile, writeFileAtomic } from "@lemma/contracts/fs";

const READ_TIMEOUT_MS = 5_000;
const CHECKOUT_TIMEOUT_MS = 15_000;
/** A fetch of one branch from its remote, which a slow network may take a while over. */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;
/** How many directories `places` asks git about at once. */
const PLACES_AT_ONCE = 8;

type GitResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly message: string };

/**
 * Never prompts, never takes optional locks (so reads leave the index alone),
 * and speaks C-locale English. Repository-selecting variables are dropped so
 * an inherited `GIT_DIR` cannot redirect the call away from `cwd`.
 */
const gitEnv = (): NodeJS.ProcessEnv => {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, GIT_COMMON_DIR: _common, ...env } = process.env;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
};

/** Runs git without a shell. Failure carries git's stderr, or the spawn/timeout error when git said nothing. */
const git = (cwd: string, args: readonly string[], timeout = READ_TIMEOUT_MS): Promise<GitResult> =>
  new Promise((done) => {
    execFile("git", args, { cwd, env: gitEnv(), timeout, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return done({ ok: true, stdout });
      const said = stderr.trim();
      done({ ok: false, message: said !== "" ? said : error.killed ? `git ${args[0]} timed out after ${timeout}ms` : error.message });
    });
  });

/**
 * Scores `name` against `needle` (both lower case): prefix beats substring
 * beats letters in order; undefined when the letters are not all there.
 */
export const matchName = (name: string, needle: string): { readonly score: number; readonly matches: number[] } | undefined => {
  if (needle === "") return { score: 0, matches: [] };
  const range = (start: number) => Array.from({ length: needle.length }, (_, i) => start + i);
  if (name.startsWith(needle)) return { score: 3, matches: range(0) };
  const at = name.indexOf(needle);
  if (at !== -1) return { score: 2, matches: range(at) };
  const matches: number[] = [];
  let from = 0;
  for (const char of needle) {
    const found = name.indexOf(char, from);
    if (found === -1) return undefined;
    matches.push(found);
    from = found + 1;
  }
  // Among scattered matches, fewer gaps and an earlier start rank higher (score stays below 1).
  const gaps = matches.at(-1)! - matches[0]! - (needle.length - 1);
  return { score: 0.5 / (1 + gaps) + 0.5 / (1 + matches[0]!), matches };
};

/** Entries returned by `browse`; more are reported as `truncated`. */
const BROWSE_LIMIT = 200;

const isDirectory = async (path: string): Promise<boolean> => (await kindOf(path)) === "directory";

/**
 * Parses `git status --porcelain=v2 --branch -z`. Every record is
 * NUL-terminated; a rename or copy (`2`) is followed by one extra record, its
 * original path, which is not a separate change.
 */
const parseStatus = (output: string) => {
  let oid: string | undefined;
  let branch: string | null = null;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      oid = value === "(initial)" ? undefined : value;
    } else if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
    } else if (record.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(record.slice("# branch.ab ".length));
      if (match !== null) [ahead, behind] = [Number(match[1]), Number(match[2])];
    } else if (record.startsWith("1 ") || record.startsWith("u ") || record.startsWith("? ")) {
      changes++;
    } else if (record.startsWith("2 ")) {
      changes++;
      i++;
    }
  }
  return { oid, branch, upstream, ahead, behind, changes };
};

const REF_FORMAT = "%(refname)%00%(committerdate:unix)%00%(HEAD)%00%(symref)%00%(worktreepath)";

/** Parses `git for-each-ref --sort=-committerdate --format=REF_FORMAT refs/heads refs/remotes`, keeping that order within each group. */
const parseBranches = (output: string): GitBranch[] => {
  const local: GitBranch[] = [];
  const remote: GitBranch[] = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [ref = "", date = "0", head = "", symref = "", worktree = ""] = line.split("\0");
    // `origin/HEAD` names the remote's default branch; it is not a branch itself.
    if (symref !== "" || ref.endsWith("/HEAD")) continue;
    const updatedAt = Number(date) * 1000;
    if (ref.startsWith("refs/heads/")) {
      const current = head === "*";
      // The current branch lives in this worktree; others checked out elsewhere report where.
      local.push({ name: ref.slice("refs/heads/".length), current, remote: false, updatedAt, ...(current || worktree === "" ? {} : { worktree }) });
    } else if (ref.startsWith("refs/remotes/")) remote.push({ name: ref.slice("refs/remotes/".length), current: false, remote: true, updatedAt });
  }
  const names = new Set(local.map((branch) => branch.name));
  return [...local, ...remote.filter((branch) => !names.has(branch.name.slice(branch.name.indexOf("/") + 1)))];
};

interface WorkspaceOptions {
  /** What `~` expands to. Defaults to the OS home directory. */
  readonly home?: string;
  /** Where `createWorktree` puts worktrees, one folder per repository. */
  readonly worktrees: string;
  /** The file recording the worktrees made or removed here (`Made`); none are recorded without one. */
  readonly record?: string;
}

/**
 * A worktree made or removed here, by its path: its repository's main work tree and its branch. Kept after the worktree
 * is removed, so its threads stay filed under its project and it can be made again.
 */
const Made = Schema.Record(Schema.String, Schema.Struct({ project: Schema.String, branch: Schema.String }));
type Made = typeof Made.Type;

/**
 * Parses `git worktree list --porcelain`: one record per worktree, the main one first, each field ended by `separator`
 * and each record by one more: NUL with `-z`, else a newline.
 */
export const parseWorktrees = (output: string, separator = "\0"): Worktree[] => {
  const trees: Worktree[] = [];
  let current: { path?: string; branch: string | null; missing: boolean } = { branch: null, missing: false };
  const end = () => {
    if (current.path !== undefined) trees.push({ path: current.path, branch: current.branch, ...(current.missing ? { missing: true } : {}) });
    current = { branch: null, missing: false };
  };
  for (const field of output.split(separator)) {
    if (field === "") end();
    else if (field.startsWith("worktree ")) current.path = field.slice("worktree ".length);
    else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (field === "prunable" || field.startsWith("prunable ")) current.missing = true;
  }
  end();
  return trees;
};

/** The work tree owning a common git dir: `/repo/.git` → `/repo`; a bare repository has none. */
const mainWorkTree = (commonDir: string): string | undefined => (basename(commonDir) === ".git" ? dirname(commonDir) : undefined);

/** A path that may not exist with its symlinks resolved, as git names paths: its nearest existing ancestor's real path, and the rest. */
const realOf = async (path: string): Promise<string> => {
  const rest: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    const real = await realpath(at).catch(() => undefined);
    if (real !== undefined) return join(real, ...rest.reverse());
    if (dirname(at) === at) return path;
    rest.push(basename(at));
  }
};

/**
 * The recorded worktree holding `path` (its root, or a folder in it, by the path as given or as git names it): where it
 * was, and the project and branch the path had in it.
 */
const recordedAt = async (known: Made, path: string): Promise<{ readonly root: string; readonly project: string; readonly branch: string } | undefined> => {
  for (const candidate of new Set([path, await realOf(path)])) {
    for (const [root, entry] of Object.entries(known)) {
      if (candidate === root) return { root, ...entry };
      if (candidate.startsWith(`${root}${sep}`)) return { root, project: join(entry.project, candidate.slice(root.length + 1)), branch: entry.branch };
    }
  }
  return undefined;
};

/** A branch name as a single path segment: `feat/x` → `feat-x`. */
const folderName = (branch: string) => branch.replace(/[/\\]+/g, "-");

export const makeWorkspace = (options: WorkspaceOptions): Context.Service.Shape<typeof Workspace> => {
  const home = options.home ?? homedir();
  const { worktrees, record } = options;

  const made = async (): Promise<Made> => (record === undefined ? {} : ((await readJsonFile(record, Made)) ?? {}));
  // One write at a time, each reading what is there first.
  let recording: Promise<unknown> = Promise.resolve();
  /** Records a worktree made or removed here. A failure loses only the record, not the work. */
  const remember = (path: string, entry: Made[string]): Promise<void> =>
    (recording = recording
      .then(async () => {
        if (record !== undefined) await writeFileAtomic(record, `${JSON.stringify({ ...(await made()), [path]: entry }, null, 2)}\n`);
      })
      .catch(() => {})) as Promise<void>;

  const gitStatus = async (dir: string): Promise<GitStatus | undefined> => {
    const [root, status, short, common] = await Promise.all([
      git(dir, ["rev-parse", "--show-toplevel"]),
      git(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]),
      git(dir, ["rev-parse", "--short", "HEAD"]),
      git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    if (!root.ok || !status.ok) return undefined;
    const parsed = parseStatus(status.stdout);
    const head = parsed.oid === undefined ? undefined : short.ok ? short.stdout.trim() : parsed.oid.slice(0, 12);
    // A linked worktree's common git dir belongs to the main work tree.
    const mainRoot = common.ok ? mainWorkTree(common.stdout.trim()) : undefined;
    const worktreeOf = mainRoot !== undefined && mainRoot !== root.stdout.trim() ? mainRoot : undefined;
    return {
      root: root.stdout.trim(),
      branch: parsed.branch,
      ...(worktreeOf === undefined ? {} : { worktreeOf }),
      ...(head === undefined ? {} : { head }),
      changes: parsed.changes,
      ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
      ahead: parsed.ahead,
      behind: parsed.behind,
    };
  };

  const status = (path: string): Effect.Effect<WorkspaceStatus> =>
    Effect.promise(async () => {
      const dir = expandHome(path, home);
      if (!isAbsolute(dir) || !(await isDirectory(dir))) return { path: dir, exists: false };
      const state = await gitStatus(dir);
      return { path: dir, exists: true, ...(state === undefined ? {} : { git: state }) };
    });

  /**
   * Where one directory sits: a `git rev-parse` and a `git branch --show-current` (which, unlike the HEAD file, also
   * reads a reftable repository's), rather than `status`'s full `git status`. A folder in a work tree is filed as git
   * names it, symlinks resolved, so a repository reached by two paths, and each of its worktrees, are one project.
   */
  const place = async (path: string, known: Made, ours: string): Promise<Place> => {
    const dir = expandHome(path, home);
    if (!isAbsolute(dir) || !(await isDirectory(dir))) {
      const gone = await recordedAt(known, dir);
      return gone === undefined
        ? { path: dir, exists: false, project: dir, worktree: false }
        : { path: dir, exists: false, project: gone.project, worktree: true, branch: gone.branch, ...(isInside(ours, gone.root) ? { made: true } : {}) };
    }
    const [found, current] = await Promise.all([
      git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--show-prefix"]),
      git(dir, ["branch", "--show-current"]),
    ]);
    if (!found.ok) return { path: dir, exists: true, project: dir, worktree: false };
    const [root = "", common = "", prefix = ""] = found.stdout.split("\n");
    // A bare repository's worktrees have no main work tree to belong to: each is its own.
    const main = mainWorkTree(common) ?? root;
    const inside = prefix.replace(/\/+$/, "");
    const branch = current.ok ? current.stdout.trim() || null : undefined;
    return {
      path: dir,
      exists: true,
      project: inside === "" ? main : join(main, inside),
      worktree: main !== root,
      ...(branch === undefined ? {} : { branch }),
      ...(main !== root && isInside(ours, root) ? { made: true } : {}),
    };
  };

  const places = (paths: readonly string[]): Effect.Effect<readonly Place[]> =>
    Effect.flatMap(
      Effect.promise(() => Promise.all([made(), realOf(worktrees)])),
      ([known, ours]) => Effect.forEach(paths, (path) => Effect.promise(() => place(path, known, ours)), { concurrency: PLACES_AT_ONCE }),
    );

  const browse = (partialPath: string): Effect.Effect<DirectoryListing> =>
    Effect.promise(async () => {
      const typed = partialPath.trim() === "" ? "~/" : partialPath.trim();
      const expanded = expandHome(typed, home);
      // `~/code/` lists `~/code`; `~/code/ba` lists `~/code` filtered by `ba`.
      const endsWithSlash = typed.endsWith("/") || typed === "~";
      const parent = endsWithSlash ? resolve(expanded) : dirname(resolve(expanded));
      const needle = endsWithSlash ? "" : basename(expanded).toLowerCase();
      if (!isAbsolute(expanded)) return { parent, entries: [], truncated: false };
      const dirents = await readdir(parent, { withFileTypes: true }).catch(() => []);
      const matches = dirents
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .filter((entry) => (entry.name.startsWith(".") ? needle.startsWith(".") : true))
        .flatMap((entry) => {
          const match = matchName(entry.name.toLowerCase(), needle);
          return match === undefined ? [] : [{ name: entry.name, ...match }];
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      const entries: DirectoryEntry[] = [];
      for (const match of matches.slice(0, BROWSE_LIMIT)) {
        const path = join(parent, match.name);
        // Symlinks count only when they point at a directory.
        if (!(await isDirectory(path))) continue;
        entries.push({
          name: match.name,
          path,
          git: (await kindOf(join(path, ".git"))) !== undefined,
          matches: match.matches,
        });
      }
      return { parent, entries, truncated: matches.length > BROWSE_LIMIT };
    });

  const createDirectory = (path: string): Effect.Effect<WorkspaceStatus, WorkspaceError> =>
    Effect.gen(function* () {
      const dir = expandHome(path, home);
      if (!isAbsolute(dir)) return yield* new WorkspaceError({ path: dir, reason: "NotFound", message: `"${path}" is not an absolute path` });
      if ((yield* Effect.promise(() => kindOf(dir))) !== undefined) {
        return yield* new WorkspaceError({ path: dir, reason: "Exists", message: `${dir} already exists` });
      }
      yield* Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }),
        catch: (cause) => new WorkspaceError({ path: dir, reason: "Failed", message: cause instanceof Error ? cause.message : String(cause), cause }),
      });
      return yield* status(dir);
    });

  /** The expanded path of an existing directory inside a work tree. */
  const repository = (path: string): Effect.Effect<string, WorkspaceError> =>
    Effect.gen(function* () {
      const dir = expandHome(path, home);
      if (!isAbsolute(dir) || !(yield* Effect.promise(() => isDirectory(dir)))) {
        return yield* new WorkspaceError({ path: dir, reason: "NotFound", message: `"${dir}" is not a directory` });
      }
      const root = yield* Effect.promise(() => git(dir, ["rev-parse", "--show-toplevel"]));
      if (!root.ok) return yield* new WorkspaceError({ path: dir, reason: "NotRepository", message: `"${dir}" is not in a git work tree` });
      return dir;
    });

  const run = (dir: string, args: readonly string[], timeout?: number): Effect.Effect<string, WorkspaceError> =>
    Effect.flatMap(
      Effect.promise(() => git(dir, args, timeout)),
      (result) => (result.ok ? Effect.succeed(result.stdout) : Effect.fail(new WorkspaceError({ path: dir, reason: "Failed", message: result.message }))),
    );

  const exists = (dir: string, ref: string) =>
    Effect.map(
      Effect.promise(() => git(dir, ["show-ref", "--verify", "--quiet", ref])),
      (result) => result.ok,
    );

  const branches = (path: string) =>
    Effect.gen(function* () {
      const dir = yield* repository(path);
      const output = yield* run(dir, ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"]);
      return parseBranches(output);
    });

  const checkout = (path: string, branch: string, options?: { readonly create?: boolean }) =>
    Effect.gen(function* () {
      const dir = yield* repository(path);
      yield* validBranch(dir, branch);
      let args: readonly string[];
      if (options?.create === true) args = ["switch", "-c", branch];
      else if (yield* exists(dir, `refs/heads/${branch}`)) args = ["switch", branch];
      else if (branch.includes("/") && (yield* exists(dir, `refs/remotes/${branch}`))) {
        // A remote-tracking ref: switch to its local counterpart, creating it with tracking when missing.
        const local = branch.slice(branch.indexOf("/") + 1);
        args = (yield* exists(dir, `refs/heads/${local}`)) ? ["switch", local] : ["switch", "-c", local, "--track", branch];
      } else args = ["switch", branch];
      yield* run(dir, args, CHECKOUT_TIMEOUT_MS);
      return yield* status(dir);
    });

  const validBranch = (dir: string, branch: string) =>
    Effect.gen(function* () {
      // `--branch` also expands `@{-1}`; only a name that is already literal is accepted, and never one git would read as an option.
      const valid = branch.startsWith("-") ? undefined : yield* Effect.promise(() => git(dir, ["check-ref-format", "--branch", branch]));
      if (valid === undefined || !valid.ok || valid.stdout.trim() !== branch) {
        return yield* new WorkspaceError({ path: dir, reason: "InvalidName", message: `"${branch}" is not a valid branch name` });
      }
    });

  /**
   * The remote ref a worktree starts from when it starts from the remote (`fromRemote`), fetched first: `base`'s
   * upstream, else `origin`'s branch of its name; a base that is a remote branch already is itself.
   */
  const remoteBase = (dir: string, base: string | undefined) =>
    Effect.gen(function* () {
      const local = base ?? (yield* run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const remotes = (yield* run(dir, ["remote"]))
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      const upstream = local.startsWith("-")
        ? undefined
        : yield* Effect.promise(() => git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${local}@{upstream}`]));
      const slash = local.indexOf("/");
      const ref =
        upstream?.ok === true && upstream.stdout.trim() !== ""
          ? upstream.stdout.trim()
          : slash > 0 && remotes.includes(local.slice(0, slash))
            ? local
            : remotes.includes("origin") && local !== "HEAD" && !local.startsWith("-")
              ? `origin/${local}`
              : undefined;
      const remote = ref === undefined ? undefined : remotes.find((name) => ref.startsWith(`${name}/`));
      if (ref === undefined || remote === undefined) {
        return yield* new WorkspaceError({
          path: dir,
          reason: "Failed",
          message: `${local === "HEAD" ? "A detached HEAD" : local} has no remote branch to start from`,
        });
      }
      yield* run(dir, ["fetch", remote, ref.slice(remote.length + 1)], FETCH_TIMEOUT_MS);
      return ref;
    });

  const createWorktree = (path: string, options: { readonly branch: string; readonly base?: string; readonly fromRemote?: boolean }) =>
    Effect.gen(function* () {
      const dir = yield* repository(path);
      yield* validBranch(dir, options.branch);
      const base = options.fromRemote === true ? yield* remoteBase(dir, options.base) : options.base;
      const common = (yield* run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      const repoName = basename(mainWorkTree(common) ?? common.replace(/\.git$/, ""));
      // Take the first free name: `x`, then `x-2`, `x-3`, … for both the branch and its folder.
      let branch = options.branch;
      let target = join(worktrees, repoName, folderName(branch));
      for (let n = 2; (yield* exists(dir, `refs/heads/${branch}`)) || (yield* Effect.promise(() => kindOf(target))) !== undefined; n++) {
        branch = `${options.branch}-${n}`;
        target = join(worktrees, repoName, folderName(branch));
      }
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(target), { recursive: true }),
        catch: (cause) => new WorkspaceError({ path: target, reason: "Failed", message: cause instanceof Error ? cause.message : String(cause), cause }),
      });
      // Started from a remote branch, it would track it, and push to it: it pushes as itself instead.
      yield* run(
        dir,
        ["worktree", "add", ...(options.fromRemote === true ? ["--no-track"] : []), "-b", branch, "--", target, base ?? "HEAD"],
        CHECKOUT_TIMEOUT_MS,
      );
      const created = yield* status(target);
      const project = created.git?.worktreeOf;
      if (project !== undefined) yield* Effect.promise(() => remember(created.git?.root ?? created.path, { project, branch }));
      return created;
    });

  const listWorktrees = (path: string) =>
    Effect.gen(function* () {
      const dir = yield* repository(path);
      // `-z`'s NUL-terminated fields read a path with a newline in it whole; git before 2.36 has only newlines.
      const nul = yield* Effect.promise(() => git(dir, ["worktree", "list", "--porcelain", "-z"]));
      const listed = nul.ok ? parseWorktrees(nul.stdout) : parseWorktrees(yield* run(dir, ["worktree", "list", "--porcelain"]), "\n");
      return listed.slice(1);
    });

  /** The linked worktree at `path` (or a folder in it): its root, where it sits, and its repository's main work tree. */
  const linked = (path: string) =>
    Effect.gen(function* () {
      const dir = expandHome(path, home);
      const [at] = yield* places([dir]);
      if (at === undefined || !at.exists) return yield* new WorkspaceError({ path: dir, reason: "NotFound", message: `"${dir}" is not a directory` });
      if (!at.worktree) return yield* new WorkspaceError({ path: dir, reason: "NotRepository", message: `"${dir}" is not a linked worktree` });
      const root = (yield* run(dir, ["rev-parse", "--show-toplevel"])).trim();
      const [tree] = yield* places([root]);
      return { root, main: tree?.project ?? at.project, branch: tree?.branch };
    });

  const removeWorktree = (path: string, options?: { readonly force?: boolean }) =>
    Effect.gen(function* () {
      const { root, main, branch } = yield* linked(path);
      // Recorded first, made here or not, so its threads stay under its project once it is gone, and it can be restored.
      if (typeof branch === "string") yield* Effect.promise(() => remember(root, { project: main, branch }));
      yield* run(main, ["worktree", "remove", ...(options?.force === true ? ["--force"] : []), "--", root], CHECKOUT_TIMEOUT_MS);
    });

  const restoreWorktree = (path: string) =>
    Effect.gen(function* () {
      const dir = expandHome(path, home);
      const known = yield* Effect.promise(made);
      const gone = yield* Effect.promise(() => recordedAt(known, dir));
      if (gone === undefined) return yield* new WorkspaceError({ path: dir, reason: "NotFound", message: `No worktree made or removed here was at "${dir}"` });
      if ((yield* Effect.promise(() => kindOf(gone.root))) !== undefined)
        return yield* new WorkspaceError({ path: dir, reason: "Exists", message: `${gone.root} already exists` });
      const main = known[gone.root]!.project;
      const project = yield* repository(main);
      const branch = known[gone.root]!.branch;
      if (!(yield* exists(project, `refs/heads/${branch}`))) {
        return yield* new WorkspaceError({ path: dir, reason: "Failed", message: `Its branch ${branch} is gone` });
      }
      // git still lists a worktree whose folder was deleted by hand, and would refuse its path and branch: forget that one
      // alone, not every worktree whose folder is missing now (one on a drive not mounted, say), as a prune would.
      if ((yield* listWorktrees(project)).some((tree) => tree.path === gone.root)) yield* run(project, ["worktree", "remove", "--", gone.root]);
      yield* run(project, ["worktree", "add", "--", gone.root, branch], CHECKOUT_TIMEOUT_MS);
      return yield* status(dir);
    });

  return { status, places, browse, createDirectory, createWorktree, worktrees: listWorktrees, removeWorktree, restoreWorktree, branches, checkout };
};

const WorkspaceConfig = Schema.Struct({
  worktrees: Schema.optional(Schema.String).annotate({
    description: "Where new worktrees go; defaults to worktrees in the host's home (~/.lemma/worktrees).",
  }),
});

/**
 * Provides `Workspace` and serves it to clients, with file search: `files.search`
 * asks whichever plugin searches files at each call, so it stays served while
 * they come and go.
 */
export default definePlugin({
  id: "workspace.local",
  implements: [WORKSPACE_CONTRACT],
  version: "0.1.0",
  config: WorkspaceConfig,
  provides: { workspace: Workspace },
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const workspace = makeWorkspace({ worktrees: owner.config.worktrees ?? join(paths.home, "worktrees"), record: join(paths.home, "worktrees.json") });
    const channels = [...serveWorkspace(workspace), ...serveFiles(yield* Registries)];
    yield* Effect.forEach(channels, (channel) => owner.add(Channels, channel));
    return { workspace };
  },
});
