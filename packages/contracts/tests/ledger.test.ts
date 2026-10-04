import { describe, expect, it } from "vitest";
import { emptyUsage } from "../src/llm.ts";
import { trajectory } from "../src/trajectory.ts";
import type { AssistantMessage } from "../src/llm.ts";
import type { Contribution, EventData, SessionEvent } from "../src/sessions.ts";
import { ledger, ledgerSpans, lineDiff, parseLedgerFilter, promptDiff, recordSummary } from "../src/ledger.ts";

const log = (...items: EventData[]): SessionEvent[] =>
  items.map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: 1000 * (i + 1), data }));
const section = (label: string, text: string): Contribution => ({ source: "agent", kind: "system", label, chars: text.length });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "x",
  provider: "p",
  model: "m",
  usage: emptyUsage,
  stopReason,
  timestamp: 0,
});
const request = (turnId: string, stepId: string, env: string, withSystem: boolean): EventData => ({
  type: "request",
  turnId,
  stepId,
  model: "p/m",
  composition: "c",
  ...(withSystem ? { system: `BASE\n\n${env}` } : {}),
  contributions: [section("base", "BASE"), section("environment", env)],
});

const events = log(
  { type: "turn-start", turnId: "t1" },
  { type: "message", turnId: "t1", message: { role: "user", content: [{ type: "text", text: "list" }], timestamp: 0 } },
  { type: "step-start", turnId: "t1", stepId: "s1" },
  request("t1", "s1", "day 1", true),
  {
    type: "message",
    turnId: "t1",
    stepId: "s1",
    timing: { startedAt: 5000, firstTokenAt: 5500, endedAt: 6000 },
    message: assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
  },
  {
    type: "message",
    turnId: "t1",
    stepId: "s1",
    timing: { startedAt: 6000, endedAt: 6100 },
    message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a" }], isError: true, timestamp: 0 },
  },
  { type: "step-end", turnId: "t1", stepId: "s1" },
  { type: "step-start", turnId: "t1", stepId: "s2" },
  request("t1", "s2", "day 1", false),
  { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "done" }], "stop") },
  { type: "step-end", turnId: "t1", stepId: "s2" },
  { type: "turn-end", turnId: "t1", reason: "done" },
  { type: "turn-start", turnId: "t2" },
  { type: "message", turnId: "t2", message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 0 } },
  { type: "step-start", turnId: "t2", stepId: "s3" },
  request("t2", "s3", "day 2", true),
  { type: "attempt", turnId: "t2", stepId: "s3", message: assistant([], "error"), timing: { startedAt: 17000, endedAt: 17500 } },
  { type: "step-end", turnId: "t2", stepId: "s3" },
  { type: "turn-end", turnId: "t2", reason: "error" },
);
const records = ledger(trajectory(events));

describe("ledger", () => {
  it("orders user, system, model, and tool records, numbering every request", () => {
    expect(records.map((record) => [record.kind, record.turnStart])).toEqual([
      ["user", true],
      ["system", false],
      ["assistant", false],
      ["tool", false],
      ["assistant", false],
      ["user", true],
      ["system", false],
      ["assistant", false],
    ]);
    expect(records.flatMap((record) => (record.kind === "assistant" ? [[record.requestNumber, record.failed]] : []))).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it("adds a system record only when the prompt is first sent or changes, with the previous texts for the diff", () => {
    const systems = records.filter((record) => record.kind === "system");
    expect(systems.map((record) => record.requestNumber)).toEqual([1, 3]);
    expect(systems[0]!.previous).toBeUndefined();
    expect(systems[1]!.previous?.get("environment")).toBe("day 1");
  });

  it("places records on the input, model, and tool lanes", () => {
    expect(ledgerSpans(records).map((span) => [span.record.kind, span.lane, span.start, span.end, span.ttft, span.error])).toEqual([
      ["user", 0, 1000, 1000, undefined, false],
      ["assistant", 1, 5000, 6000, 500, false],
      ["tool", 2, 6000, 6100, undefined, true],
      // No timing on this response: it starts at its request and has no end.
      ["assistant", 1, 9000, undefined, undefined, false],
      ["user", 0, 13000, 13000, undefined, false],
      ["assistant", 1, 17000, 17500, undefined, true],
    ]);
  });
});

describe("lineDiff", () => {
  it("marks kept, removed, and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });
});

describe("parseLedgerFilter", () => {
  const kinds = (input: string) => records.filter(parseLedgerFilter(input)).map((record) => record.kind);

  it("matches everything when empty", () => {
    expect(kinds("")).toHaveLength(records.length);
  });

  it("understands is:, kind:, tool:, turn:, and req:", () => {
    expect(kinds("is:error")).toEqual(["tool", "assistant"]);
    expect(kinds("kind:model")).toEqual(["assistant", "assistant", "assistant"]);
    expect(kinds("tool:bash")).toEqual(["tool"]);
    expect(kinds("turn:2")).toEqual(["user", "system", "assistant"]);
    expect(kinds("req:2")).toEqual(["assistant"]);
  });

  it("combines terms and negates with a leading dash", () => {
    expect(kinds("turn:1 -kind:tool")).toEqual(["user", "system", "assistant", "assistant"]);
    expect(kinds("again")).toEqual(["user"]);
    expect(kinds("-is:error kind:model")).toEqual(["assistant", "assistant"]);
  });
});

describe("recordSummary", () => {
  it("flattens a record to serializable data without its turn", () => {
    const summaries = records.map((record) => recordSummary(record));
    expect(() => JSON.stringify(summaries)).not.toThrow();
    expect(summaries[3]).toMatchObject({
      kind: "tool",
      turn: 1,
      step: 1,
      tool: "bash",
      arguments: { command: "ls" },
      result: "a",
      status: "error",
      error: true,
      duration: 100,
    });
    expect(summaries[2]).toMatchObject({ kind: "assistant", request: 1, ttft: 500, duration: 1000, toolCalls: ["bash"], status: "tool use" });
    expect(JSON.stringify(summaries).length).toBeLessThan(4000);
  });
});

describe("promptDiff", () => {
  const requests = trajectory(events).flatMap((turn) => turn.steps.flatMap((step) => (step.request === undefined ? [] : [step.request])));

  it("reports changed sections with their lines, and nothing for an unchanged prompt", () => {
    expect(promptDiff(requests[0], requests[1]!)).toEqual([]);
    expect(promptDiff(requests[1], requests[2]!)).toEqual([
      {
        id: "environment",
        source: "agent",
        status: "changed",
        lines: [
          { kind: "del", text: "day 1" },
          { kind: "add", text: "day 2" },
        ],
      },
    ]);
  });

  it("marks sections added and removed", () => {
    const [first] = requests;
    const without = { ...first!, sections: first!.sections.filter((section) => section.id === "base") };
    expect(promptDiff(undefined, first!).map((section) => [section.id, section.status])).toEqual([
      ["base", "added"],
      ["environment", "added"],
    ]);
    expect(promptDiff(first, without).map((section) => [section.id, section.status])).toEqual([["environment", "removed"]]);
  });
});

describe("steers", () => {
  it("lists a prompt placed in a running turn after the step it followed", () => {
    const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
    const steered = trajectory(
      log(
        { type: "turn-start", turnId: "t1" },
        { type: "message", turnId: "t1", message: user("first") },
        { type: "step-start", turnId: "t1", stepId: "s1" },
        request("t1", "s1", "env", true),
        { type: "message", turnId: "t1", stepId: "s1", message: assistant([{ type: "text", text: "working" }], "stop") },
        { type: "step-end", turnId: "t1", stepId: "s1" },
        { type: "message", turnId: "t1", requestId: "r2", message: user("also this") },
        { type: "step-start", turnId: "t1", stepId: "s2" },
        request("t1", "s2", "env", false),
        { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "both" }], "stop") },
        { type: "step-end", turnId: "t1", stepId: "s2" },
        { type: "turn-end", turnId: "t1", reason: "done" },
      ),
    );
    expect(steered[0]!.steers).toEqual([{ eventId: "e7", message: user("also this"), at: 7000, after: 1 }]);
    const text = (record: ReturnType<typeof ledger>[number]) => {
      const summary = recordSummary(record);
      return "text" in summary ? summary.text : record.id;
    };
    expect(ledger(steered).map((record) => [record.kind, record.kind === "user" ? text(record) : record.id])).toEqual([
      ["user", "first"],
      ["system", "e4:system"],
      ["assistant", "e5"],
      ["user", "also this"],
      ["assistant", "e10"],
    ]);
  });
});
