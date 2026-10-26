import { describe, expect, test } from "vitest";
import type { SessionInfo } from "@lemma/sessions";
import { relativeTime } from "@lemma/web/format";
import {
  Heads,
  afterArchiving,
  dragItems,
  dragTo,
  draftRows,
  dropVerb,
  dropped,
  flagsOf,
  nestedAgents,
  nextNeeding,
  noMarks,
  runTime,
  sectionIn,
  sections,
  shortAge,
  stepFrom,
  transitioned,
} from "../src/list.ts";

const thread = (id: string, at: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  cwd: "/repo",
  createdAt: at,
  updatedAt: at,
  lastSeq: 1,
  ...extra,
});
const ids = (list: readonly SessionInfo[]) => list.map((session) => session.id);
const none = noMarks;

describe("times", () => {
  test("ages are short", () => {
    const now = 1_000_000_000;
    expect(shortAge(now - 30_000, now)).toBe("now");
    expect(shortAge(now - 36 * 60_000, now)).toBe("36m");
    expect(shortAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(shortAge(now - 50 * 3_600_000, now)).toBe("2d");
  });

  test("ages round as the palette's do", () => {
    const now = 1_000_000_000;
    expect(shortAge(now - (3 * 60 + 40) * 60_000, now)).toBe("4h");
    // The same age, wherever it shows: `relativeTime`'s words, shortly, for the ages it counts (it writes a date from a week).
    for (let minutes = 0; minutes < 6 * 24 * 60; minutes += 7) {
      const at = now - minutes * 60_000 - 29_000;
      expect(shortAge(at, now)).toBe(relativeTime(at, now).replace("just now", "now").replace(" ago", ""));
    }
  });

  test("a running turn's time", () => {
    expect(runTime(0, 12_000)).toBe("12s");
    expect(runTime(0, 3 * 60_000)).toBe("3m");
    expect(runTime(0, 65 * 60_000)).toBe("1h 5m");
  });
});

describe("sections", () => {
  test("pinned, then the newest made or unarchived first, then the latest archived", () => {
    const list = [
      thread("a", 1),
      thread("b", 2, { updatedAt: 99 }),
      thread("c", 3, { pinned: true }),
      thread("d", 4, { archived: true }),
      thread("e", 5, { archived: true, updatedAt: 50 }),
    ];
    const marks = { ...noMarks, archivedAt: { d: 100 }, unarchivedAt: { a: 10 } };
    const { pinned, active, archived } = sections(list, marks);
    expect(ids(pinned)).toEqual(["c"]);
    // Activity does not move a thread: `b` ran last, `a` was unarchived later.
    expect(ids(active)).toEqual(["a", "b"]);
    expect(ids(archived)).toEqual(["d", "e"]);
  });

  test("an agent is listed under the thread that started it, not on its own, while both are there and unarchived", () => {
    const list = [
      thread("p", 1),
      thread("a1", 2, { parent: { sessionId: "p", toolCallId: "c1" } }),
      thread("a2", 3, { parent: { sessionId: "p" } }),
      // Its thread is gone: on its own.
      thread("orphan", 4, { parent: { sessionId: "gone" } }),
      // Archived apart from its thread: in the archived, on its own.
      thread("filed", 5, { parent: { sessionId: "p" }, archived: true }),
      // Its thread is archived: on its own, where it is.
      thread("q", 6, { archived: true }),
      thread("a3", 7, { parent: { sessionId: "q" } }),
    ];
    const { active, archived } = sections(list, none);
    expect(ids(active)).toEqual(["a3", "orphan", "p"]);
    // The latest archived first, as ever.
    expect(ids(archived)).toEqual(["q", "filed"]);
    const nested = nestedAgents(list);
    expect([...nested.keys()]).toEqual(["p"]);
    expect(nested.get("p")!.map(({ session, level }) => [session.id, level])).toEqual([
      ["a1", 1],
      ["a2", 1],
    ]);
  });

  test("an agent's own agents are listed under the thread at the top, after the agent that started them", () => {
    const list = [
      thread("p", 1),
      thread("a1", 2, { parent: { sessionId: "p" } }),
      thread("a2", 3, { parent: { sessionId: "p" } }),
      thread("a1x", 4, { parent: { sessionId: "a1" } }),
      thread("a1xy", 5, { parent: { sessionId: "a1x" } }),
    ];
    expect(ids(sections(list, none).active)).toEqual(["p"]);
    expect(
      nestedAgents(list)
        .get("p")!
        .map(({ session, level }) => [session.id, level]),
    ).toEqual([
      ["a1", 1],
      ["a1x", 2],
      ["a1xy", 3],
      ["a2", 1],
    ]);
  });

  test("a thread with nothing sent is not listed", () => {
    expect(ids(sections([thread("a", 1, { lastSeq: 0 }), thread("b", 2)], none).active)).toEqual(["b"]);
  });

  test("pinned in their order, then those not in it newest first; active new ones above those in an order", () => {
    const list = [
      thread("p1", 1, { pinned: true }),
      thread("p2", 2, { pinned: true }),
      thread("p3", 3, { pinned: true }),
      thread("a1", 4),
      thread("a2", 5),
      thread("a3", 6),
      thread("a4", 7),
    ];
    const { pinned, active } = sections(list, { ...noMarks, pinnedOrder: ["p1", "p2"], activeOrder: ["a1", "a3"] });
    expect(ids(pinned)).toEqual(["p1", "p2", "p3"]);
    expect(ids(active)).toEqual(["a4", "a2", "a1", "a3"]);
  });
});

describe("drafts", () => {
  const blank = (id: string, at: number) => thread(id, at, { lastSeq: 0 });
  const list = [blank("d1", 1), blank("d2", 2), blank("empty", 3), thread("sent", 4)];
  const drafted = (id: string) => id !== "empty";

  test("new threads with a prompt written, newest first; not the one shown unless it was a draft when opened", () => {
    expect(ids(draftRows(list, drafted, undefined, undefined))).toEqual(["d2", "d1"]);
    expect(ids(draftRows(list, drafted, "d2", undefined))).toEqual(["d1"]);
    expect(ids(draftRows(list, drafted, "d2", "d2"))).toEqual(["d2", "d1"]);
  });
});

describe("transitions", () => {
  const flags = (entries: Record<string, [pinned: boolean, archived: boolean]>) =>
    new Map(Object.entries(entries).map(([id, [pinned, archived]]) => [id, { pinned, archived }]));

  test("a new pin goes first; an unpinned one leaves the order; nothing changed is the same marks", () => {
    const marks = { ...noMarks, pinnedOrder: ["p"], activeOrder: ["n", "a"] };
    const next = transitioned(
      marks,
      flags({ p: [true, false], n: [false, false], a: [false, false] }),
      flags({ p: [false, false], n: [true, false], a: [false, false] }),
      9,
    );
    expect(next.pinnedOrder).toEqual(["n"]);
    expect(next.activeOrder).toEqual(["a"]);
    const same = flags({ a: [false, false] });
    expect(transitioned(noMarks, same, same, 9)).toBe(noMarks);
  });

  test("one dropped among the pinned keeps its place while its pin is on its way, and when it lands", () => {
    const marks = { ...noMarks, pinnedOrder: ["p", "d"] };
    const waiting = transitioned(marks, flags({ p: [true, false], d: [false, false] }), flags({ p: [true, false], d: [false, false] }), 9);
    expect(waiting.pinnedOrder).toEqual(["p", "d"]);
    expect(transitioned(waiting, flags({ p: [true, false], d: [false, false] }), flags({ p: [true, false], d: [true, false] }), 9).pinnedOrder).toEqual([
      "p",
      "d",
    ]);
  });

  test("archived ones are dated and leave the active order; unarchived ones are dated; gone ones leave every mark", () => {
    const marks = { ...noMarks, activeOrder: ["a", "b"], archivedAt: { u: 1, gone: 1 } };
    const next = transitioned(
      marks,
      flags({ a: [false, false], b: [false, false], u: [false, true] }),
      flags({ a: [false, true], b: [false, false], u: [false, false] }),
      9,
    );
    expect(next).toEqual({ archivedAt: { a: 9 }, unarchivedAt: { u: 9 }, pinnedOrder: [], activeOrder: ["b"] });
    expect(flagsOf([thread("x", 1, { pinned: true })]).get("x")).toEqual({ pinned: true, archived: false });
  });
});

describe("dragging", () => {
  const items = dragItems([thread("p", 9)], [thread("a", 8), thread("b", 7)], [thread("z", 1)]);

  test("the list runs head, threads, for each section", () => {
    expect(items).toEqual([Heads.pinned, "p", Heads.active, "a", "b", Heads.archived, "z"]);
    expect(sectionIn(items, "p")).toBe("pinned");
    expect(sectionIn(items, "b")).toBe("active");
    expect(sectionIn(items, "z")).toBe("archived");
  });

  test("a thread goes past what it is dragged onto, never above the pinned head", () => {
    expect(dragTo(items, items, "b", "a")).toEqual([Heads.pinned, "p", Heads.active, "b", "a", Heads.archived, "z"]);
    expect(dragTo(items, items, "a", Heads.active)).toEqual([Heads.pinned, "p", "a", Heads.active, "b", Heads.archived, "z"]);
    expect(dragTo(items, items, "a", Heads.pinned)).toEqual([Heads.pinned, "a", "p", Heads.active, "b", Heads.archived, "z"]);
    expect(dragTo(items, items, "a", "a")).toBe(items);
  });

  test("among the archived it goes first; an archived one goes back where it was", () => {
    expect(dragTo(items, items, "a", "z")).toEqual([Heads.pinned, "p", Heads.active, "b", Heads.archived, "a", "z"]);
    const up = dragTo(items, items, "z", "b");
    expect(sectionIn(up, "z")).toBe("active");
    expect(dragTo(up, items, "z", Heads.archived)).toEqual(items);
  });

  test("what a drop does", () => {
    expect(dropVerb("active", "pinned")).toBe("pin");
    expect(dropVerb("pinned", "active")).toBe("unpin");
    expect(dropVerb("archived", "active")).toBe("unarchive");
    expect(dropVerb("archived", "pinned")).toBe("pin");
    expect(dropVerb("active", "archived")).toBe("archive");
    expect(dropVerb("active", "active")).toBeUndefined();

    const pin = dropped(noMarks, items, [Heads.pinned, "a", "p", Heads.active, "b", Heads.archived, "z"], "a", false);
    expect(pin).toEqual({ marks: { ...noMarks, pinnedOrder: ["a", "p"] }, change: { pinned: true } });
    const reorder = dropped(noMarks, items, [Heads.pinned, "p", Heads.active, "b", "a", Heads.archived, "z"], "a", false);
    expect(reorder).toEqual({ marks: { ...noMarks, activeOrder: ["b", "a"] } });
    const unpin = dropped({ ...noMarks, pinnedOrder: ["p"] }, items, [Heads.pinned, Heads.active, "a", "p", "b", Heads.archived, "z"], "p", true);
    expect(unpin).toEqual({ marks: { ...noMarks, activeOrder: ["a", "p", "b"] }, change: { pinned: false } });
    const unarchive = dropped(noMarks, items, [Heads.pinned, "z", "p", Heads.active, "a", "b", Heads.archived], "z", false);
    expect(unarchive.change).toEqual({ pinned: true, archived: false });
    expect(dropped(noMarks, items, [Heads.pinned, "p", Heads.active, "b", Heads.archived, "a", "z"], "a", false).change).toEqual({ archived: true });
    expect(dropped(noMarks, items, items, "z", false)).toEqual({ marks: noMarks });
  });
});

describe("moving through the list", () => {
  const order = [thread("a", 3), thread("b", 2), thread("c", 1)];

  test("steps stop at the ends", () => {
    expect(stepFrom(order, "b", 1)).toBe("c");
    expect(stepFrom(order, "c", 1)).toBe("c");
    expect(stepFrom(order, "a", -1)).toBe("a");
    expect(stepFrom(order, undefined, 1)).toBe("a");
    expect(stepFrom(order, undefined, -1)).toBe("c");
  });

  test("the next thread that needs the person goes round the list, and never to the one shown", () => {
    const needs = (wanted: string[]) => (session: SessionInfo) => wanted.includes(session.id);
    expect(nextNeeding(order, "a", 1, needs(["c"]))).toBe("c");
    expect(nextNeeding(order, "c", 1, needs(["a", "b"]))).toBe("a");
    expect(nextNeeding(order, "a", -1, needs(["b"]))).toBe("b");
    expect(nextNeeding(order, "b", -1, needs(["a", "c"]))).toBe("a");
    // From no thread in the list (a new one shown), the first or the last that needs the person.
    expect(nextNeeding(order, undefined, 1, needs(["b", "c"]))).toBe("b");
    expect(nextNeeding(order, "z", -1, needs(["a", "b"]))).toBe("b");
    expect(nextNeeding(order, "a", 1, needs(["a"]))).toBeUndefined();
    expect(nextNeeding([], undefined, 1, () => true)).toBeUndefined();
  });

  test("archiving the thread shown goes to the next, else the one before", () => {
    expect(afterArchiving(order, "a")).toBe("b");
    expect(afterArchiving(order, "c")).toBe("b");
    expect(afterArchiving([order[0]!], "a")).toBeUndefined();
  });
});
