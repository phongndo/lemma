import { describe, expect, test } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import { afterClose, neighborOf, pruned, seedOpen, shownThreads, withClosed, withOpened } from "../src/open.ts";

const thread = (id: string, updatedAt: number, marks: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  cwd: "/repo",
  createdAt: 0,
  updatedAt,
  lastSeq: 0,
  ...marks,
});

const a = thread("a", 1);
const b = thread("b", 2);
const c = thread("c", 3);
const pinned = thread("p", 4, { pinned: true });
const archived = thread("x", 5, { archived: true });
const all = [a, b, c, pinned, archived];
const ids = (list: readonly SessionInfo[]) => list.map((session) => session.id);

describe("shownThreads", () => {
  test("pinned threads show on their own; open ones in the order they were opened", () => {
    const shown = shownThreads(all, ["c", "a"], []);
    expect(ids(shown.pinned)).toEqual(["p"]);
    expect(ids(shown.open)).toEqual(["c", "a"]);
  });

  test("a closed thread with a turn running stays in sight, after the open ones", () => {
    expect(ids(shownThreads(all, ["a"], ["b"]).open)).toEqual(["a", "b"]);
  });

  test("archived, pinned, and unknown ids are not among the open", () => {
    expect(ids(shownThreads(all, ["x", "p", "gone", "b"], ["x"]).open)).toEqual(["b"]);
  });
});

describe("the open list", () => {
  test("opening adds at the end once; closing takes out", () => {
    expect(withOpened(["a"], "b")).toEqual(["a", "b"]);
    expect(withOpened(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(withClosed(["a", "b"], "a")).toEqual(["b"]);
  });

  test("gone and archived threads drop out", () => {
    expect(pruned(["a", "gone", "x"], all)).toEqual(["a"]);
  });

  test("a first visit opens the most recent threads, not pinned or archived ones", () => {
    expect(seedOpen(all, 2)).toEqual(["c", "b"]);
  });
});

describe("moving", () => {
  const order = [a, b, c];

  test("closing moves to the thread below, else above, else none", () => {
    expect(afterClose(order, "b")).toBe("c");
    expect(afterClose(order, "c")).toBe("b");
    expect(afterClose([a], "a")).toBeUndefined();
  });

  test("next and previous wrap, and start from the first", () => {
    expect(neighborOf(order, "c", 1)).toBe("a");
    expect(neighborOf(order, "a", -1)).toBe("c");
    expect(neighborOf(order, undefined, 1)).toBe("a");
    expect(neighborOf([], "a", 1)).toBeUndefined();
  });
});
