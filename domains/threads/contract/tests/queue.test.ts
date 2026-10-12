import { describe, expect, it } from "vitest";
import type { QueuedPrompt } from "@lemma/agent";
import type { EventData } from "@lemma/sessions";
import { openTurn, queuePlaces, recentRequests, waitingPrompts } from "../src/queue.ts";
import { branch } from "../src/testing.ts";

const queued = (requestId: string, mode: "steer" | "follow-up" = "steer"): QueuedPrompt => ({
  requestId,
  mode,
  content: [{ type: "text", text: requestId }],
  at: 0,
});
const placed = (requestId: string, turnId = "t2"): EventData => ({
  type: "message",
  turnId,
  requestId,
  message: { role: "user", content: [{ type: "text", text: requestId }], timestamp: 0 },
});
const start = (turnId: string): EventData => ({ type: "turn-start", turnId });
const end = (turnId: string): EventData => ({ type: "turn-end", turnId, reason: "done" });

describe("recentRequests", () => {
  it("reads the prompts placed in the last two turns, and no further back", () => {
    const log = branch(start("t1"), placed("old", "t1"), end("t1"), start("t2"), placed("a"), end("t2"), placed("b", "t3"), start("t3"), placed("c", "t3"));
    expect([...recentRequests(log)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("waitingPrompts", () => {
  it("leaves out what the log has placed, whichever reached the page first", () => {
    const log = branch(start("t2"), placed("a"));
    expect(waitingPrompts([queued("a"), queued("b")], [], log).map((prompt) => prompt.requestId)).toEqual(["b"]);
  });

  it("keeps a prompt that left the queue, ahead of it, until the log has it", () => {
    const left = queued("a");
    expect(waitingPrompts([queued("b")], [left], branch(start("t2"))).map((prompt) => prompt.requestId)).toEqual(["a", "b"]);
    expect(waitingPrompts([queued("b")], [left], branch(start("t2"), placed("a"))).map((prompt) => prompt.requestId)).toEqual(["b"]);
  });

  it("keeps each prompt's object while its mode stays, and the list itself when nothing changed", () => {
    const before = waitingPrompts([queued("a"), queued("b", "follow-up")], [], []);
    const again = waitingPrompts([queued("a"), queued("b", "follow-up")], [], [], before);
    expect(again).toBe(before);
    const promoted = waitingPrompts([queued("a"), queued("b", "steer")], [], [], before);
    expect(promoted[0]).toBe(before[0]);
    expect(promoted[1]).not.toBe(before[1]);
    expect(promoted[1]!.mode).toBe("steer");
  });
});

describe("openTurn", () => {
  it("is the last turn while it has started and not ended, and whether it has begun its steps", () => {
    expect(openTurn([])).toBeUndefined();
    expect(openTurn(branch(start("t1"), end("t1")))).toBeUndefined();
    expect(openTurn(branch(start("t1"), placed("a", "t1")))).toEqual({ startedAt: 1000, stepping: false });
    expect(openTurn(branch(start("t1"), end("t1"), start("t2"), { type: "step-start", turnId: "t2", stepId: "p1" }))).toEqual({
      startedAt: 3000,
      stepping: true,
    });
  });
});

describe("queuePlaces", () => {
  const threads = (queue: readonly QueuedPrompt[], busy: boolean, log: readonly EventData[]) => ({
    queue: () => queue,
    busy: () => busy,
    branch: () => branch(...log),
  });
  const ids = (prompts: readonly QueuedPrompt[]) => prompts.map((prompt) => prompt.requestId);
  const at = (prompt: QueuedPrompt, time: number): QueuedPrompt => ({ ...prompt, at: time });
  const step: EventData = { type: "step-start", turnId: "t1", stepId: "p1" };

  it("has a steer sent during the running turn join it, and the follow-ups wait for a turn of their own", () => {
    // The turn started at 1000 (`branch` dates its first event so).
    const places = queuePlaces(threads([at(queued("s"), 1500), queued("f", "follow-up")], true, [start("t1")]));
    expect([places.running, ids(places.joining), ids(places.next)]).toEqual([true, ["s"], ["f"]]);
  });

  it("keeps a steer a stopped turn left waiting until the next turn has placed it, before its first step", () => {
    const held = at(queued("held"), 500);
    const opening = queuePlaces(threads([held], true, [start("t1")]));
    expect([ids(opening.joining), ids(opening.next)]).toEqual([[], ["held"]]);
    // Once the turn steps, a steer queued before it (a follow-up promoted) joins it.
    const stepping = queuePlaces(threads([held], true, [start("t1"), step]));
    expect([ids(stepping.joining), ids(stepping.next)]).toEqual([["held"], []]);
  });

  it("has every prompt wait for the next turn while none has started: stopped, or a prompt just sent", () => {
    const queue = [at(queued("s"), 1500), queued("f", "follow-up")];
    for (const places of [
      queuePlaces(threads(queue, true, [start("t1"), end("t1")])),
      queuePlaces(threads(queue, false, [start("t1")])),
      queuePlaces(threads(queue, true, [])),
    ])
      expect([places.running, ids(places.joining), ids(places.next)]).toEqual([false, [], ["s", "f"]]);
  });
});
