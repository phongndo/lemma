import { describe, expect, test } from "vitest";
import { kernelOf, ledger, promptDiff, trajectory } from "@lemma/contracts";
import type { PluginStatus, SessionEvent, SessionInfo } from "@lemma/contracts";
import {
  formatCapabilities,
  formatChannels,
  formatDiff,
  formatPlugin,
  formatPlugins,
  formatRecords,
  formatReload,
  formatSession,
  formatStep,
  formatSystem,
  formatTrajectory,
} from "../src/format.ts";

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

  test("a step names the plugin behind every part of the request", () => {
    const output = formatStep(turns[0]!, turns[0]!.steps[0]!);
    expect(output).toContain("  base from agent, 4 chars (changed)\n    BASE");
    expect(output).toContain("  project-context from project-context, 3 chars (changed)\n    CTX");
    expect(output).toMatch(/ {2}bash {2}from bash {2}\d+ chars {2}\(changed\)/);
    expect(output).toContain("composition  abc");
    expect(output).toMatch(/Tool runs:\n {2}bash {2}ok {2}300ms/);
  });
});

describe("formatChannels", () => {
  test("says so when no plugin serves one", () => {
    expect(formatChannels([])).toBe("No channels: no running plugin serves one.");
  });
});

describe("formatReload", () => {
  test("says what changed, or what a deferred change restarts", () => {
    const report = { started: [], restarted: ["llm"], stopped: [] };
    expect(formatReload(report)).toBe("restarted llm");
    expect(formatReload({ started: [], restarted: [], stopped: [] })).toBe("nothing changed");
    expect(formatReload({ ...report, restarted: [], deferred: true }, "the plugins the reload changes")).toBe(
      "applying: the host restarts the plugins the reload changes, the transport among them, so clients reconnect",
    );
  });
});

describe("formatPlugins", () => {
  test("says why a plugin is left out, and what waits on it", () => {
    const base = { version: "1", source: "bundled" as const, enabled: true, provides: [], requires: [] };
    const text = formatPlugins([
      { ...base, id: "agent", provides: ["lemma/Agent"], state: "disabled", problem: "its config is invalid at maxSteps: Expected number" },
      { ...base, id: "compaction", requires: ["lemma/Agent"], state: "disabled", haltedBy: "agent" },
    ]);
    expect(text).toContain("left out: its config is invalid at maxSteps: Expected number");
    expect(text).toContain("needs agent, which is left out");
  });
});

test("channels say when no running plugin serves one", () => {
  expect(formatChannels([])).toBe("No channels: no running plugin serves one.");
});

describe("what the host provides itself", () => {
  const base = { version: "1", source: "bundled" as const, enabled: true, state: "active" as const, provides: [], requires: [] };
  const plugins: PluginStatus[] = [
    { ...base, id: "llm", provides: ["lemma/Llm"] },
    { ...base, id: "agent", requires: ["lemma/Llm", "lemma/HostControl", "lemma/Missing"] },
  ];
  const runtime = ["lemma/Paths", "lemma/HostControl"];

  test("a plugin's requirement on it is from the host, not from no plugin", () => {
    const text = formatPlugin(plugins, plugins[1]!, runtime);
    expect(text).toContain("  Llm  from llm\n  HostControl  from the host\n  Missing  from no plugin");
  });

  test("its capabilities are provided by the host, whether or not a plugin requires them, and only what nothing provides is NOTHING", () => {
    const rows = formatCapabilities(kernelOf(plugins, runtime)).split("\n");
    expect(rows.find((row) => row.startsWith("lemma/HostControl"))).toMatch(/^lemma\/HostControl\s+the host\s+agent$/);
    expect(rows.find((row) => row.startsWith("lemma/Paths"))).toMatch(/^lemma\/Paths\s+the host$/);
    expect(rows.find((row) => row.startsWith("lemma/Missing"))).toMatch(/^lemma\/Missing\s+NOTHING\s+agent$/);
  });
});
