import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Either, Layer } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, makeCore } from "@lemma/core";
import { Paths, Workspace, WorkspaceError } from "@lemma/contracts";
import workspace, { makeWorkspace, matchName } from "../src/index.ts";

// Isolate every git call, ours and the plugin's, from the machine's config.
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-workspace-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository on `main` with local identity and, unless `empty`, one commit. */
const repo = async (name = "repo", { empty = false } = {}) => {
  const root = path.join(dir, name);
  await fs.mkdir(root);
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "user.email", "test@example.com");
  if (!empty) await commit(root, "a.txt", "one\n", "first");
  return root;
};

let clock = 1_700_000_000;
/** Commits with strictly increasing dates so recency ordering is deterministic. */
const commit = async (root: string, file: string, content: string, message: string) => {
  await fs.writeFile(path.join(root, file), content);
  sh(root, "add", file);
  const date = `@${clock++} +0000`;
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: "ignore",
  });
};

const ws = makeWorkspace({ home: "/nonexistent-home", worktrees: "/nonexistent-home/worktrees" });
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = async <A>(effect: Effect.Effect<A, WorkspaceError>): Promise<WorkspaceError> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) throw new Error("expected a WorkspaceError");
  return result.left;
};

describe("status", () => {
  it("expands ~ and treats relative paths as missing", async () => {
    expect(await run(ws.status("relative/dir"))).toEqual({ path: "relative/dir", exists: false });
    expect(await run(makeWorkspace({ home: dir, worktrees: path.join(dir, "trees") }).status("~"))).toEqual({ path: dir, exists: true });
  });

  it("reports a missing path, a file, and a plain directory", async () => {
    await fs.writeFile(path.join(dir, "file"), "x");
    expect(await run(ws.status(path.join(dir, "missing")))).toEqual({ path: path.join(dir, "missing"), exists: false });
    expect(await run(ws.status(path.join(dir, "file")))).toEqual({ path: path.join(dir, "file"), exists: false });
    expect(await run(ws.status(dir))).toEqual({ path: dir, exists: true });
  });

  it("knows the branch of a repository with no commits", async () => {
    const root = await repo("empty", { empty: true });
    await fs.writeFile(path.join(root, "new.txt"), "x");
    expect(await run(ws.status(root))).toEqual({
      path: root,
      exists: true,
      git: { root, branch: "main", changes: 1, ahead: 0, behind: 0 },
    });
  });

  it("reports a clean repository from a subdirectory, then counts changes without touching the index", async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, "sub"));
    const clean = await run(ws.status(path.join(root, "sub")));
    expect(clean.git).toEqual({ root, branch: "main", head: sh(root, "rev-parse", "--short", "HEAD"), changes: 0, ahead: 0, behind: 0 });
    expect(clean.git?.head).toMatch(/^[0-9a-f]{7,12}$/);

    await fs.writeFile(path.join(root, "a.txt"), "changed\n");
    await fs.writeFile(path.join(root, "b.txt"), "staged\n");
    sh(root, "add", "b.txt");
    await fs.writeFile(path.join(root, "c.txt"), "untracked\n");
    sh(root, "mv", "a.txt", "renamed.txt");
    const indexBefore = await fs.stat(path.join(root, ".git", "index"));
    // renamed.txt (a rename record plus its original path), b.txt, c.txt.
    expect((await run(ws.status(root))).git?.changes).toBe(3);
    expect((await fs.stat(path.join(root, ".git", "index"))).mtimeMs).toBe(indexBefore.mtimeMs);
  });

  it("reports a detached HEAD as a null branch", async () => {
    const root = await repo();
    sh(root, "switch", "-q", "--detach", "HEAD");
    const state = await run(ws.status(root));
    expect(state.git).toMatchObject({ branch: null, head: sh(root, "rev-parse", "--short", "HEAD") });
  });

  it("counts commits ahead of and behind the upstream", async () => {
    const origin = path.join(dir, "origin.git");
    const root = await repo();
    sh(dir, "clone", "-q", "--bare", root, origin);
    sh(root, "remote", "add", "origin", origin);
    sh(root, "fetch", "-q", "origin");
    sh(root, "branch", "-q", "--set-upstream-to=origin/main");
    // One commit only upstream (pushed from a second clone), two only local.
    const other = path.join(dir, "other");
    sh(dir, "clone", "-q", origin, other);
    sh(other, "config", "user.name", "Test");
    sh(other, "config", "user.email", "test@example.com");
    await commit(other, "theirs.txt", "x", "theirs");
    sh(other, "push", "-q", "origin", "main");
    await commit(root, "b.txt", "x", "second");
    await commit(root, "c.txt", "x", "third");
    sh(root, "fetch", "-q", "origin");
    expect((await run(ws.status(root))).git).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, changes: 0 });
  });
});

/** A repo with local branches main, old, new and a remote with main, new, remote-only, and HEAD. */
const withRemote = async () => {
  const upstream = await repo("upstream");
  sh(upstream, "switch", "-q", "-c", "remote-only");
  await commit(upstream, "r.txt", "x", "remote only");
  sh(upstream, "switch", "-q", "-c", "new");
  await commit(upstream, "n.txt", "x", "new upstream");
  sh(upstream, "switch", "-q", "main");
  const root = path.join(dir, "clone");
  sh(dir, "clone", "-q", upstream, root);
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "user.email", "test@example.com");
  sh(root, "switch", "-q", "-c", "old");
  await commit(root, "o.txt", "x", "old");
  sh(root, "switch", "-q", "new");
  await commit(root, "n2.txt", "x", "newest");
  sh(root, "switch", "-q", "main");
  return root;
};

describe("branches", () => {
  it("lists local branches by recency, then remote-tracking ones without a local branch", async () => {
    const root = await withRemote();
    const listed = await run(ws.branches(root));
    expect(listed.map((branch) => [branch.name, branch.current, branch.remote])).toEqual([
      ["new", false, false],
      ["old", false, false],
      ["main", true, false],
      ["origin/remote-only", false, true],
    ]);
    expect(listed[0]!.updatedAt).toBeGreaterThan(listed[1]!.updatedAt);
    expect(listed[0]!.updatedAt % 1000).toBe(0);
  });

  it("fails NotFound for a missing directory and NotRepository outside a work tree", async () => {
    expect(await failure(ws.branches(path.join(dir, "missing")))).toMatchObject({ reason: "NotFound" });
    expect(await failure(ws.branches(dir))).toMatchObject({ reason: "NotRepository", path: dir });
  });
});

describe("checkout", () => {
  it("switches to an existing branch and returns the new status", async () => {
    const root = await withRemote();
    expect(await run(ws.checkout(root, "old"))).toMatchObject({ path: root, git: { branch: "old", changes: 0 } });
  });

  it("creates a branch from HEAD", async () => {
    const root = await repo();
    const head = sh(root, "rev-parse", "HEAD");
    expect((await run(ws.checkout(root, "feature/x", { create: true }))).git?.branch).toBe("feature/x");
    expect(sh(root, "rev-parse", "HEAD")).toBe(head);
    expect(await failure(ws.checkout(root, "main", { create: true }))).toMatchObject({ reason: "Failed", message: expect.stringContaining("already exists") });
  });

  it("checks out a remote-tracking branch as a local branch that tracks it", async () => {
    const root = await withRemote();
    const state = await run(ws.checkout(root, "origin/remote-only"));
    expect(state.git).toMatchObject({ branch: "remote-only", upstream: "origin/remote-only", ahead: 0, behind: 0 });
  });

  it("rejects invalid names before running git switch", async () => {
    const root = await repo();
    for (const name of ["bad..name", "-f", "with space", "@{-1}", ""]) {
      expect(await failure(ws.checkout(root, name))).toMatchObject({ reason: "InvalidName" });
    }
  });

  it("refuses to overwrite a conflicting local change, with git's explanation", async () => {
    const root = await repo();
    sh(root, "switch", "-q", "-c", "other");
    await commit(root, "a.txt", "other\n", "diverge");
    sh(root, "switch", "-q", "main");
    await fs.writeFile(path.join(root, "a.txt"), "local edit\n");
    const error = await failure(ws.checkout(root, "other"));
    expect(error).toMatchObject({ reason: "Failed", path: root });
    expect(error.message).toContain("would be overwritten by checkout");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("local edit\n");
    expect(sh(root, "branch", "--show-current")).toBe("main");
  });
});

describe("plugin", () => {
  it("provides Workspace", async () => {
    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const paths = definePlugin({
            id: "paths",
            provides: [Paths],
            layer: Layer.succeed(Paths, { home: dir, userConfig: "", projectConfig: "", auth: "", sessions: "", cwd: dir }),
          });
          const core = yield* makeCore([paths, workspace]);
          return yield* core.run(Effect.flatMap(Workspace, (service) => service.status(dir)));
        }),
      ),
    );
    expect(state).toEqual({ path: dir, exists: true });
  });
});

describe("browse", () => {
  const names = (listing: { entries: readonly { name: string }[] }) => listing.entries.map((entry) => entry.name);

  it("lists child directories of a path ending in a slash, marking repositories", async () => {
    await repo("zeta");
    await fs.mkdir(path.join(dir, "alpha"));
    await fs.mkdir(path.join(dir, ".hidden"));
    await fs.writeFile(path.join(dir, "file.txt"), "not a directory");
    const listing = await run(ws.browse(`${dir}/`));
    expect(listing.parent).toBe(dir);
    expect(names(listing)).toEqual(["alpha", "zeta"]);
    expect(listing.entries.find((entry) => entry.name === "zeta")).toEqual({ name: "zeta", path: path.join(dir, "zeta"), git: true, matches: [] });
    expect(listing.truncated).toBe(false);
  });

  it("filters by the typed name, prefix matches first, hidden only when asked", async () => {
    for (const name of ["lemma", "my-lemma", "other", ".lemma-cache"]) await fs.mkdir(path.join(dir, name));
    expect(names(await run(ws.browse(`${dir}/LEM`)))).toEqual(["lemma", "my-lemma"]);
    // Letters in order match too, after prefix and substring matches.
    expect(names(await run(ws.browse(`${dir}/lma`)))).toEqual(["lemma", "my-lemma"]);
    expect((await run(ws.browse(`${dir}/lem`))).entries[0]!.matches).toEqual([0, 1, 2]);
    expect(names(await run(ws.browse(`${dir}/.le`)))).toEqual([".lemma-cache"]);
  });

  it("follows symlinks to directories, expands ~, and lists nothing for missing or relative parents", async () => {
    await fs.mkdir(path.join(dir, "real"));
    await fs.symlink(path.join(dir, "real"), path.join(dir, "link"));
    await fs.symlink(path.join(dir, "nowhere"), path.join(dir, "dangling"));
    expect(names(await run(ws.browse(`${dir}/`)))).toEqual(["link", "real"]);
    const home = makeWorkspace({ home: dir, worktrees: path.join(dir, "trees") });
    expect((await run(home.browse("~/"))).parent).toBe(dir);
    expect(names(await run(home.browse("~/re")))).toEqual(["real"]);
    expect((await run(ws.browse(`${dir}/missing/`))).entries).toEqual([]);
    expect((await run(ws.browse("relative/pa"))).entries).toEqual([]);
  });
});

describe("matchName", () => {
  it("ranks prefix over substring over scattered, tighter scattered first", () => {
    expect(matchName("lemma", "le")).toEqual({ score: 3, matches: [0, 1] });
    expect(matchName("my-lemma", "lem")).toEqual({ score: 2, matches: [3, 4, 5] });
    expect(matchName("lemma", "lma")!.matches).toEqual([0, 2, 4]);
    expect(matchName("b-s-s-long-name", "bss")!.score).toBeLessThan(matchName("bss", "bss")!.score);
    expect(matchName("lemma", "x")).toBeUndefined();
  });
});

describe("createDirectory", () => {
  it("creates missing parents, returns the new status, and refuses existing paths", async () => {
    const target = path.join(dir, "new", "project");
    const status = await run(ws.createDirectory(target));
    expect(status).toEqual({ path: target, exists: true });
    expect((await failure(ws.createDirectory(target))).reason).toBe("Exists");
    await fs.writeFile(path.join(dir, "file"), "");
    expect((await failure(ws.createDirectory(path.join(dir, "file")))).reason).toBe("Exists");
    expect((await failure(ws.createDirectory("relative/dir"))).reason).toBe("NotFound");
  });
});

describe("worktrees", () => {
  it("creates a worktree under the worktree root on a new branch from the base", async () => {
    const root = await repo();
    await commit(root, "b.txt", "two\n", "second");
    const trees = path.join(dir, "trees");
    const ws2 = makeWorkspace({ home: "/nonexistent-home", worktrees: trees });
    const status = await run(ws2.createWorktree(root, { branch: "feat/x", base: "HEAD~1" }));
    expect(status.path).toBe(path.join(trees, "repo", "feat-x"));
    expect(status.git).toMatchObject({ branch: "feat/x", worktreeOf: root, changes: 0 });
    expect(sh(status.path, "rev-parse", "HEAD")).toBe(sh(root, "rev-parse", "HEAD~1"));
    // The main work tree is not a linked worktree.
    expect((await run(ws2.status(root))).git?.worktreeOf).toBeUndefined();
  });

  it("takes a free name when the branch or folder exists, and reports branches checked out elsewhere", async () => {
    const root = await repo();
    const ws2 = makeWorkspace({ home: "/nonexistent-home", worktrees: path.join(dir, "trees") });
    const first = await run(ws2.createWorktree(root, { branch: "task" }));
    const second = await run(ws2.createWorktree(root, { branch: "task" }));
    expect(first.git?.branch).toBe("task");
    expect(second.git?.branch).toBe("task-2");
    expect(second.path).toBe(path.join(dir, "trees", "repo", "task-2"));
    const listed = await run(ws2.branches(root));
    expect(listed.find((branch) => branch.name === "task")?.worktree).toBe(first.path);
    expect(listed.find((branch) => branch.name === "main")).toMatchObject({ current: true });
    expect(listed.find((branch) => branch.name === "main")?.worktree).toBeUndefined();
  });

  it("rejects invalid names and non-repositories", async () => {
    const root = await repo();
    expect((await failure(ws.createWorktree(root, { branch: "bad..name" }))).reason).toBe("InvalidName");
    await fs.mkdir(path.join(dir, "plain"));
    expect((await failure(ws.createWorktree(path.join(dir, "plain"), { branch: "x" }))).reason).toBe("NotRepository");
  });
});
