import { describe, expect, test } from "vitest";
import { ledger, pluginShares, promptDiff, trajectory } from "@lemma/sessions";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";
import { formatDiff, formatRecords, formatSession, formatShares, formatStep, formatSystem, formatTrajectory } from "../src/format.ts";
import { findStep, parseOffset } from "../src/index.ts";

describe("formatSession", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const event = (seq: number, data: SessionEvent["data"]): SessionEvent => ({ seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: 0, data });
  const info: SessionInfo = { id: "s1", cwd: "/work", createdAt: 0, updatedAt: 0, title: "Fix it", leaf: "e6", lastSeq: 6 };

  test("renders the branch as a transcript", () => {
    const output = formatSession(info, [
      event(1, { type: "turn-start", turnId: "t" }),
      event(2, { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix it" }], timestamp: 0 } }),
      event(3, {
        type: "message",
        message: {
          role: "assistant",
          api: "x",
          provider: "p",
          model: "m",
          usage,
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Looking." },
            { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
          ],
        },
      }),
      event(4, {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          isError: true,
          timestamp: 0,
          content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }],
        },
      }),
      event(5, { type: "turn-end", turnId: "t", reason: "cancelled" }),
      event(6, { type: "title", title: "Fix it" }),
    ]);
    const body = output.slice(output.indexOf("\n\n") + 2);
    expect(body).toBe(
      [
        "── user",
        "Fix it",
        "── assistant (p/m)",
        "Looking.",
        '→ bash {"command":"ls"}',
        "── bash (error)",
        ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
        "… 8 more lines",
        "── turn ended: cancelled",
      ].join("\n"),
    );
    expect(output).toContain("events   6 (6 on the current branch)");
  });
});

describe("inspect formatting", () => {
  const usage = {
    input: 1200,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1240,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const spec = { name: "bash", description: "Run", parameters: {} };
  const events: SessionEvent[] = (
    [
      { type: "turn-start", turnId: "t" },
      { type: "message", turnId: "t", message: { role: "user", content: [{ type: "text", text: "Run ls" }], timestamp: 0 } },
      { type: "step-start", turnId: "t", stepId: "s1" },
      {
        type: "request",
        turnId: "t",
        stepId: "s1",
        model: "p/m",
        composition: "abc",
        system: "BASE\n\nCTX",
        tools: [spec],
        contributions: [
          { source: "agent", kind: "system", label: "base", chars: 4 },
          { source: "project-context", kind: "system", label: "project-context", chars: 3 },
          { source: "bash", kind: "tool", label: "bash", chars: JSON.stringify(spec).length },
        ],
      },
      {
        type: "message",
        turnId: "t",
        stepId: "s1",
        timing: { startedAt: 0, firstTokenAt: 500, endedAt: 2000 },
        message: {
          role: "assistant",
          api: "x",
          provider: "p",
          model: "m",
          usage,
          stopReason: "toolUse",
          timestamp: 0,
          content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }],
        },
      },
      {
        type: "message",
        turnId: "t",
        stepId: "s1",
        timing: { startedAt: 2000, endedAt: 2300 },
        message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError: false, timestamp: 0 },
      },
      { type: "step-end", turnId: "t", stepId: "s1" },
      { type: "turn-end", turnId: "t", reason: "done" },
    ] satisfies SessionEvent["data"][]
  ).map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: i * 1000, data }));
  const turns = trajectory(events);

  test("the overview has one line per step", () => {
    expect(formatTrajectory(turns)).toBe(
      ["Turn 1 · done · 1 step · ↑1.2k ↓40 · 7.0s", '  "Run ls"', "  1  s1  m  1 msg  ↑1.2k ↓40  ttft 500ms  2.0s  → bash"].join("\n"),
    );
  });

  test("records list as a table with step, request, kind, status, time, tokens, and name", () => {
    expect(formatRecords(ledger(turns), false).split("\n")).toEqual([
      "step  req  kind    status    time   tokens   name",
      "1          user    sent                      Run ls",
      "1     #1   system  initial                   initial system prompt",
      "1.1   #1   model   tool use  2.0s   1.2k/40  → bash",
      '1.1        tool    ok        300ms           bash {"command":"ls"}',
    ]);
    expect(formatRecords([], false)).toBe("No records match.");
  });

  test("the system view prints each section under its plugin, and the diff view prints changed lines", () => {
    const request = turns[0]!.steps[0]!.request!;
    expect(formatSystem(request)).toBe("── base from agent, 4 chars (changed)\nBASE\n\n── project-context from project-context, 3 chars (changed)\nCTX");
    expect(formatDiff(promptDiff(undefined, request), true)).toContain("first request");
    const edited = { ...request, sections: request.sections.map((section) => (section.id === "base" ? { ...section, text: "BASE 2" } : section)) };
    expect(formatDiff(promptDiff(request, edited), false)).toBe("── base from agent (changed)\n- BASE\n+ BASE 2");
    expect(formatDiff([], false)).toContain("unchanged");
  });

  test("the plugins view gives each plugin's share in tokens, and what of it changed", () => {
    const request = turns[0]!.steps[0]!.request!;
    const shares = pluginShares(request);
    expect(formatShares(shares, true).split("\n").slice(0, 4)).toEqual([
      "plugin           prompt  tools  changed",
      "bash                     ≈13    (first request)",
      "agent            ≈1             (first request)",
      "project-context  ≈1             (first request)",
    ]);
    expect(formatShares([{ ...shares[1]!, changed: ["base"] }], false)).toContain("agent   ≈1             base");
    expect(formatShares([], false)).toBe("No plugin put anything in this request.");
  });

  test("a step names the plugin behind every part of the request", () => {
    const output = formatStep(turns[0]!, turns[0]!.steps[0]!);
    expect(output).toContain("  base from agent, 4 chars (changed)\n    BASE");
    expect(output).toContain("  project-context from project-context, 3 chars (changed)\n    CTX");
    expect(output).toMatch(/ {2}bash {2}from bash {2}\d+ chars {2}\(changed\)/);
    expect(output).toContain("composition  abc");
    expect(output).toMatch(/Tool runs:\n {2}bash {2}ok {2}300ms/);
  });
});

describe("sessions inspect's arguments", () => {
  test("offsets accept seconds, units, and combinations", () => {
    expect(parseOffset("90")).toBe(90_000);
    expect(parseOffset("1m30s")).toBe(90_000);
    expect(parseOffset("500ms")).toBe(500);
    expect(parseOffset("2h")).toBe(7_200_000);
    expect(parseOffset("1.5s")).toBe(1500);
    expect(parseOffset("soon")).toBeUndefined();
    expect(parseOffset("5x")).toBeUndefined();
    expect(parseOffset("")).toBeUndefined();
  });

  test("a request is found by its number, by <turn>.<step>, by step id, or as the last", () => {
    const step = (stepId: string, request: boolean) => ({ stepId, ...(request ? { request: { eventId: `r-${stepId}` } } : {}) });
    // Only what findStep reads of a trajectory: each turn's steps, and whether each sent a request.
    const turns = [{ steps: [step("a", true), step("b", false)] }, { steps: [step("c", true), step("d", true)] }] as unknown as Parameters<typeof findStep>[0];
    const found = (selector: string) => findStep(turns, selector)?.step.stepId;
    expect(["1", "2", "3", "4"].map(found)).toEqual(["a", "c", "d", undefined]);
    expect(found("last")).toBe("d");
    expect(found("1.2")).toBe("b");
    expect(found("2.1")).toBe("c");
    expect(found("3.1")).toBeUndefined();
    expect(found("1.9")).toBeUndefined();
    expect(found("b")).toBe("b");
    expect(found("zzz")).toBeUndefined();
    expect(findStep(turns, "2.2")?.turn).toBe(turns[1]);
  });
});
