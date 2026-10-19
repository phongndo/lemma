import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import { initialOf, projectStats, threadCount } from "../src/model.ts";

const session = (id: string, cwd: string, updatedAt: number, archived?: boolean): SessionInfo => ({
  id,
  cwd,
  createdAt: 0,
  updatedAt,
  lastSeq: 0,
  ...(archived === undefined ? {} : { archived }),
});

describe("projectStats", () => {
  const sessions = [session("a", "/p", 10), session("b", "/p", 30, true), session("c", "/q", 50)];

  it("counts a project's threads, those archived and running, and its latest use", () => {
    expect(projectStats(sessions, ["b", "c"], "/p")).toEqual({ threads: 2, archived: 1, running: 1, lastActive: 30 });
  });

  it("has no last use without threads", () => {
    expect(projectStats(sessions, [], "/none")).toEqual({ threads: 0, archived: 0, running: 0, lastActive: undefined });
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

describe("threadCount", () => {
  it("says thread for one", () => {
    expect(threadCount(1)).toBe("1 thread");
    expect(threadCount(2)).toBe("2 threads");
  });
});
