import { describe, expect, it } from "vitest";
import {
  OUTPUT_TAIL_CHARS,
  appendOutput,
  applyDelta,
  createFinished,
  draftEntries,
  emptyLive,
  endTurn,
  joinLive,
  noteEnded,
  noteLogged,
  parseDraftArgs,
  seedLive,
  reconcileLive,
} from "../src/live.ts";
import type { Finished, LiveState } from "../src/live.ts";
import type { StreamEvent } from "@lemma/llm";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { assistant, branch, toolResult } from "../src/testing.ts";

const feed = (events: StreamEvent[], state: LiveState = emptyLive, stepId = "s1") => events.reduce((s, event) => applyDelta(s, "t1", stepId, event), state);
/** What is over in `log`, noted whole. */
const over = (log: readonly SessionEvent[]): Finished => {
  const finished = createFinished();
  noteLogged(finished, log);
  return finished;
};

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

  it("drops a step the log holds and ignores its late deltas", () => {
    let s = feed([{ type: "text-delta", index: 0, delta: "x" }]);
    s = reconcileLive(s, over(branch({ type: "message", message: assistant([]), turnId: "t1", stepId: "s1" })));
    expect(s.drafts).toEqual([]);
    s = feed([{ type: "text-delta", index: 0, delta: "late" }], s);
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
    const settleStep = (state: LiveState, stepId: string): LiveState => {
      if (state.settled.has(stepId) && !state.drafts.some((draft) => draft.stepId === stepId)) return state;
      return { ...state, drafts: state.drafts.filter((draft) => draft.stepId !== stepId), settled: new Set([...state.settled, stepId]) };
    };
    const dropOutput = (state: LiveState, toolCallId: string): LiveState => {
      const output = new Map(state.output);
      output.delete(toolCallId);
      const printed = new Map(state.printed);
      printed.delete(toolCallId);
      return { ...state, output, printed };
    };
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
    const shape = (state: LiveState) => ({ drafts: state.drafts, output: [...state.output].sort(), printed: [...state.printed].sort() });
    const sorted = (finished: Finished) => ({
      steps: [...finished.steps].sort(),
      turns: [...finished.turns].sort(),
      calls: [...finished.calls].sort(),
      open: [...finished.open].map(([turn, calls]) => [turn, [...calls].sort()]).sort(),
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
      const reconciled = reconcileLive(settledBefore, over(log));
      expect(shape(reconciled), JSON.stringify(data)).toEqual(shape(stepwise(settledBefore, log)));
      // A draft it closed stays closed: its stragglers are ignored.
      for (const draft of settledBefore.drafts) if (!reconciled.drafts.includes(draft)) expect(reconciled.settled.has(draft.stepId)).toBe(true);
      // Noted as the log is appended to, a piece at a time, what is over is what the log says whole.
      const pieces = createFinished();
      for (let at = 0; at < log.length;) {
        const end = at + 1 + pick(4);
        noteLogged(pieces, log.slice(0, end), at);
        at = end;
      }
      expect(sorted(pieces)).toEqual(sorted(over(log)));
    }
  });

  it("settles drafts the recovered log already covers", () => {
    let state = applyDelta(emptyLive, "t1", "s1", { type: "text-delta", index: 0, delta: "partial" });
    state = applyDelta(state, "t2", "s2", { type: "text-delta", index: 0, delta: "other" });
    const events = [{ seq: 1, id: "a", parent: null, at: 1, data: { type: "message", message: assistant([]), turnId: "t1", stepId: "s1" } }] as const;
    const finished = over(events as never);
    const reconciled = reconcileLive(state, finished);
    expect(reconciled.drafts.map((draft) => draft.stepId)).toEqual(["s2"]);
    noteLogged(finished, [...events, { seq: 2, id: "b", parent: "a", at: 2, data: { type: "turn-end", turnId: "t2", reason: "done" } }] as never, 1);
    const ended = reconcileLive(reconciled, finished);
    expect(ended.drafts).toEqual([]);
    // Nothing to do leaves the state untouched.
    expect(reconcileLive(ended, finished)).toBe(ended);
  });

  it("keeps a running tool's output tail until its result is logged or the turn ends", () => {
    let s = appendOutput(appendOutput(emptyLive, "c1", "a\n"), "c1", "b\n");
    expect(s.output.get("c1")).toBe("a\nb\n");
    expect(appendOutput(s, "c1", "x".repeat(OUTPUT_TAIL_CHARS)).output.get("c1")).toHaveLength(OUTPUT_TAIL_CHARS);
    expect(reconcileLive(s, over(branch(toolResult("c1", "a\nb")))).output.has("c1")).toBe(false);
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
    expect(reconcileLive(appendOutput(running, "old", "stale"), over(log as never)).output).toEqual(new Map([["now", "building\n"]]));
    // ...and the running turn's own end drops it.
    const ended = [...log, { seq: 4, id: "d", parent: "c", at: 4, data: { type: "turn-end", turnId: "t1", reason: "cancelled" } }];
    expect(reconcileLive(running, over(ended as never)).output.size).toBe(0);
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
    const joined = joinLive(emptyLive, view, over(log as never));
    expect(joined.drafts).toEqual([]);
    expect(joined.output.size).toBe(0);
    // Without a log yet, the view is what shows.
    expect(joinLive(emptyLive, view, createFinished()).drafts).toHaveLength(1);
  });

  it("shows no draft or output again from what arrives after the log or the agent said it was over", () => {
    // The step's answer, its tool's result, and the turn's end are logged; its last deltas and output come after them.
    const finished = over(
      branch(
        { type: "message", message: assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] as never), turnId: "t1", stepId: "s1" },
        toolResult("c1", "done"),
        { type: "message", message: assistant([{ type: "text", text: "Done." }] as never), turnId: "t1", stepId: "s2" },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    let late = applyDelta(emptyLive, "t1", "s2", { type: "text-delta", index: 0, delta: "Done." }, 1);
    late = appendOutput(late, "c1", "tail");
    expect(reconcileLive(late, finished)).toMatchObject({ drafts: [], output: new Map(), printed: new Map() });
    // Ended as the agent said, before the log says so: a step of it the log has not yet is over too.
    const told = createFinished();
    noteEnded(told, "t2");
    expect(reconcileLive(applyDelta(emptyLive, "t2", "s9", { type: "text-delta", index: 0, delta: "x" }, 1), told).drafts).toEqual([]);
    // A call logged before its turn's end, with no result, is over once the turn ends.
    const open = over(
      branch({ type: "message", message: assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: {} }] as never), turnId: "t3", stepId: "s3" }),
    );
    expect(reconcileLive(appendOutput(emptyLive, "c2", "x"), open).output.has("c2")).toBe(true);
    noteEnded(open, "t3");
    expect(reconcileLive(appendOutput(emptyLive, "c2", "x"), open).output.has("c2")).toBe(false);
  });
});
