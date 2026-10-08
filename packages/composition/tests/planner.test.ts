import { describe, expect, test } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { HostApi } from "@lemma/contracts";
import { definePlugin } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { planComposition } from "../src/planner.ts";
import type { Plan, PlanInput } from "../src/planner.ts";

class Llm extends Context.Service<Llm, string>()("test/Llm") {}
class Agent extends Context.Service<Agent, string>()("test/Agent") {}
class Server extends Context.Service<Server, string>()("test/Server") {}
/** What the app provides itself, in the tests that pass `provided`. */
class Slots extends Context.Service<Slots, string>()("test/Slots") {}
class Clock extends Context.Service<Clock, string>()("test/Clock") {}

const llm = definePlugin({
  id: "llm",
  provides: [Llm],
  config: Schema.Struct({ model: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => "small"))) }),
  layer: Layer.succeed(Llm, "llm"),
});
const agent = definePlugin({
  id: "agent",
  provides: [Agent],
  requires: [Llm],
  config: Schema.Struct({ maxSteps: Schema.Int.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 10))), cli: Schema.optional(Schema.String) }),
  layer: Layer.succeed(Agent, "agent"),
});
const compaction = definePlugin({ id: "compaction", requires: [Agent], layer: Layer.empty });
const transport = definePlugin({
  id: "transport",
  provides: [Server],
  config: Schema.Struct({ port: Schema.Int.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 7433))), staticDir: Schema.optional(Schema.String) }),
  layer: Layer.succeed(Server, "server"),
});
const bundled: readonly Plugin[] = [llm, agent, compaction, transport];

/** As the host plans: the transport pinned, and the host API version provided by the app itself. */
const plan = (input: Partial<PlanInput> = {}): Plan =>
  planComposition({ bundled, local: [], rows: {}, pinned: ["transport"], provided: [HostApi(1)], ...input });
const running = (planned: Plan) =>
  Object.keys(planned.resolved.composition.plugins).filter((id) => planned.resolved.composition.plugins[id]?.enabled !== false);
const messages = (planned: Plan, severity: "error" | "warning") =>
  planned.diagnostics.filter((diagnostic) => diagnostic.severity === severity).map((diagnostic) => diagnostic.message);

describe("planComposition", () => {
  test("runs every known plugin, with app defaults beneath a row's config key by key", () => {
    const defaults = { transport: { staticDir: "/web" }, agent: { cli: "lemma" } };
    const planned = plan({ defaults, rows: { transport: { config: { port: 8000 } }, llm: { config: { model: "big" } } } });
    expect(running(planned)).toEqual(["llm", "agent", "compaction", "transport"]);
    expect(planned.composition.plugins).toMatchObject({
      transport: { config: { staticDir: "/web", port: 8000 } },
      agent: { config: { cli: "lemma" } },
      llm: { config: { model: "big" } },
    });
    // A row that turns a plugin off keeps its defaults, for when it comes back.
    expect(plan({ defaults, rows: { agent: { enabled: false } } }).composition.plugins.agent).toEqual({ enabled: false, config: { cli: "lemma" } });
    expect(planned.required).toEqual(["transport"]);
    expect(planned.diagnostics).toEqual([]);
  });

  test("a local plugin replaces a bundled one by id, or by providing what it provides unless a row decides", () => {
    const mine = definePlugin({ id: "my-llm", provides: [Llm], layer: Layer.succeed(Llm, "mine") });
    const replaced = plan({ local: [{ plugin: mine, source: "user" }] });
    expect(running(replaced)).toEqual(["agent", "compaction", "transport", "my-llm"]);
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
    class Canvas extends Context.Service<Canvas, string>()("test/Canvas") {}
    class Paint extends Context.Service<Paint, string>()("test/Paint") {}
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
    expect(running(planned)).toEqual(["llm", "transport"]);
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
    expect(needed.required).toEqual(["transport", "compaction"]);
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
    // Whichever versions the app provides are the ones that count, and a plugin requiring one needs no plugin for it.
    const appProvided = plan({
      provided: [HostApi(2)],
      local: [
        { plugin: later, source: "user" },
        { plugin: current, source: "user" },
      ],
    });
    expect(appProvided.problems.get("current")).toBe("it is written for version 1 of the lemma API, and this Lemma provides version 2");
    expect(running(appProvided)).toContain("later");
  });

  test("a plugin providing what the app provides is left out, even when a pinned plugin requires that", () => {
    const pages = definePlugin({ id: "pages", requires: [Slots], layer: Layer.empty });
    const stray = definePlugin({ id: "stray", provides: [Slots], layer: Layer.succeed(Slots, "stray") });
    const local = [{ plugin: stray, source: "user" as const }];
    // Pinned or not, what requires the app's capability runs, and the stray plugin is neither needed by it nor halts it.
    for (const pinsPages of [true, false]) {
      const planned = plan({ bundled: [...bundled, pages], local, pinned: ["transport", ...(pinsPages ? ["pages"] : [])], provided: [Slots] });
      expect(running(planned)).toContain("pages");
      expect(running(planned)).not.toContain("stray");
      expect(planned.diagnostics).toEqual([
        expect.objectContaining({
          severity: "warning",
          pluginId: "stray",
          message: `"stray" is left out: it provides "test/Slots", which the app provides itself`,
          suggestion: `Stop providing "test/Slots": the app provides it, or turn it off`,
        }),
      ]);
    }
    // Under localRequired (the host), a file's plugin must start, so it stops the start.
    const required = plan({ local, localRequired: true, provided: [Slots] });
    expect(required.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        pluginId: "stray",
        message: `"stray" cannot run, and it is required: it provides "test/Slots", which the app provides itself`,
        suggestion: `Stop providing "test/Slots": the app provides it, or set "required": false in its row to start without it`,
      }),
    ]);
  });

  test("a bundled plugin providing what the app provides is left out, and what requires that runs without it", () => {
    const current = definePlugin({ id: "current", requires: [HostApi(1)], layer: Layer.empty });
    const stale = definePlugin({ id: "stale-host", provides: [HostApi(1)], layer: Layer.succeed(HostApi(1), 1) });
    const planned = plan({ bundled: [...bundled, stale, current] });
    expect(running(planned)).toContain("current");
    expect(running(planned)).not.toContain("stale-host");
    expect(planned.problems.get("stale-host")).toBe(`it provides "lemma/api@1", which the app provides itself`);
    expect(messages(planned, "error")).toEqual([]);
  });

  test("what the app provides wrongly stops the start, naming no plugin, one error per problem", () => {
    const { diagnostics } = plan({ provided: [Slots, Slots, Clock, Clock] });
    expect(diagnostics.map(({ severity, pluginId, message }) => [severity, pluginId, message])).toEqual([
      ["error", undefined, `The application lists capability "test/Slots" more than once`],
      ["error", undefined, `The application lists capability "test/Clock" more than once`],
    ]);
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
    expect(running(planned)).toEqual(["transport"]);
    expect(planned.known.find((entry) => entry.plugin.id === "llm")?.plugin).toBe(shadow);
  });

  test("warns about config keys a plugin does not use, such as a setting renamed in an update", () => {
    const planned = plan({ rows: { agent: { config: { steps: 5, maxSteps: 3 } } } });
    expect(messages(planned, "warning")).toEqual([`The config for "agent" sets steps, which it does not use (renamed or removed?)`]);
    expect(running(planned)).toContain("agent");
  });
});
