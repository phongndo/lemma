import { describe, expect, it } from "vitest";
import type { SpanRecord } from "@lemma/contracts";
import { matcher, narrowedBy, parseQuery, turnOrder } from "../src/query.ts";
import { contains, flatten, forest, profile } from "../src/tree.ts";

const span = (id: string, name: string, attributes: SpanRecord["attributes"], extra: Partial<SpanRecord> = {}): SpanRecord => ({
  id,
  traceId: "t",
  name,
  start: 0,
  ms: 1,
  status: "ok",
  attributes,
  ...extra,
});

const turnA = span("ta", "agent.turn", { "session.id": "s-1234", "turn.id": "turn-a", "plugin.id": "agent.loop" }, { start: 0, ms: 2000 });
const turnB = span("tb", "agent.turn", { "session.id": "s-1234", "turn.id": "turn-b", "plugin.id": "agent.loop" }, { start: 2200, ms: 50 });
// Every span of a step's work carries its id and index, as the agent marks them.
const inStep = { "session.id": "s-1234", "turn.id": "turn-a", "step.id": "st-1", "step.index": 1 };
const step = span("st", "agent.step", { ...inStep, "plugin.id": "agent.loop" }, { parentId: "ta", start: 5, ms: 1500 });
const hook = span(
  "h",
  "core.hook",
  { ...inStep, "plugin.id": "context.compaction", "hook.name": "lemma/agent.request" },
  { parentId: "st", start: 10, ms: 30 },
);
const tool = span(
  "x",
  "tools.execute bash",
  { ...inStep, "tool.name": "bash", "tool.call.id": "call-9", "plugin.id": "tools.registry" },
  { parentId: "st", start: 50, ms: 40, status: "error", error: "exit 1" },
);
const spans = [hook, tool, step, turnA, turnB];

const shown = (text: string) => spans.filter(matcher(parseQuery(text), turnOrder(spans))).map((found) => found.id);

describe("the trace filter", () => {
  it("narrows by plugin (or a domain's), session, turn, step, tool, hook, name, status, and time", () => {
    expect(shown("plugin:tools")).toEqual(["x"]);
    expect(shown("plugin:context.compaction")).toEqual(["h"]);
    expect(shown("session:s-12")).toEqual(["h", "x", "st", "ta", "tb"]);
    expect(shown("turn:2")).toEqual(["tb"]);
    expect(shown("turn:turn-a")).toEqual(["h", "x", "st", "ta"]);
    // A step by its index or its id: the step and all its work.
    expect(shown("step:1")).toEqual(["h", "x", "st"]);
    expect(shown("step:st-1")).toEqual(["h", "x", "st"]);
    expect(shown("tool:bash")).toEqual(["x"]);
    expect(shown("tool:call-9")).toEqual(["x"]);
    expect(shown("hook:agent.request")).toEqual(["h"]);
    expect(shown("name:agent")).toEqual(["st", "ta", "tb"]);
    expect(shown("status:error")).toEqual(["x"]);
    expect(shown("slow:>35ms")).toEqual(["x", "st", "ta", "tb"]);
    // In seconds, as the panel shows a long span's time.
    expect(shown("slow:>1s")).toEqual(["st", "ta"]);
    expect(shown("slow:>=1.6s")).toEqual(["ta"]);
  });

  it("negates a word with -, matches any other word in names, statuses, and values, and needs every word", () => {
    expect(shown("-plugin:tools turn:1")).toEqual(["h", "st", "ta"]);
    expect(shown("compaction")).toEqual(["h"]);
    expect(shown("error")).toEqual(["x"]);
    expect(shown("turn:1 slow:35")).toEqual(["x", "st", "ta"]);
    expect(shown("")).toEqual(["h", "x", "st", "ta", "tb"]);
  });

  it("narrows a filter by a word in place of one with the same key", () => {
    expect(narrowedBy("turn:2 plugin:tools", "plugin", "agent.loop")).toBe("turn:2 plugin:agent.loop");
    expect(narrowedBy("", "plugin", "agent.loop")).toBe("plugin:agent.loop");
  });
});

describe("the trace's trees", () => {
  it("hangs each span under its parent, roots by start, and counts each one's own time and size", () => {
    const roots = forest(spans);
    expect(roots.map((root) => [root.span.id, root.size])).toEqual([
      ["ta", 4],
      ["tb", 1],
    ]);
    expect(flatten(roots[0]!).map(({ node, depth }) => [node.span.id, depth])).toEqual([
      ["ta", 0],
      ["st", 1],
      ["h", 2],
      ["x", 2],
    ]);
    expect([roots[0]!.self, roots[0]!.children[0]!.self]).toEqual([500, 1430]);
    expect(contains(roots[0]!, (found) => found.status === "error")).toBe(true);
    expect(contains(roots[1]!, (found) => found.status === "error")).toBe(false);
  });

  it("profiles each plugin by its own time in the whole trace, whatever the filter leaves out", () => {
    expect(profile(forest(spans)).map((row) => [row.plugin, row.spans, row.self, row.total])).toEqual([
      ["agent.loop", 3, 1430 + 500 + 50, 1500 + 2000 + 50],
      ["tools.registry", 1, 40, 40],
      ["context.compaction", 1, 30, 30],
    ]);
    // The step's children do not match, but are still not its own time.
    const step1 = matcher(parseQuery("name:agent.step"), turnOrder(spans));
    expect(profile(forest(spans), step1)).toEqual([
      { plugin: "agent.loop", spans: 1, total: 1500, self: 1430, p95: 1500, max: 1500, slowest: "agent.step", errors: 0 },
    ]);
  });

  it("takes p95 by nearest rank", () => {
    const of = (times: readonly number[]) =>
      profile(forest(times.map((ms, index) => span(`s${index}`, "work", { "plugin.id": "p" }, { start: index, ms }))))[0]!.p95;
    // Twenty spans: the slowest is the one in twenty above it.
    expect(of([...Array.from({ length: 19 }, () => 1), 800])).toBe(1);
    expect(of(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
  });
});
