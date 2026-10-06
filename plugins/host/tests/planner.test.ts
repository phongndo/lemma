import { describe, expect, test } from "vitest";
import { Context, Layer, Schema } from "effect";
import { HostApi } from "@lemma/contracts";
import { definePlugin } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { planComposition } from "../src/index.ts";
import type { Plan, PlanInput } from "../src/index.ts";

class Llm extends Context.Tag("test/Llm")<Llm, string>() {}
class Agent extends Context.Tag("test/Agent")<Agent, string>() {}
class Server extends Context.Tag("test/Server")<Server, string>() {}

const host = definePlugin({ id: "host", provides: [HostApi(1)], layer: Layer.succeed(HostApi(1), 1) });
const llm = definePlugin({
  id: "llm",
  provides: [Llm],
  config: Schema.Struct({ model: Schema.optionalWith(Schema.String, { default: () => "small" }) }),
  layer: Layer.succeed(Llm, "llm"),
});
const agent = definePlugin({
  id: "agent",
  provides: [Agent],
  requires: [Llm],
  config: Schema.Struct({ maxSteps: Schema.optionalWith(Schema.Int, { default: () => 10 }), cli: Schema.optional(Schema.String) }),
  layer: Layer.succeed(Agent, "agent"),
});
const compaction = definePlugin({ id: "compaction", requires: [Agent], layer: Layer.empty });
const transport = definePlugin({
  id: "transport",
  provides: [Server],
  config: Schema.Struct({ port: Schema.optionalWith(Schema.Int, { default: () => 7433 }), staticDir: Schema.optional(Schema.String) }),
  layer: Layer.succeed(Server, "server"),
});
const bundled: readonly Plugin[] = [host, llm, agent, compaction, transport];

const plan = (input: Partial<PlanInput> = {}): Plan => planComposition({ bundled, local: [], rows: {}, pinned: ["host", "transport"], ...input });
const running = (planned: Plan) =>
  Object.keys(planned.resolved.composition.plugins).filter((id) => planned.resolved.composition.plugins[id]?.enabled !== false);
const messages = (planned: Plan, severity: "error" | "warning") =>
  planned.diagnostics.filter((diagnostic) => diagnostic.severity === severity).map((diagnostic) => diagnostic.message);

describe("planComposition", () => {
  test("runs every known plugin, with app defaults beneath a row's config key by key", () => {
    const defaults = { transport: { staticDir: "/web" }, agent: { cli: "lemma" } };
    const planned = plan({ defaults, rows: { transport: { config: { port: 8000 } }, llm: { config: { model: "big" } } } });
    expect(running(planned)).toEqual(["host", "llm", "agent", "compaction", "transport"]);
    expect(planned.composition.plugins).toMatchObject({
      transport: { config: { staticDir: "/web", port: 8000 } },
      agent: { config: { cli: "lemma" } },
      llm: { config: { model: "big" } },
    });
    // A row that turns a plugin off keeps its defaults, for when it comes back.
    expect(plan({ defaults, rows: { agent: { enabled: false } } }).composition.plugins.agent).toEqual({ enabled: false, config: { cli: "lemma" } });
    expect(planned.required).toEqual(["host", "transport"]);
    expect(planned.diagnostics).toEqual([]);
  });

  test("a local plugin replaces a bundled one by id, or by providing what it provides unless a row decides", () => {
    const mine = definePlugin({ id: "my-llm", provides: [Llm], layer: Layer.succeed(Llm, "mine") });
    const replaced = plan({ local: [{ plugin: mine, source: "user" }] });
    expect(running(replaced)).toEqual(["host", "agent", "compaction", "transport", "my-llm"]);
    expect(replaced.composition.plugins.llm).toMatchObject({ enabled: false });
    expect(plan({ local: [{ plugin: mine, source: "user" }], rows: { "my-llm": { enabled: false } } }).composition.plugins.llm?.enabled).toBeUndefined();
    const shadow = definePlugin({ id: "llm", provides: [Llm], layer: Layer.succeed(Llm, "shadow") });
    const shadowed = plan({ local: [{ plugin: shadow, source: "project" }] });
    expect(shadowed.known.find((entry) => entry.plugin.id === "llm")).toMatchObject({ plugin: shadow, source: "project", shadows: true });
  });

  test("ignores a row naming no plugin, unless it is required", () => {
    const planned = plan({ rows: { renamed: { config: { x: 1 } } } });
    expect(messages(planned, "warning")).toEqual([`The row for "renamed" names no plugin; it is ignored`]);
    expect(messages(plan({ rows: { renamed: { required: true } } }), "error")).toEqual([`"renamed" is required, but no plugin has that id`]);
  });

  test("a required plugin that a row leaves unable to load is an error, not a warning", () => {
    // `compaction` needs `agent`, which a row turns off: required, it must not quietly stay unloaded.
    const halted = plan({ rows: { compaction: { required: true }, agent: { enabled: false } } });
    expect(messages(halted, "error")).toEqual([`"compaction" is required, but it is not loaded: it needs "agent", and "agent" is turned off`]);
    expect(messages(halted, "warning")).toEqual([]);
    // Under localRequired, a file's plugin is required too.
    const mine = definePlugin({ id: "mine", requires: [Agent], layer: Layer.empty });
    expect(messages(plan({ local: [{ plugin: mine, source: "user" }], localRequired: true, rows: { agent: { enabled: false } } }), "error")).toEqual([
      `"mine" is required, but it is not loaded: it needs "agent", and "agent" is turned off`,
    ]);
  });

  test("a required bundled plugin is not turned off by a file's plugin providing what it provides", () => {
    const mine = definePlugin({ id: "my-agent", requires: [Llm], provides: [Agent], layer: Layer.succeed(Agent, "mine") });
    const planned = plan({ local: [{ plugin: mine, source: "user" }], rows: { agent: { required: true } } });
    // Both stay on, so the conflict is the planner's to report: the replacement is left out and the required one runs.
    expect(running(planned)).toContain("agent");
    expect(planned.problems.get("my-agent")).toBe(`it provides "test/Agent", as "agent" and "my-agent" both do`);
  });

  test("suggests what fits the problem, not what its wording resembles", () => {
    const suggestion = (planned: Plan, id: string) => planned.diagnostics.find((diagnostic) => diagnostic.pluginId === id)?.suggestion;
    const mine = definePlugin({ id: "my-agent", requires: [Llm], provides: [Agent], layer: Layer.succeed(Agent, "mine") });
    expect(suggestion(plan({ local: [{ plugin: mine, source: "user" }], rows: { agent: { required: true } } }), "my-agent")).toBe("Turn one of them off");
    // A cycle through "canvas" reads "canvas -> paint", with the "as " the duplicate's "as … both do" has.
    class Canvas extends Context.Tag("test/Canvas")<Canvas, string>() {}
    class Paint extends Context.Tag("test/Paint")<Paint, string>() {}
    const canvas = definePlugin({ id: "canvas", requires: [Paint], provides: [Canvas], layer: Layer.succeed(Canvas, "canvas") });
    const paint = definePlugin({ id: "paint", requires: [Canvas], provides: [Paint], layer: Layer.succeed(Paint, "paint") });
    const planned = plan({ local: [canvas, paint].map((plugin) => ({ plugin, source: "user" as const })) });
    const [id, problem] = [...planned.problems][0]!;
    expect(problem).toMatch(/canvas -> /);
    expect(suggestion(planned, id)).toBe("Fix the plugin, or turn it off");
  });

  test("keeps a pinned plugin on whatever its row says, and says the row is ignored", () => {
    const planned = plan({ rows: { transport: { enabled: false } } });
    expect(running(planned)).toContain("transport");
    expect(messages(planned, "warning")).toEqual([`The row turning "transport" off is ignored: the app cannot run without it`]);
  });

  test("leaves out a plugin whose config does not decode, with what needs it, and runs the rest", () => {
    const planned = plan({ rows: { agent: { config: { maxSteps: "many" } } } });
    expect(running(planned)).toEqual(["host", "llm", "transport"]);
    expect(planned.composition.plugins.agent?.enabled).toBeUndefined();
    expect(planned.problems.get("agent")).toMatch(/^its config is invalid at maxSteps: Expected/);
    expect(planned.resolved.haltedBy.get("compaction")).toBe("agent");
    expect(messages(planned, "warning")).toEqual([
      expect.stringMatching(/^"agent" is left out: its config is invalid at maxSteps/),
      `"compaction" is not loaded: it needs "agent", and "agent" is left out`,
    ]);
    expect(messages(planned, "error")).toEqual([]);
  });

  test("a required plugin that cannot run, or one it needs, is an error rather than left out", () => {
    expect(messages(plan({ rows: { transport: { config: { port: "x" } } } }), "error")).toEqual([
      expect.stringMatching(/^"transport" cannot run, and the app cannot run without it: its config is invalid at port/),
    ]);
    const needed = plan({ rows: { compaction: { required: true }, llm: { config: { model: 5 } } } });
    expect(messages(needed, "error")).toEqual([expect.stringMatching(/^"llm" cannot run, and a required plugin needs it/)]);
    expect(needed.required).toEqual(["host", "transport", "compaction"]);
  });

  test("a plugin from a file is required under localRequired, unless its row says otherwise", () => {
    const mine = definePlugin({ id: "approvals", config: Schema.Struct({ ask: Schema.Array(Schema.String) }), layer: Layer.empty });
    const local = [{ plugin: mine, source: "user" as const }];
    const strict = plan({ local, localRequired: true, rows: { approvals: { config: { ask: "bash" } } } });
    expect(strict.diagnostics.find((diagnostic) => diagnostic.severity === "error")).toMatchObject({
      pluginId: "approvals",
      suggestion: `Fix it, or set "required": false in its row to start without it`,
    });
    const optional = plan({ local, localRequired: true, rows: { approvals: { required: false, config: { ask: "bash" } } } });
    expect(messages(optional, "error")).toEqual([]);
    expect(optional.problems.has("approvals")).toBe(true);
    // Without localRequired (the web app), a file's plugin is left out like any other.
    expect(messages(plan({ local, rows: { approvals: { config: { ask: "bash" } } } }), "error")).toEqual([]);
  });

  test("a plugin written for an API version nobody provides is left out with the version named", () => {
    const later = definePlugin({ id: "later", requires: [HostApi(2)], layer: Layer.empty });
    const current = definePlugin({ id: "current", requires: [HostApi(1)], layer: Layer.empty });
    const planned = plan({
      local: [
        { plugin: later, source: "user" },
        { plugin: current, source: "user" },
      ],
    });
    expect(planned.problems.get("later")).toBe("it is written for version 2 of the lemma API, and this Lemma provides version 1");
    expect(running(planned)).toContain("current");
  });

  test("of two plugins providing one capability, leaves out the replacement rather than the bundled one", () => {
    const mine = definePlugin({ id: "my-llm", provides: [Llm], layer: Layer.succeed(Llm, "mine") });
    // A row keeping the bundled one on leaves both on: the replacement is left out.
    const planned = plan({ local: [{ plugin: mine, source: "user" }], rows: { llm: { enabled: true } } });
    expect(running(planned)).toContain("llm");
    expect(planned.problems.get("my-llm")).toBe(`it provides "test/Llm", as "llm" and "my-llm" both do`);
  });

  test("a replacement left out is not swapped back for the bundled plugin it replaced", () => {
    const shadow = definePlugin({ id: "llm", provides: [Llm], config: Schema.Struct({ key: Schema.String }), layer: Layer.succeed(Llm, "shadow") });
    const planned = plan({ local: [{ plugin: shadow, source: "user" }] });
    expect(planned.problems.get("llm")).toMatch(/its config is invalid/);
    expect(running(planned)).toEqual(["host", "transport"]);
    expect(planned.known.find((entry) => entry.plugin.id === "llm")?.plugin).toBe(shadow);
  });

  test("warns about config keys a plugin does not use, such as a setting renamed in an update", () => {
    const planned = plan({ rows: { agent: { config: { steps: 5, maxSteps: 3 } } } });
    expect(messages(planned, "warning")).toEqual([`The config for "agent" sets steps, which it does not use (renamed or removed?)`]);
    expect(running(planned)).toContain("agent");
  });
});
