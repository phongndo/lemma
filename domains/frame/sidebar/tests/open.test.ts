import { describe, expect, test } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import { afterClose, lastClosed, moved, neighborOf, pruned, seedOpen, shownThreads, withClosed, withOpened, withReopened } from "../src/open.ts";

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

describe("reopening closed threads", () => {
  test("the latest closed one comes back where it stood", () => {
    const { reopen, rest } = lastClosed(
      [
        { id: "a", index: 0 },
        { id: "c", index: 1 },
      ],
      ["b"],
      all,
    );
    expect(reopen).toEqual({ id: "c", index: 1 });
    expect(rest).toEqual([{ id: "a", index: 0 }]);
    expect(withReopened(["a", "b"], { id: "c", index: 1 })).toEqual(["a", "c", "b"]);
  });

  test("skips ones gone, archived, or open again", () => {
    expect(
      lastClosed(
        [
          { id: "b", index: 0 },
          { id: "gone", index: 0 },
          { id: "x", index: 0 },
          { id: "a", index: 0 },
        ],
        ["a"],
        all,
      ).reopen,
    ).toEqual({ id: "b", index: 0 });
  });

  test("lands at the end when the list has shrunk", () => {
    expect(withReopened(["a"], { id: "c", index: 4 })).toEqual(["a", "c"]);
  });
});

describe("moving a tab", () => {
  test("takes it to the place named, the rest in order", () => {
    expect(moved(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moved(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], "b", 9)).toEqual(["a", "c", "b"]);
  });

  test("adds one that was only in view", () => {
    expect(moved(["a", "b"], "r", 1)).toEqual(["a", "r", "b"]);
  });
});
