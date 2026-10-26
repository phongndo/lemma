import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import type { Place } from "@lemma/workspace";
import { initialOf, projectStats, worktreeRows } from "../src/model.ts";

const session = (id: string, cwd: string, updatedAt: number, archived?: boolean, lastSeq = 1): SessionInfo => ({
  id,
  cwd,
  createdAt: 0,
  updatedAt,
  lastSeq,
  ...(archived === undefined ? {} : { archived }),
});

describe("projectStats", () => {
  const sessions = [session("a", "/p", 10), session("b", "/p", 30, true), session("c", "/q", 50)];

  it("counts a project's threads, those archived and running, and its latest use", () => {
    expect(projectStats(sessions, ["b", "c"], "/p")).toEqual({ threads: 2, archived: 1, running: 1, lastActive: 30 });
  });

  it("counts the threads of the project's worktrees as its own", () => {
    const projectOf = (cwd: string) => (cwd.startsWith("/trees/p/") ? "/p" : cwd);
    expect(projectStats([...sessions, session("d", "/trees/p/fix", 70)], ["d"], "/p", projectOf)).toEqual({
      threads: 3,
      archived: 1,
      running: 1,
      lastActive: 70,
    });
  });

  it("has no last use without threads", () => {
    expect(projectStats(sessions, [], "/none")).toEqual({ threads: 0, archived: 0, running: 0, lastActive: undefined });
  });
});

describe("worktreeRows", () => {
  const places: Record<string, Place> = {
    "/trees/p/a": { path: "/trees/p/a", project: "/p", worktree: true, exists: true, branch: "a" },
    "/trees/p/gone": { path: "/trees/p/gone", project: "/p", worktree: true, exists: false, branch: "gone" },
    "/trees/q/x": { path: "/trees/q/x", project: "/q", worktree: true, exists: true, branch: "x" },
    "/p": { path: "/p", project: "/p", worktree: false, exists: true, branch: "main" },
  };

  it("lists git's worktrees and those its threads worked in since removed, the busiest first, archived and blank threads not counted", () => {
    const sessions = [
      session("1", "/trees/p/a", 1),
      session("2", "/trees/p/a", 2, true),
      session("3", "/trees/p/gone", 3),
      session("4", "/trees/p/gone", 4),
      session("5", "/trees/q/x", 5),
      session("6", "/p", 6),
      session("7", "/trees/p/a", 7, false, 0),
    ];
    expect(
      worktreeRows(
        [
          { path: "/trees/p/a", branch: "a" },
          { path: "/trees/p/idle", branch: null },
        ],
        sessions,
        (cwd) => places[cwd],
        "/p",
      ),
    ).toEqual([
      { path: "/trees/p/gone", branch: "gone", threads: 2, removed: true },
      { path: "/trees/p/a", branch: "a", threads: 1, removed: false },
      { path: "/trees/p/idle", branch: null, threads: 0, removed: false },
    ]);
  });
});

describe("initialOf", () => {
  it("is a name's first letter or digit, upper-cased", () => {
    expect(initialOf("lemma")).toBe("L");
    expect(initialOf(".dotfiles")).toBe("D");
    expect(initialOf("2024-notes")).toBe("2");
    expect(initialOf("élan")).toBe("É");
  });

  it("is # for a name with none", () => {
    expect(initialOf("---")).toBe("#");
  });
});
