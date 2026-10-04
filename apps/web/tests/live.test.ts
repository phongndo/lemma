import { describe, expect, it } from "vitest";
import {
  OUTPUT_TAIL_CHARS,
  appendOutput,
  applyDelta,
  beginJoin,
  dropOutput,
  emptyLive,
  endTurn,
  joinLive,
  parseDraftArgs,
  seedLive,
  settleStep,
  reconcileLive,
} from "../src/model/live.ts";
import type { LiveState } from "../src/model/live.ts";
import type { StreamEvent } from "@lemma/contracts";
import { assistant, branch, toolResult } from "./fixtures.ts";

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

describe("reconcileLive", () => {
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
