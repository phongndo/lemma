import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionInfo } from "@lemma/contracts";
import { appendLog, applySessionsChange, fileSessions, groupSessions, newerQueue, resolveLeaf, trackTurn, upsertSession } from "../src/model/threads.ts";

const info = (id: string, cwd: string, updatedAt: number, lastSeq = 0): SessionInfo => ({ id, cwd, createdAt: 0, updatedAt, lastSeq });
const ev = (id: string, parent: string | null, seq: number): SessionEvent => ({ seq, id, parent, at: seq, data: { type: "title", title: id } });

describe("groupSessions", () => {
  it("groups by cwd with newest groups and sessions first", () => {
    const groups = groupSessions([info("a", "/x", 1), info("b", "/y", 5), info("c", "/x", 9), info("d", "/y", 2)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/x", ["c", "a"]],
      ["/y", ["b", "d"]],
    ]);
  });
});

describe("fileSessions", () => {
  it("lifts pinned sessions out of their projects and leaves archived ones out, pinned or not", () => {
    const filed = fileSessions([
      { ...info("a", "/x", 1), pinned: true },
      info("b", "/x", 5),
      { ...info("c", "/y", 9), pinned: true },
      { ...info("d", "/y", 7), archived: true },
      { ...info("e", "/z", 8), archived: true, pinned: true },
    ]);
    expect(filed.pinned.map((s) => s.id)).toEqual(["c", "a"]);
    expect(filed.groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([["/x", ["b"]]]);
  });
});

describe("upsertSession", () => {
  it("inserts new sessions first and never steps back", () => {
    const list = [info("a", "/x", 5, 3)];
    expect(upsertSession(list, info("b", "/x", 1)).map((s) => s.id)).toEqual(["b", "a"]);
    expect(upsertSession(list, info("a", "/x", 4, 2))[0]!.lastSeq).toBe(3);
    expect(upsertSession(list, { ...info("a", "/x", 6, 4), title: "t" })[0]!.title).toBe("t");
  });
});

describe("applySessionsChange", () => {
  it("replays a change heard while a listing was on its way over that listing", () => {
    const listed = [info("a", "/x", 5, 3), info("b", "/x", 4)];
    const changes = [
      { type: "session-changed", info: info("c", "/y", 9) },
      { type: "session-removed", sessionId: "b" },
      { type: "session-changed", info: info("a", "/x", 4, 2) },
    ] as const;
    expect(changes.reduce(applySessionsChange, listed).map((s) => [s.id, s.lastSeq])).toEqual([
      ["c", 0],
      ["a", 3],
    ]);
  });
});

describe("appendLog", () => {
  it("adds what follows the last event, and keeps the same log when nothing does", () => {
    const log = [ev("1", null, 1), ev("2", "1", 2)];
    expect(appendLog(log, [ev("2", "1", 2), ev("3", "2", 3)]).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(appendLog(log, [ev("1", null, 1)])).toBe(log);
    expect(appendLog([], log)).toEqual(log);
  });
});

describe("resolveLeaf", () => {
  const events = [ev("1", null, 1), ev("2", "1", 2), ev("3", "2", 3), ev("4", "1", 4)];
  it("uses the newest event when the reported leaf is its ancestor (stale info)", () => {
    expect(resolveLeaf(events.slice(0, 3), "2")).toBe("3");
  });
  it("keeps a checkout of an earlier event on the same branch once the info has seen every event", () => {
    // Log 1 → 2 → 3, then a checkout of 2: the info already counts event 3.
    expect(resolveLeaf(events.slice(0, 3), "2", 3)).toBe("2");
    // A newer event than the info knows still wins when it descends from the leaf.
    expect(resolveLeaf(events.slice(0, 3), "2", 2)).toBe("3");
  });
  it("keeps a checked-out leaf on another branch", () => {
    expect(resolveLeaf(events, "3")).toBe("3");
  });
  it("falls back to the newest event for unknown or missing leaves", () => {
    expect(resolveLeaf(events, "zzz")).toBe("4");
    expect(resolveLeaf(events, undefined)).toBe("4");
    expect(resolveLeaf([], "1")).toBeUndefined();
  });
});

describe("trackTurn", () => {
  const start = (sessionId: string, turnId: string) => ({ type: "turn-started" as const, sessionId, turnId });
  const end = (sessionId: string, turnId: string) => ({ type: "turn-ended" as const, sessionId, turnId });
  const idle = { running: [], ended: {} };

  it("marks a session running from start to end", () => {
    const started = trackTurn(idle, start("s", "t1"));
    expect(started.running).toEqual(["s"]);
    expect(trackTurn(started, end("s", "t1")).running).toEqual([]);
  });

  it("stays idle when a turn's end overtakes its start", () => {
    const ended = trackTurn(idle, end("s", "t1"));
    expect(trackTurn(ended, start("s", "t1")).running).toEqual([]);
    // The next turn still counts.
    expect(trackTurn(trackTurn(ended, start("s", "t1")), start("s", "t2")).running).toEqual(["s"]);
  });
});

describe("newerQueue", () => {
  it("keeps the newer of a view's queue and an event's, whichever arrives last", () => {
    const prompt = { requestId: "r1", content: [], mode: "follow-up" as const, at: 1 };
    const view = { queue: [prompt], revision: 5 };
    // The prompt was placed after the view was taken: the event says so, and the view arriving after it does not undo it.
    const event = { queue: [], revision: 6 };
    expect(newerQueue(newerQueue(undefined, event), view)).toBe(event);
    expect(newerQueue(newerQueue(undefined, view), event)).toBe(event);
  });
});
