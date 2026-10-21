import { describe, expect, it } from "vitest";
import {
  OUTPUT_TAIL_CHARS,
  appendOutput,
  applyDelta,
  beginJoin,
  draftEntries,
  dropOutput,
  emptyLive,
  endTurn,
  joinLive,
  parseDraftArgs,
  seedLive,
  settleStep,
  reconcileLive,
} from "../src/live.ts";
import type { LiveState } from "../src/live.ts";
import type { StreamEvent } from "@lemma/llm";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { assistant, branch, toolResult } from "../src/testing.ts";

const feed = (events: StreamEvent[], state: LiveState = emptyLive, stepId = "s1") => events.reduce((s, event) => applyDelta(s, "t1", stepId, event), state);

describe("live drafts", () => {
  it("accumulates text, thinking, and tool call deltas by index", () => {
    const s = feed([
      { type: "start" },
      { type: "thinking-delta", index: 0, delta: "hm" },
      { type: "thinking-delta", index: 0, delta: "m" },
      { type: "text-delta", index: 1, delta: "Hel" },
      { type: "text-delta", index: 1, delta: "lo" },
      { type: "toolcall-start", index: 2, id: "c1", name: "bash" },
      { type: "toolcall-delta", index: 2, delta: '{"command":"l' },
    ]);
    const blocks = s.drafts[0]!.blocks;
    expect(blocks[0]).toEqual({ kind: "thinking", text: "hmm" });
    expect(blocks[1]).toEqual({ kind: "text", text: "Hello" });
    expect(blocks[2]).toMatchObject({ kind: "tool", id: "c1", name: "bash", args: '{"command":"l' });
    const done = feed([{ type: "toolcall-end", index: 2, toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } } }], s);
    const tool = done.drafts[0]!.blocks[2]!;
    expect(tool.kind === "tool" && parseDraftArgs(tool)).toEqual({ command: "ls" });
  });

  it("marks the draft finished with the stream error", () => {
    const s = feed([
      { type: "text-delta", index: 0, delta: "x" },
      { type: "error", message: assistant([], { stopReason: "error", errorMessage: "boom" }) },
    ]);
    expect(s.drafts[0]).toMatchObject({ finished: true, error: "boom" });
  });

  it("drops a settled step and ignores its late deltas", () => {
    let s = feed([{ type: "text-delta", index: 0, delta: "x" }]);
    s = settleStep(s, "s1");
    expect(s.drafts).toEqual([]);
    s = feed([{ type: "text-delta", index: 0, delta: "late" }], s);
    expect(s.drafts).toEqual([]);
  });

  it("settling before any delta prevents a stale draft", () => {
    const s = feed([{ type: "text-delta", index: 0, delta: "x" }], settleStep(emptyLive, "s1"));
    expect(s.drafts).toEqual([]);
  });

  it("ending a turn clears its drafts only", () => {
    let s = feed([{ type: "text-delta", index: 0, delta: "x" }]);
    s = applyDelta(s, "t2", "s9", { type: "text-delta", index: 0, delta: "y" });
    s = endTurn(s, "t1");
    expect(s.drafts.map((d) => d.stepId)).toEqual(["s9"]);
  });

  it("parses partial arguments leniently", () => {
    expect(parseDraftArgs({ kind: "tool", id: "", name: "bash", args: '{"command":' })).toBeUndefined();
  });
});

describe("draftEntries", () => {
  it("joins adjacent thoughts and makes only the block being written live", () => {
    const s = feed([
      { type: "thinking-delta", index: 0, delta: "**Looking**" },
      { type: "thinking-delta", index: 1, delta: "**Planning**" },
      { type: "text-delta", index: 2, delta: "Here" },
    ]);
    expect(draftEntries(s.drafts[0]!)).toEqual([
      { index: 0, block: { kind: "thinking", text: "**Looking**\n\n**Planning**" }, live: false },
      { index: 2, block: { kind: "text", text: "Here" }, live: true },
    ]);
    const thinking = feed([{ type: "thinking-delta", index: 0, delta: "hm" }]);
    expect(draftEntries(thinking.drafts[0]!).map((entry) => entry.live)).toEqual([true]);
    const finished = feed([{ type: "done", message: assistant([]) }], thinking);
    expect(draftEntries(finished.drafts[0]!).map((entry) => entry.live)).toEqual([false]);
  });
});

describe("reconcileLive", () => {
  it("settles what an event at a time would, for any log and state", () => {
    // The fold it replaced, an event at a time (settling each step made a set per step: quadratic in a long log).
    const stepwise = (state: LiveState, events: readonly SessionEvent[]): LiveState => {
      if (state.drafts.length === 0 && state.output.size === 0 && state.printed.size === 0) return state;
      let next = state;
      const calls = new Map<string, string[]>();
      for (const { data } of events) {
        if (data.type === "message" && data.message.role === "toolResult") next = dropOutput(next, data.message.toolCallId);
        else if (data.type === "message" && data.message.role === "assistant") {
          if (data.turnId !== undefined)
            calls.set(data.turnId, [...(calls.get(data.turnId) ?? []), ...data.message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))]);
          if (data.stepId !== undefined) next = settleStep(next, data.stepId);
        } else if (data.type === "attempt") next = settleStep(next, data.stepId);
        else if (data.type === "turn-end") {
          if (next.drafts.some((draft) => draft.turnId === data.turnId)) {
            const settled = new Set(next.settled);
            for (const draft of next.drafts) if (draft.turnId === data.turnId) settled.add(draft.stepId);
            next = { ...next, drafts: next.drafts.filter((draft) => draft.turnId !== data.turnId), settled };
          }
          for (const id of calls.get(data.turnId) ?? []) next = dropOutput(next, id);
        }
      }
      return next;
    };
    const shape = (state: LiveState) => ({
      drafts: state.drafts,
      settled: [...state.settled].sort(),
      output: [...state.output].sort(),
      printed: [...state.printed].sort(),
    });
    // mulberry32: the same cases each run.
    let seed = 7;
    const pick = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    for (let round = 0; round < 200; round++) {
      const data: EventData[] = [];
      for (let i = 0; i < 12; i++) {
        const turnId = `t${pick(3)}`;
        const stepId = `s${pick(4)}`;
        const call = `c${pick(4)}`;
        const kind = pick(4);
        if (kind === 0) data.push({ type: "message", message: assistant([{ type: "toolCall", id: call, name: "bash", arguments: {} }]), turnId, stepId });
        else if (kind === 1) data.push(toolResult(call, "out"));
        else if (kind === 2) data.push({ type: "attempt", turnId, stepId, message: assistant([]), timing: { startedAt: 0, endedAt: 1 } });
        else data.push({ type: "turn-end", turnId, reason: "done" });
      }
      let state = emptyLive;
      for (let i = 0; i < 4; i++) state = applyDelta(state, `t${pick(3)}`, `s${pick(4)}`, { type: "text-delta", index: 0, delta: "x" });
      for (let i = 0; i < 3; i++) state = appendOutput(state, `c${pick(4)}`, "o");
      const settledBefore = pick(2) === 0 ? state : settleStep(state, `s${pick(4)}`);
      const log = branch(...data);
      expect(shape(reconcileLive(settledBefore, log)), JSON.stringify(data)).toEqual(shape(stepwise(settledBefore, log)));
    }
  });

  it("settles drafts the recovered log already covers", () => {
    let state = applyDelta(emptyLive, "t1", "s1", { type: "text-delta", index: 0, delta: "partial" });
    state = applyDelta(state, "t2", "s2", { type: "text-delta", index: 0, delta: "other" });
    const events = [{ seq: 1, id: "a", parent: null, at: 1, data: { type: "message", message: assistant([]), turnId: "t1", stepId: "s1" } }] as const;
    const reconciled = reconcileLive(state, events as never);
    expect(reconciled.drafts.map((draft) => draft.stepId)).toEqual(["s2"]);
    const ended = reconcileLive(reconciled, [{ seq: 2, id: "b", parent: "a", at: 2, data: { type: "turn-end", turnId: "t2", reason: "done" } }] as never);
    expect(ended.drafts).toEqual([]);
    // Nothing to do leaves the state untouched.
    expect(reconcileLive(ended, events as never)).toBe(ended);
  });

  it("keeps a running tool's output tail until its result is logged or the turn ends", () => {
    let s = appendOutput(appendOutput(emptyLive, "c1", "a\n"), "c1", "b\n");
    expect(s.output.get("c1")).toBe("a\nb\n");
    expect(appendOutput(s, "c1", "x".repeat(OUTPUT_TAIL_CHARS)).output.get("c1")).toHaveLength(OUTPUT_TAIL_CHARS);
    expect(dropOutput(s, "c1").output.has("c1")).toBe(false);
    expect(reconcileLive(s, branch(toolResult("c1", "a\nb"))).output.has("c1")).toBe(false);
    s = appendOutput(s, "c2", "y");
    expect(endTurn(s, "t1").output.size).toBe(0);
  });

  it("drops only the ended turn's tool output when the log is replayed", () => {
    const running = appendOutput(emptyLive, "now", "building\n");
    const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
    const log = [
      { seq: 1, id: "a", parent: null, at: 1, data: { type: "message", message: assistant([call("old")] as never), turnId: "t0", stepId: "s0" } },
      { seq: 2, id: "b", parent: "a", at: 2, data: { type: "turn-end", turnId: "t0", reason: "cancelled" } },
      { seq: 3, id: "c", parent: "b", at: 3, data: { type: "message", message: assistant([call("now")] as never), turnId: "t1", stepId: "s1" } },
    ];
    // An earlier turn's end leaves the running tool's output alone...
    expect(reconcileLive(appendOutput(running, "old", "stale"), log as never).output).toEqual(new Map([["now", "building\n"]]));
    // ...and the running turn's own end drops it.
    const ended = [...log, { seq: 4, id: "d", parent: "c", at: 4, data: { type: "turn-end", turnId: "t1", reason: "cancelled" } }];
    expect(reconcileLive(running, ended as never).output.size).toBe(0);
  });

  it("continues from a view of a turn joined midway, skipping the deltas and output it already holds", () => {
    const view = {
      turnId: "t1",
      draft: { stepId: "s1", seq: 2, blocks: [{ index: 0, block: { type: "text" as const, text: "Hello" } }] },
      output: [{ toolCallId: "c1", output: "line 1\n", length: 7 }],
      queue: [],
      queueRevision: 0,
    };
    // A delta from before the view arrives after it (another queue) and is skipped; the next one continues it.
    let s = seedLive(applyDelta(emptyLive, "t1", "s1", { type: "text-delta", index: 0, delta: "Hel" }, 1), view);
    s = applyDelta(s, "t1", "s1", { type: "text-delta", index: 0, delta: "lo" }, 2);
    s = applyDelta(s, "t1", "s1", { type: "text-delta", index: 0, delta: " there" }, 3);
    expect(s.drafts[0]!.blocks[0]).toEqual({ kind: "text", text: "Hello there" });
    // Output by offset: a chunk inside what the view held is skipped, one straddling it adds only its new part.
    s = appendOutput(s, "c1", "line 1\n", 0);
    s = appendOutput(s, "c1", "1\nline 2\n", 5);
    expect(s.output.get("c1")).toBe("line 1\nline 2\n");
    expect(seedLive(s, { output: [], queue: [], queueRevision: 0 })).toBe(s);
  });

  it("seeds a tool call still streaming its arguments as one in progress", () => {
    const s = seedLive(emptyLive, {
      turnId: "t1",
      draft: { stepId: "s1", seq: 1, blocks: [{ index: 0, block: { type: "toolCall", id: "c1", name: "bash", arguments: {} } }] },
      output: [],
      queue: [],
      queueRevision: 0,
    });
    expect(s.drafts[0]!.blocks[0]).toEqual({ kind: "tool", id: "c1", name: "bash", args: "" });
  });

  it("replays what arrived while the view was on its way over the view, so a newer delta never stands in for its prefix", () => {
    // Joining at seq 100: delta 101 comes first, then the view through 100.
    let s = beginJoin(emptyLive);
    s = applyDelta(s, "t1", "s1", { type: "text-delta", index: 1, delta: "w101 " }, 101);
    s = appendOutput(s, "c1", "line 2\n", 7);
    expect(s.drafts).toEqual([]);
    const view = {
      turnId: "t1",
      draft: { stepId: "s1", seq: 100, blocks: [{ index: 1, block: { type: "text" as const, text: "w1 … w100 " } }] },
      output: [{ toolCallId: "c1", output: "line 1\n", length: 7 }],
      queue: [],
      queueRevision: 0,
    };
    const joined = joinLive(s, view, []);
    expect(joined.joining).toBeUndefined();
    // Seeded at their stream index: the gap at 0 stays a gap.
    expect(joined.drafts[0]!.blocks[0]).toBeUndefined();
    expect(joined.drafts[0]!.blocks[1]).toEqual({ kind: "text", text: "w1 … w100 w101 " });
    expect(joined.output.get("c1")).toBe("line 1\nline 2\n");
    // Without a view, what was held is applied as it came.
    expect(joinLive(s, undefined, []).drafts[0]!.blocks[1]).toEqual({ kind: "text", text: "w101 " });
  });

  it("does not bring back a draft or output from a view older than the log that arrived first", () => {
    const view = {
      turnId: "t1",
      draft: { stepId: "s1", seq: 3, blocks: [{ index: 0, block: { type: "text" as const, text: "partial" } }] },
      output: [{ toolCallId: "c1", output: "running", length: 7 }],
      queue: [],
      queueRevision: 0,
    };
    // The log already has the step's answer, the tool's result, and the turn's end.
    const log = [
      {
        seq: 1,
        id: "a",
        parent: null,
        at: 1,
        data: { type: "message", message: assistant([{ type: "text", text: "whole" }] as never), turnId: "t1", stepId: "s1" },
      },
      { seq: 2, id: "b", parent: "a", at: 2, data: toolResult("c1", "done") },
      { seq: 3, id: "c", parent: "b", at: 3, data: { type: "turn-end", turnId: "t1", reason: "done" } },
    ];
    const joined = joinLive(emptyLive, view, log as never);
    expect(joined.drafts).toEqual([]);
    expect(joined.output.size).toBe(0);
    // Without a log yet, the view is what shows.
    expect(joinLive(emptyLive, view, []).drafts).toHaveLength(1);
  });
});
