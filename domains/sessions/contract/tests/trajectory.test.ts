import { describe, expect, it } from "vitest";
import { emptyUsage } from "@lemma/llm";
import type { AssistantMessage, ToolSpec } from "@lemma/llm";
import type { Contribution, EventData, SessionEvent } from "../src/sessions.ts";
import { deriveMessages } from "../src/derive.ts";
import { cacheReport, latestRequest, pluginShares, splitSystem, trajectory } from "../src/trajectory.ts";

function log(...items: readonly EventData[]): SessionEvent[] {
  return items.map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: 1000 + i, data }));
}

const section = (label: string, text: string, source = "agent"): Contribution => ({ source, kind: "system", label, chars: text.length });
const tool = (spec: ToolSpec, source = spec.name): Contribution => ({ source, kind: "tool", label: spec.name, chars: JSON.stringify(spec).length });
const usage = (input: number, output: number) => ({ ...emptyUsage, input, output, totalTokens: input + output });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], tokens = usage(10, 5)): AssistantMessage => ({
  role: "assistant",
  content,
  api: "x",
  provider: "p",
  model: "m",
  usage: tokens,
  stopReason,
  timestamp: 0,
});

const read: ToolSpec = { name: "read", description: "Read a file", parameters: {} };
const bash: ToolSpec = { name: "bash", description: "Run a command", parameters: {} };

describe("splitSystem", () => {
  it("splits by the recorded sizes, skipping empty sections", () => {
    const contributions = [section("base", "You are an agent."), section("empty", ""), section("env", "cwd: /x")];
    expect(splitSystem("You are an agent.\n\ncwd: /x", contributions)).toEqual(["You are an agent.", "", "cwd: /x"]);
  });

  it("gives up when the sizes do not add up", () => {
    expect(splitSystem("You are an agent.\ncwd: /x", [section("base", "You are an agent."), section("env", "cwd: /x")])).toBeUndefined();
    expect(splitSystem("longer than recorded", [section("base", "short")])).toBeUndefined();
  });
});

describe("trajectory", () => {
  it("gives the step that asked a failed call again the attempts before it, and each step what the turn did next", () => {
    const failed = assistant([], "error");
    const turns = trajectory(
      log(
        { type: "turn-start", turnId: "t" },
        { type: "message", turnId: "t", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 } },
        { type: "step-start", turnId: "t", stepId: "s1" },
        {
          type: "attempt",
          turnId: "t",
          stepId: "s1",
          message: failed,
          timing: { startedAt: 0, endedAt: 1 },
          failure: { kind: "transient" },
          retry: { reason: "failure", attempt: 1, at: 2 },
        },
        { type: "step-end", turnId: "t", stepId: "s1" },
        { type: "step-start", turnId: "t", stepId: "s2" },
        { type: "message", turnId: "t", stepId: "s2", message: assistant([{ type: "text", text: "ok" }], "stop") },
        { type: "step-end", turnId: "t", stepId: "s2", decision: { result: "continue", why: "tool results to read" } },
        { type: "turn-end", turnId: "t", reason: "max-steps" },
      ),
    );
    const [first, second] = turns[0]!.steps;
    expect([first!.earlier, first!.attempts.length, first!.after]).toEqual([[], 1, { kind: "step" }]);
    expect(second!.earlier.map((attempt) => attempt.message)).toEqual([failed]);
    // The hook said go on; the turn was out of steps.
    expect([second!.decision?.result, second!.after]).toEqual(["continue", { kind: "end", reason: "max-steps" }]);
  });

  it("counts the messages each request carried as deriveMessages does, across a compaction", () => {
    const say = (turnId: string, text: string): EventData => ({
      type: "message",
      turnId,
      message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
    });
    const answer = (turnId: string, stepId: string): EventData => ({
      type: "message",
      turnId,
      stepId,
      message: assistant([{ type: "text", text: "ok" }], "stop"),
    });
    const ask = (turnId: string, stepId: string): EventData => ({ type: "request", turnId, stepId, model: "p/m", composition: "c", contributions: [] });
    const turn = (turnId: string, ...extra: EventData[]): EventData[] => [
      { type: "turn-start", turnId },
      say(turnId, turnId),
      { type: "step-start", turnId, stepId: `${turnId}.1` },
      ...extra,
      ask(turnId, `${turnId}.1`),
      answer(turnId, `${turnId}.1`),
      { type: "step-end", turnId, stepId: `${turnId}.1` },
      { type: "turn-end", turnId, reason: "done" },
    ];
    // The third turn compacts what came before its own prompt (e16) into a summary.
    const branch = log(
      ...turn("t1"),
      ...turn("t2"),
      ...turn("t3", { type: "compaction", turnId: "t3", summary: "so far", firstKeptId: "e16", tokensBefore: 100, source: "compaction" }),
      ...turn("t4"),
    );
    const counted = trajectory(branch).flatMap((t) => t.steps.map((step) => step.request!));
    const derived = counted.map(
      (request) =>
        deriveMessages(
          branch.slice(
            0,
            branch.findIndex((event) => event.id === request.eventId),
          ),
        ).length,
    );
    expect(counted.map((request) => request.messages)).toEqual(derived);
    expect(derived).toEqual([1, 3, 2, 4]);
  });

  const events = log(
    { type: "turn-start", turnId: "t1" },
    { type: "message", turnId: "t1", message: { role: "user", content: [{ type: "text", text: "list files" }], timestamp: 0 } },
    { type: "title", title: "list files" },
    { type: "step-start", turnId: "t1", stepId: "s1" },
    {
      type: "request",
      turnId: "t1",
      stepId: "s1",
      model: "p/m",
      composition: "c1",
      system: "BASE\n\nENV 1",
      tools: [read, bash],
      contributions: [section("base", "BASE"), section("environment", "ENV 1"), tool(read), tool(bash)],
    },
    {
      type: "message",
      turnId: "t1",
      stepId: "s1",
      timing: { startedAt: 1, firstTokenAt: 2, endedAt: 3 },
      message: assistant([{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
    },
    {
      type: "message",
      turnId: "t1",
      stepId: "s1",
      timing: { startedAt: 4, endedAt: 9 },
      details: { exitCode: 0 },
      message: { role: "toolResult", toolCallId: "call1", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false, timestamp: 0 },
    },
    { type: "step-end", turnId: "t1", stepId: "s1" },
    { type: "step-start", turnId: "t1", stepId: "s2" },
    {
      type: "request",
      turnId: "t1",
      stepId: "s2",
      model: "p/m",
      composition: "c1",
      contributions: [section("base", "BASE"), section("environment", "ENV 1"), tool(read), tool(bash)],
    },
    { type: "message", turnId: "t1", stepId: "s2", message: assistant([{ type: "text", text: "a and b" }], "stop") },
    { type: "step-end", turnId: "t1", stepId: "s2" },
    { type: "turn-end", turnId: "t1", reason: "done" },
    { type: "turn-start", turnId: "t2" },
    { type: "message", turnId: "t2", message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 0 } },
    { type: "step-start", turnId: "t2", stepId: "s3" },
    {
      type: "request",
      turnId: "t2",
      stepId: "s3",
      model: "p/m",
      thinking: "high",
      composition: "c2",
      system: "BASE\n\nENV 2",
      tools: [read],
      contributions: [section("base", "BASE"), section("environment", "ENV 2"), tool(read)],
    },
    { type: "attempt", turnId: "t2", stepId: "s3", message: assistant([], "error", usage(3, 0)), timing: { startedAt: 20, endedAt: 21 } },
    { type: "step-end", turnId: "t2", stepId: "s3" },
    { type: "turn-end", turnId: "t2", reason: "error", error: "boom" },
  );
  const turns = trajectory(events);

  it("groups steps under turns with their requests, responses, and tool runs", () => {
    expect(turns.map((turn) => [turn.turnId, turn.index, turn.steps.map((step) => step.stepId)])).toEqual([
      ["t1", 1, ["s1", "s2"]],
      ["t2", 2, ["s3"]],
    ]);
    const [first, second] = turns[0]!.steps;
    expect(turns[0]!.prompt?.content).toEqual([{ type: "text", text: "list files" }]);
    expect(turns[0]!.end).toEqual({ reason: "done" });
    expect(first!.request).toMatchObject({ eventId: "e5", model: "p/m", composition: "c1", messages: 1 });
    expect(first!.tools).toEqual([
      {
        call: { type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } },
        result: expect.objectContaining({ toolCallId: "call1" }),
        eventId: "e7",
        timing: { startedAt: 4, endedAt: 9 },
        details: { exitCode: 0 },
      },
    ]);
    expect(second!.request?.messages).toBe(3);
    expect(second!.response?.message.stopReason).toBe("stop");
    expect(turns[0]!.usage).toMatchObject({ input: 20, output: 10 });
  });

  it("keeps who shaped each step: the request's handlers, its compactions, each tool's credit, and the decision", () => {
    const [turn] = trajectory(
      log(
        { type: "turn-start", turnId: "t1" },
        { type: "message", turnId: "t1", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 } },
        { type: "step-start", turnId: "t1", stepId: "s1" },
        { type: "compaction", summary: "Earlier, they said go.", firstKeptId: "e2", tokensBefore: 900, source: "context.compaction", turnId: "t1" },
        {
          type: "request",
          turnId: "t1",
          stepId: "s1",
          model: "p/m",
          composition: "c1",
          system: "base",
          tools: [bash],
          contributions: [section("base", "base"), tool(bash)],
          handlers: [{ source: "context.compaction", ms: 3.5, changed: ["+compaction"] }],
        },
        {
          type: "message",
          turnId: "t1",
          stepId: "s1",
          message: assistant([{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
        },
        {
          type: "message",
          turnId: "t1",
          stepId: "s1",
          message: { role: "toolResult", toolCallId: "call1", toolName: "bash", content: [], isError: true, timestamp: 0 },
          credit: { checks: [{ source: "plan-mode", allowed: false, ms: 0.2, reason: "read only" }] },
        },
        { type: "step-end", turnId: "t1", stepId: "s1", decision: { result: "continue", why: "tool results to read" } },
      ),
    );
    const [step] = turn!.steps;
    expect(step!.request?.handlers).toEqual([{ source: "context.compaction", ms: 3.5, changed: ["+compaction"] }]);
    expect(step!.compactions).toEqual([{ eventId: "e4", at: 1003, source: "context.compaction", tokensBefore: 900, summary: "Earlier, they said go." }]);
    expect(step!.tools[0]!.credit).toEqual({ checks: [{ source: "plan-mode", allowed: false, ms: 0.2, reason: "read only" }] });
    expect(step!.decision).toEqual({ result: "continue", why: "tool results to read" });
  });

  it("resolves the omitted header and marks what changed", () => {
    const unchanged = turns[0]!.steps[1]!.request!;
    expect(unchanged.system).toBe("BASE\n\nENV 1");
    expect(unchanged.sections.map((s) => [s.id, s.text, s.changed])).toEqual([
      ["base", "BASE", false],
      ["environment", "ENV 1", false],
    ]);
    expect(unchanged.tools.map((t) => [t.name, t.spec?.description, t.changed])).toEqual([
      ["read", "Read a file", false],
      ["bash", "Run a command", false],
    ]);

    const first = turns[0]!.steps[0]!.request!;
    expect(first.sections.every((s) => s.changed) && first.tools.every((t) => t.changed)).toBe(true);

    const next = turns[1]!.steps[0]!.request!;
    expect(next.sections.map((s) => [s.id, s.changed])).toEqual([
      ["base", false],
      ["environment", true],
    ]);
    expect(next.tools.map((t) => [t.name, t.changed])).toEqual([["read", false]]);
    expect(next.removed).toEqual(["bash"]);
    expect(next.thinking).toBe("high");
  });

  it("gives each plugin's share of a request, and what of it changed since the one before", () => {
    const next = latestRequest(turns)!;
    expect(next).toBe(turns[1]!.steps[0]!.request);
    expect(pluginShares(next)).toEqual([
      { source: "read", systemChars: 0, toolChars: JSON.stringify(read).length, sections: [], tools: ["read"], changed: [] },
      { source: "agent", systemChars: "BASE".length + "ENV 2".length, toolChars: 0, sections: ["base", "environment"], tools: [], changed: ["environment"] },
    ]);
    expect(latestRequest([])).toBeUndefined();
  });

  it("reports the requests that changed the system prompt or tools, by the plugin that changed them", () => {
    const report = cacheReport(turns);
    // The first request is everything new; the next unchanged; the third changed the environment and dropped bash.
    expect(report).toMatchObject({ requests: 3, changed: 1, changedBy: { agent: 1, "(removed)": 1 } });
    expect(report.input).toBeGreaterThan(0);
    expect(cacheReport([])).toEqual({ requests: 0, changed: 0, changedBy: {}, input: 0, cacheRead: 0 });
  });

  it("keeps failed attempts and counts their usage", () => {
    const step = turns[1]!.steps[0]!;
    expect(step.response).toBeUndefined();
    expect(step.attempts.map((attempt) => attempt.eventId)).toEqual(["e18"]);
    expect(turns[1]!.usage.input).toBe(3);
    expect(turns[1]!.end).toEqual({ reason: "error", error: "boom" });
  });

  it("matches a tool result logged without a step to its call", () => {
    const closing = log(
      { type: "turn-start", turnId: "t" },
      { type: "step-start", turnId: "t", stepId: "s" },
      { type: "message", turnId: "t", stepId: "s", message: assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }], "toolUse") },
      { type: "message", turnId: "t", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [], isError: true, timestamp: 0 } },
      { type: "turn-end", turnId: "t", reason: "cancelled" },
    );
    expect(trajectory(closing)[0]!.steps[0]!.tools[0]!.result?.isError).toBe(true);
  });
});
