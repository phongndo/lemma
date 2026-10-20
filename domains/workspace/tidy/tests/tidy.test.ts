import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin, Events, makeCore } from "@lemma/core";
import { Agent, TurnEnded, TurnStarted } from "@lemma/agent";
import { Sessions } from "@lemma/sessions";
import type { SessionInfo } from "@lemma/sessions";
import { Workspace } from "@lemma/workspace";
import { pathsPlugin } from "@lemma/contracts/testing";
import sessionsFiles from "@lemma/sessions-files";
import workspaceLocal, { makeWorkspace } from "@lemma/workspace-local";
import tidy, { makeTidy } from "../src/index.ts";

// Isolate every git call, ours and the plugins', from the machine's config.
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-tidy-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository on `main` with one commit. */
const repo = async () => {
  const root = path.join(dir, "repo");
  await fs.mkdir(root);
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "user.email", "test@example.com");
  await fs.writeFile(path.join(root, "a.txt"), "one\n");
  sh(root, "add", "a.txt");
  sh(root, "commit", "-q", "-m", "first");
  return root;
};

const exists = (where: string) =>
  fs.stat(where).then(
    () => true,
    () => false,
  );

const thread = (id: string, cwd: string, archived = false): SessionInfo => ({
  id,
  cwd,
  createdAt: 0,
  updatedAt: 0,
  lastSeq: 1,
  ...(archived ? { archived } : {}),
});

describe("makeTidy", () => {
  const setup = async (threads: () => readonly SessionInfo[], running: () => readonly string[] = () => []) => {
    const root = await repo();
    const workspace = makeWorkspace({ home: dir, worktrees: path.join(dir, "trees"), record: path.join(dir, "worktrees.json") });
    const tree = await Effect.runPromise(workspace.createWorktree(root, { branch: "task" }));
    const sessions = { list: () => Effect.sync(threads) } as unknown as Context.Service.Shape<typeof Sessions>;
    const agent = { running: Effect.sync(running) } as unknown as Context.Service.Shape<typeof Agent>;
    return { root, tree: tree.path, workspace, ...makeTidy({ workspace, sessions, agent }) };
  };

  it("removes a worktree it made once every thread in it is archived, keeping its branch, and makes it again", async () => {
    let threads: readonly SessionInfo[] = [];
    const { root, tree, tidy, restore } = await setup(() => threads);
    threads = [thread("a", tree, true), thread("b", path.join(tree, "sub"), true), thread("c", root)];
    expect(await Effect.runPromise(tidy(tree))).toBe(`removed ${tree}`);
    expect(await exists(tree)).toBe(false);
    expect(sh(root, "branch", "--list", "task")).toContain("task");
    expect(await Effect.runPromise(restore(tree))).toBe(`restored ${tree}`);
    expect(await exists(tree)).toBe(true);
    expect(await Effect.runPromise(restore(tree))).toBe("nothing to restore");
  });

  it("keeps it while a thread in it is open, a turn runs in it, or it holds uncommitted work", async () => {
    let threads: readonly SessionInfo[] = [];
    let running: readonly string[] = [];
    const { tree, tidy } = await setup(
      () => threads,
      () => running,
    );
    threads = [thread("a", tree, true), thread("b", tree)];
    expect(await Effect.runPromise(tidy(tree))).toBe(`kept ${tree}: a thread in it is open`);
    threads = [thread("a", tree, true)];
    running = ["a"];
    expect(await Effect.runPromise(tidy(tree))).toBe(`kept ${tree}: a turn runs in it`);
    running = [];
    await fs.writeFile(path.join(tree, "new.txt"), "untracked\n");
    expect(await Effect.runPromise(tidy(tree))).toBe(`kept ${tree}: it has uncommitted changes`);
    expect(await exists(tree)).toBe(true);
  });

  it("leaves worktrees it did not make, and folders that are not worktrees", async () => {
    let threads: readonly SessionInfo[] = [];
    const { root, tidy } = await setup(() => threads);
    const elsewhere = path.join(dir, "elsewhere");
    sh(root, "worktree", "add", "-q", "-b", "other", elsewhere);
    threads = [thread("a", elsewhere, true), thread("b", root, true)];
    expect(await Effect.runPromise(tidy(elsewhere))).toBe("not a worktree of ours");
    expect(await Effect.runPromise(tidy(root))).toBe("not a worktree of ours");
    expect(await exists(elsewhere)).toBe(true);
  });
});

describe("the plugin", () => {
  it("removes a worktree when its last thread is archived or deleted, after a turn there ends, and restores it when one is unarchived", async () => {
    const root = await repo();
    const home = path.join(dir, "home");
    await fs.mkdir(home);
    let running: readonly string[] = [];
    const agent = definePlugin({ id: "agent", provides: [Agent], layer: Layer.succeed(Agent, { running: Effect.sync(() => running) } as never) });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(home), sessionsFiles, workspaceLocal, agent, tidy], {
            configs: { "workspace.local": { worktrees: path.join(dir, "trees") } },
          });
          const workspace = yield* core.run(Workspace);
          const sessions = yield* core.run(Sessions);
          const until = (what: string, done: () => Promise<boolean>) =>
            Effect.promise(() =>
              vi.waitFor(
                async () => {
                  if (!(await done())) throw new Error(`waiting until ${what}`);
                },
                { timeout: 10_000, interval: 20 },
              ),
            );

          const first = yield* workspace.createWorktree(root, { branch: "first" });
          const second = yield* workspace.createWorktree(root, { branch: "second" });
          const a = yield* sessions.create({ cwd: first.path });
          const b = yield* sessions.create({ cwd: first.path });
          const c = yield* sessions.create({ cwd: second.path });

          // Archived, the last thread in it: gone, its branch kept. Unarchived: made again.
          yield* sessions.mark(c.id, { archived: true });
          yield* until("the second worktree is removed", async () => !(await exists(second.path)));
          expect(sh(root, "branch", "--list", "second")).toContain("second");
          yield* sessions.mark(c.id, { archived: false });
          yield* until("the second worktree is made again", () => exists(second.path));

          // One thread of two archived, and the other's turn running when it is archived too: kept until the turn ends.
          const events = yield* core.run(Events);
          const turn = (sessionId: string, phase: "start" | "end") =>
            phase === "start"
              ? events.publish(TurnStarted, { sessionId, turnId: "t", requestIds: [] })
              : events.publish(TurnEnded, { sessionId, turnId: "t", usage: {} as never, reason: "done" as never });
          yield* sessions.mark(a.id, { archived: true });
          running = [b.id];
          yield* turn(b.id, "start");
          yield* sessions.mark(b.id, { archived: true });
          // A later job, done in order, shows those two were: the first worktree is still there.
          yield* sessions.mark(c.id, { archived: true });
          yield* until("the second worktree is removed again", async () => !(await exists(second.path)));
          expect(yield* Effect.promise(() => exists(first.path))).toBe(true);
          running = [];
          yield* turn(b.id, "end");
          yield* until("the first worktree is removed once the turn ends", async () => !(await exists(first.path)));

          // Made again to work in an archived thread, it is not removed when that thread's turn ends: only archiving does.
          yield* workspace.restoreWorktree(first.path);
          yield* turn(a.id, "start");
          yield* turn(a.id, "end");
          yield* sessions.mark(c.id, { archived: false });
          yield* until("the second worktree is made again, after", () => exists(second.path));
          expect(yield* Effect.promise(() => exists(first.path))).toBe(true);
          yield* sessions.mark(c.id, { archived: true });
          yield* until("the second worktree is removed again, after", async () => !(await exists(second.path)));

          // Deleting the last thread of a worktree removes it too.
          yield* sessions.mark(c.id, { archived: false });
          yield* until("the second worktree is made again", () => exists(second.path));
          yield* sessions.remove(c.id);
          yield* until("the second worktree is removed with its last thread", async () => !(await exists(second.path)));
        }),
      ),
    );
  });

  it("with removeOnArchive off, keeps worktrees whose threads are archived, and still makes one again on unarchiving", async () => {
    const root = await repo();
    const home = path.join(dir, "home");
    await fs.mkdir(home);
    const agent = definePlugin({ id: "agent", provides: [Agent], layer: Layer.succeed(Agent, { running: Effect.succeed([]) } as never) });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(home), sessionsFiles, workspaceLocal, agent, tidy], {
            configs: { "workspace.local": { worktrees: path.join(dir, "trees") }, "workspace.tidy": { removeOnArchive: false } },
          });
          const workspace = yield* core.run(Workspace);
          const sessions = yield* core.run(Sessions);
          const kept = yield* workspace.createWorktree(root, { branch: "kept" });
          const gone = yield* workspace.createWorktree(root, { branch: "gone" });
          const a = yield* sessions.create({ cwd: kept.path });
          const b = yield* sessions.create({ cwd: gone.path });
          yield* sessions.mark(b.id, { archived: true });
          yield* workspace.removeWorktree(gone.path);
          yield* sessions.mark(a.id, { archived: true });
          // Unarchiving, done in order after that archiving, shows it was heard and left the worktree alone.
          yield* sessions.mark(b.id, { archived: false });
          yield* Effect.promise(() =>
            vi.waitFor(
              async () => {
                if (!(await exists(gone.path))) throw new Error("waiting until the removed worktree is made again");
              },
              { timeout: 10_000, interval: 20 },
            ),
          );
          expect(yield* Effect.promise(() => exists(kept.path))).toBe(true);
        }),
      ),
    );
  });
});
