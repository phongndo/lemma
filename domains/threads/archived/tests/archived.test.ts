import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import { archivedOf, dayLabel, extendSelection, filterArchived, groupBy, rangeOf, selectionOf, threadCount, withSelection } from "../src/archived.ts";

const session = (id: string, cwd: string, updatedAt: number, archived = true, title?: string): SessionInfo => ({
  id,
  cwd,
  createdAt: 0,
  updatedAt,
  lastSeq: 1,
  ...(archived ? { archived } : {}),
  ...(title === undefined ? {} : { title }),
});

const ids = (sessions: readonly SessionInfo[]) => sessions.map((found) => found.id);

describe("archivedOf", () => {
  it("keeps the archived, the most recently used first", () => {
    expect(ids(archivedOf([session("a", "/p", 10), session("b", "/p", 30, false), session("c", "/q", 20)]))).toEqual(["c", "a"]);
  });

  it("orders threads used at the same time by id, so the list holds still", () => {
    expect(ids(archivedOf([session("b", "/p", 10), session("a", "/p", 10)]))).toEqual(["a", "b"]);
  });
});

describe("filterArchived", () => {
  const sessions = [
    session("a", "/p", 10, true, "Fix the build"),
    session("b", "/trees/p/feature", 50, true, "Add search"),
    session("c", "/q", 30, true, "Fix the docs"),
    session("d", "/q", 60, false, "Fix everything"),
  ];
  const projectOf = (cwd: string) => (cwd.startsWith("/trees/p/") ? "/p" : cwd);
  const text = (found: SessionInfo) => `${found.title ?? ""} ${found.cwd}`;

  it("keeps the threads holding every word of the query, in any case", () => {
    expect(ids(filterArchived(sessions, { query: "FIX the", project: undefined }, projectOf, text))).toEqual(["c", "a"]);
    expect(ids(filterArchived(sessions, { query: "", project: undefined }, projectOf, text))).toEqual(["b", "c", "a"]);
  });

  it("keeps one project's, its worktrees' among them", () => {
    expect(ids(filterArchived(sessions, { query: "", project: "/p" }, projectOf, text))).toEqual(["b", "a"]);
    expect(ids(filterArchived(sessions, { query: "fix", project: "/p" }, projectOf, text))).toEqual(["a"]);
  });
});

describe("groupBy", () => {
  it("keeps the threads' order, the groups in the order of their first", () => {
    const sessions = [session("a", "/p", 50), session("b", "/q", 40), session("c", "/p", 30)];
    expect(groupBy(sessions, (found) => found.cwd).map((group) => [group.key, ids(group.sessions)])).toEqual([
      ["/p", ["a", "c"]],
      ["/q", ["b"]],
    ]);
    expect(groupBy([], (found) => found.cwd)).toEqual([]);
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 9, 15, 14, 0).getTime();
  const daysAgo = (days: number) => new Date(2026, 9, 15 - days, 12).getTime();

  it("heads recent days as a browser's history does", () => {
    expect([0, 1, 3, 20].map((days) => dayLabel(daysAgo(days), now))).toEqual(["Today", "Yesterday", "Previous 7 days", "Previous 30 days"]);
  });

  it("names older months, with the year when it is not this one", () => {
    expect(dayLabel(new Date(2026, 7, 2).getTime(), now)).toBe(new Date(2026, 7, 2).toLocaleDateString(undefined, { month: "long" }));
    expect(dayLabel(new Date(2025, 11, 2).getTime(), now)).toBe(new Date(2025, 11, 2).toLocaleDateString(undefined, { month: "long", year: "numeric" }));
  });
});

describe("selection", () => {
  const order = ["a", "b", "c", "d"];

  it("selects a range either way from the anchor, both ends included", () => {
    expect(rangeOf(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeOf(order, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("selects just the one clicked without an anchor shown", () => {
    expect(rangeOf(order, undefined, "c")).toEqual(["c"]);
    expect(rangeOf(order, "gone", "c")).toEqual(["c"]);
  });

  it("adds and takes out ids", () => {
    expect([...withSelection(new Set(["a"]), ["b", "c"], true)]).toEqual(["a", "b", "c"]);
    expect([...withSelection(new Set(["a", "b"]), ["b", "z"], false)]).toEqual(["a"]);
  });

  it("extends from the anchor, growing or shrinking the run on a second Shift-click", () => {
    const order = ["a", "b", "c", "d", "e"];
    const base = new Set(["b"]);
    expect([...extendSelection(base, order, "b", "d")].sort()).toEqual(["b", "c", "d"]);
    expect([...extendSelection(base, order, "b", "c")].sort()).toEqual(["b", "c"]);
    expect([...extendSelection(base, order, "b", "a")].sort()).toEqual(["a", "b"]);
  });

  it("keeps what was selected before the anchor, outside the run", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect([...extendSelection(new Set(["e", "b"]), order, "b", "c")].sort()).toEqual(["b", "c", "e"]);
  });

  it("clears the run when the anchor was cleared, and selects just the one without an anchor", () => {
    const order = ["a", "b", "c", "d"];
    expect([...extendSelection(new Set(["a", "c", "d"]), order, "b", "d")].sort()).toEqual(["a"]);
    expect([...extendSelection(new Set(["a"]), order, undefined, "c")].sort()).toEqual(["a", "c"]);
  });

  it("says whether all, some, or none of a list is selected", () => {
    expect(selectionOf(new Set(["a", "b"]), ["a", "b"])).toBe("all");
    expect(selectionOf(new Set(["a"]), ["a", "b"])).toBe("some");
    expect(selectionOf(new Set(["z"]), ["a", "b"])).toBe("none");
    expect(selectionOf(new Set(), [])).toBe("none");
  });
});

describe("threadCount", () => {
  it("counts in words", () => {
    expect(threadCount(1)).toBe("1 thread");
    expect(threadCount(3)).toBe("3 threads");
  });
});
