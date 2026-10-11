import { describe, expect, it } from "vitest";
import type { SpanRecord } from "@lemma/contracts";
import { matcher, parseQuery, turnOrder } from "../src/query.ts";
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

const turnA = span("ta", "agent.turn", { "session.id": "s-1234", "turn.id": "turn-a" }, { start: 0, ms: 100 });
const turnB = span("tb", "agent.turn", { "session.id": "s-1234", "turn.id": "turn-b" }, { start: 200, ms: 50 });
const hook = span(
  "h",
  "core.hook",
  { "session.id": "s-1234", "turn.id": "turn-a", "step.id": "st-1", "step.index": 1, "plugin.id": "context.compaction", "hook.name": "lemma/agent.request" },
  { parentId: "ta", start: 10, ms: 30 },
);
const tool = span(
  "x",
  "tools.execute bash",
  { "session.id": "s-1234", "turn.id": "turn-a", "tool.name": "bash", "tool.call.id": "call-9", "plugin.id": "tools.registry" },
  { parentId: "ta", start: 50, ms: 40, status: "error", error: "exit 1" },
);
const spans = [hook, tool, turnA, turnB];

const shown = (text: string) => spans.filter(matcher(parseQuery(text), turnOrder(spans))).map((found) => found.id);

describe("the trace filter", () => {
  it("narrows by plugin (or a domain's), session, turn, step, tool, hook, name, status, and time", () => {
    expect(shown("plugin:tools")).toEqual(["x"]);
    expect(shown("plugin:context.compaction")).toEqual(["h"]);
    expect(shown("session:s-12")).toEqual(["h", "x", "ta", "tb"]);
    expect(shown("turn:2")).toEqual(["tb"]);
    expect(shown("turn:turn-a")).toEqual(["h", "x", "ta"]);
    expect(shown("step:1")).toEqual(["h"]);
    expect(shown("tool:bash")).toEqual(["x"]);
    expect(shown("tool:call-9")).toEqual(["x"]);
    expect(shown("hook:agent.request")).toEqual(["h"]);
    expect(shown("name:agent")).toEqual(["ta", "tb"]);
    expect(shown("status:error")).toEqual(["x"]);
    expect(shown("slow:>35ms")).toEqual(["x", "ta", "tb"]);
  });

  it("negates a word with -, matches any other word in names and values, and needs every word", () => {
    expect(shown("-plugin:tools turn:1")).toEqual(["h", "ta"]);
    expect(shown("compaction")).toEqual(["h"]);
    expect(shown("turn:1 slow:35")).toEqual(["x", "ta"]);
    expect(shown("")).toEqual(["h", "x", "ta", "tb"]);
  });
});

describe("the trace's trees", () => {
  it("hangs each span under its parent, roots by start, and counts each one's own time", () => {
    const roots = forest(spans);
    expect(roots.map((root) => root.span.id)).toEqual(["ta", "tb"]);
    expect(flatten(roots[0]!).map(({ node, depth }) => [node.span.id, depth])).toEqual([
      ["ta", 0],
      ["h", 1],
      ["x", 1],
    ]);
    expect(roots[0]!.self).toBe(30);
    expect(contains(roots[0]!, (found) => found.status === "error")).toBe(true);
    expect(contains(roots[1]!, (found) => found.status === "error")).toBe(false);
  });

  it("profiles each plugin by its own time", () => {
    expect(profile(forest(spans))).toEqual([
      { plugin: "tools.registry", spans: 1, total: 40, self: 40, p95: 40, max: 40, slowest: "tools.execute bash", errors: 1 },
      { plugin: "context.compaction", spans: 1, total: 30, self: 30, p95: 30, max: 30, slowest: "core.hook", errors: 0 },
    ]);
  });
});
