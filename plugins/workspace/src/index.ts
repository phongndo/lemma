import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { Paths, Workspace, WorkspaceError } from "@lemma/contracts";
import type { DirectoryEntry, DirectoryListing, GitBranch, GitStatus, WorkspaceStatus } from "@lemma/contracts";

export const READ_TIMEOUT_MS = 5_000;
export const CHECKOUT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** `~` and `~/…` against `home`; anything still relative afterwards is returned as is and treated as missing. */
export const expandPath = (path: string, home: string = homedir()): string => {
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : expanded;
};

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
export const BROWSE_LIMIT = 200;

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/**
 * Parses `git status --porcelain=v2 --branch -z`. Every record is
 * NUL-terminated; a rename or copy (`2`) is followed by one extra record, its
 * original path, which is not a separate change.
 */
export const parseStatus = (output: string) => {
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
export const parseBranches = (output: string): GitBranch[] => {
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

export interface WorkspaceOptions {
  /** What `~` expands to. Defaults to the OS home directory. */
  readonly home?: string;
  /** Where `createWorktree` puts worktrees, one folder per repository. */
  readonly worktrees: string;
}

/** The work tree owning a common git dir: `/repo/.git` → `/repo`; a bare repository has none. */
const mainWorkTree = (commonDir: string): string | undefined => (basename(commonDir) === ".git" ? dirname(commonDir) : undefined);

/** A branch name as a single path segment: `feat/x` → `feat-x`. */
const folderName = (branch: string) => branch.replace(/[/\\]+/g, "-");

export const makeWorkspace = (options: WorkspaceOptions): Context.Tag.Service<Workspace> => {
  const home = options.home ?? homedir();
  const { worktrees } = options;

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
      const dir = expandPath(path, home);
      if (!isAbsolute(dir) || !(await isDirectory(dir))) return { path: dir, exists: false };
      const state = await gitStatus(dir);
      return { path: dir, exists: true, ...(state === undefined ? {} : { git: state }) };
    });

  const browse = (partialPath: string): Effect.Effect<DirectoryListing> =>
    Effect.promise(async () => {
      const typed = partialPath.trim() === "" ? "~/" : partialPath.trim();
      const expanded = expandPath(typed, home);
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
          git: await stat(join(path, ".git")).then(
            () => true,
            () => false,
          ),
          matches: match.matches,
        });
      }
      return { parent, entries, truncated: matches.length > BROWSE_LIMIT };
    });

  const createDirectory = (path: string): Effect.Effect<WorkspaceStatus, WorkspaceError> =>
    Effect.gen(function* () {
      const dir = expandPath(path, home);
      if (!isAbsolute(dir)) return yield* new WorkspaceError({ path: dir, reason: "NotFound", message: `"${path}" is not an absolute path` });
      if (
        yield* Effect.promise(() =>
          stat(dir).then(
            () => true,
            () => false,
          ),
        )
      ) {
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
      const dir = expandPath(path, home);
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

  const createWorktree = (path: string, options: { readonly branch: string; readonly base?: string }) =>
    Effect.gen(function* () {
      const dir = yield* repository(path);
      yield* validBranch(dir, options.branch);
      const common = (yield* run(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      const repoName = basename(mainWorkTree(common) ?? common.replace(/\.git$/, ""));
      // Take the first free name: `x`, then `x-2`, `x-3`, … for both the branch and its folder.
      let branch = options.branch;
      let target = join(worktrees, repoName, folderName(branch));
      for (
        let n = 2;
        (yield* exists(dir, `refs/heads/${branch}`)) ||
        (yield* Effect.promise(() =>
          stat(target).then(
            () => true,
            () => false,
          ),
        ));
        n++
      ) {
        branch = `${options.branch}-${n}`;
        target = join(worktrees, repoName, folderName(branch));
      }
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(target), { recursive: true }),
        catch: (cause) => new WorkspaceError({ path: target, reason: "Failed", message: cause instanceof Error ? cause.message : String(cause), cause }),
      });
      yield* run(dir, ["worktree", "add", "-b", branch, "--", target, options.base ?? "HEAD"], CHECKOUT_TIMEOUT_MS);
      return yield* status(target);
    });

  return { status, browse, createDirectory, createWorktree, branches, checkout };
};

export const WorkspaceConfig = Schema.Struct({
  worktrees: Schema.optional(Schema.String).annotations({
    description: "Where new worktrees go; defaults to worktrees in the host's home (~/.lemma/worktrees).",
  }),
});

export default definePlugin({
  id: "workspace",
  version: "0.1.0",
  config: WorkspaceConfig,
  provides: [Workspace],
  requires: [Paths],
  layer: (config) =>
    Layer.effect(
      Workspace,
      Effect.map(Paths, (paths) => makeWorkspace({ worktrees: config.worktrees ?? join(paths.home, "worktrees") })),
    ),
});
