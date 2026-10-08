import { describe, expect, test } from "vitest";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { secret } from "@lemma/contracts";
import { definePlugin, PluginFault } from "@lemma/core";
import type { Composition, PluginSnapshot } from "@lemma/core";
import { catalog, faultHistory, resolveComposition, restartedBy, withReplacements } from "../src/catalog.ts";
import type { KnownPlugin } from "../src/catalog.ts";

class Llm extends Context.Service<Llm, string>()("test/Llm") {}
class Tools extends Context.Service<Tools, string>()("test/Tools") {}
class Agent extends Context.Service<Agent, string>()("test/Agent") {}
/** What the app provides itself, in the tests that pass `provided`: pages requires it, and a stray file's plugin offers it too. */
class Slots extends Context.Service<Slots, string>()("test/Slots") {}
const pages: KnownPlugin = { plugin: definePlugin({ id: "pages", requires: [Slots], layer: Layer.empty }), source: "bundled" };
const stray: KnownPlugin = { plugin: definePlugin({ id: "stray", provides: [Slots], layer: Layer.succeed(Slots, "stray") }), source: "user" };

/** transport needs agent, which needs llm and tools; bash (a project plugin shadowing the bundled one) plugs into tools; my-llm is a second Llm provider. */
const known: KnownPlugin[] = [
  { plugin: definePlugin({ id: "llm", version: "1", provides: [Llm], layer: Layer.succeed(Llm, "llm") }), source: "bundled" },
  { plugin: definePlugin({ id: "tools", version: "1", provides: [Tools], layer: Layer.succeed(Tools, "tools") }), source: "bundled" },
  { plugin: definePlugin({ id: "bash", requires: [Tools], layer: Layer.empty }), source: "project", shadows: true },
  { plugin: definePlugin({ id: "agent", version: "1", provides: [Agent], requires: [Llm, Tools], layer: Layer.succeed(Agent, "agent") }), source: "bundled" },
  { plugin: definePlugin({ id: "transport", requires: [Agent], layer: Layer.empty }), source: "bundled" },
  { plugin: definePlugin({ id: "my-llm", provides: [Llm], layer: Layer.succeed(Llm, "my-llm") }), source: "user" },
];

const everyone = (overrides: Composition["plugins"] = {}): Composition => ({
  plugins: Object.fromEntries(known.map(({ plugin }) => [plugin.id, overrides[plugin.id] ?? {}])),
});

describe("resolveComposition", () => {
  test("keeps everything when every requirement is met", () => {
    const composition = everyone({ "my-llm": { enabled: false } });
    const resolved = resolveComposition(known, composition);
    expect(resolved.haltedBy.size).toBe(0);
    expect(resolved.composition).toEqual(composition);
  });

  test("turning a provider off takes its dependents out, transitively, naming the direct one", () => {
    const resolved = resolveComposition(known, everyone({ "my-llm": { enabled: false }, tools: { enabled: false } }));
    expect([...resolved.haltedBy]).toEqual([
      ["bash", "tools"],
      ["agent", "tools"],
      ["transport", "agent"],
    ]);
    expect(Object.keys(resolved.composition.plugins)).toEqual(["llm", "tools", "my-llm"]);
    expect(resolved.composition.plugins.tools).toEqual({ enabled: false });
  });

  test("an enabled provider counts even when a disabled one offers the same capability", () => {
    const resolved = resolveComposition(known, everyone({ llm: { enabled: false } }));
    expect(resolved.haltedBy.size).toBe(0);
  });

  test("a capability nobody provides is left to the planner", () => {
    const orphan: KnownPlugin[] = [{ plugin: definePlugin({ id: "lonely", requires: [Agent], layer: Layer.empty }), source: "bundled" }];
    const resolved = resolveComposition(orphan, { plugins: { lonely: {} } });
    expect(resolved.haltedBy.size).toBe(0);
    expect(Object.keys(resolved.composition.plugins)).toEqual(["lonely"]);
  });

  test("a plugin offering what the app provides is nobody's provider: it is not locked, and halts nothing when off", () => {
    const withStray = [pages, stray];
    const rows: Composition = { plugins: { pages: {}, stray: { enabled: false } } };
    // Taken for the provider, it would be forced on for a pinned plugin, and turned off it would halt what requires it.
    expect(resolveComposition(withStray, rows, { pinned: ["pages"] }).overridden).toEqual(["stray"]);
    expect(resolveComposition(withStray, rows).haltedBy.get("pages")).toBe("stray");
    const pinned = resolveComposition(withStray, rows, { pinned: ["pages"], provided: [Slots] });
    expect([...pinned.locked]).toEqual([["pages", "pages"]]);
    expect(pinned.overridden).toEqual([]);
    expect(resolveComposition(withStray, rows, { provided: [Slots] }).haltedBy.size).toBe(0);
  });
});

describe("catalog", () => {
  const snapshot = (id: string, state: PluginSnapshot["state"], extra: Partial<PluginSnapshot> = {}): PluginSnapshot => ({
    id,
    state,
    provides: [],
    requires: [],
    ...extra,
  });

  test("joins definitions, config rows, and core snapshots, locking what a pinned plugin needs", () => {
    const composition = everyone({ "my-llm": { enabled: false }, bash: { enabled: false } });
    const resolved = resolveComposition(known, composition, { pinned: ["transport"] });
    const entries = catalog({
      known,
      composition,
      resolved,
      snapshots: [snapshot("llm", "active"), snapshot("tools", "active"), snapshot("agent", "failed"), snapshot("transport", "closed", { haltedBy: "agent" })],
      enabledIn: { bash: "project" },
      pinned: { transport: "Serves the clients" },
    });
    expect(entries.map((entry) => [entry.id, entry.enabled, entry.state ?? "-", entry.locked ?? "-", entry.haltedBy ?? "-"])).toEqual([
      ["llm", true, "active", "Needed by transport", "-"],
      ["tools", true, "active", "Needed by transport", "-"],
      ["bash", false, "-", "-", "-"],
      ["agent", true, "failed", "Needed by transport", "-"],
      ["transport", true, "closed", "Serves the clients", "agent"],
      ["my-llm", false, "-", "-", "-"],
    ]);
    expect(entries.find((entry) => entry.id === "bash")).toMatchObject({ source: "project", shadows: true, scope: "project", requires: ["test/Tools"] });
    expect(entries.find((entry) => entry.id === "agent")).toMatchObject({ version: "1", provides: ["test/Agent"], requires: ["test/Llm", "test/Tools"] });
    expect(entries.find((entry) => entry.id === "transport")?.version).toBeUndefined();
  });

  test("a pinned plugin keeps on what it needs, whatever the rows say, and reports the rows it overrode", () => {
    const resolved = resolveComposition(known, everyone({ "my-llm": { enabled: false }, tools: { enabled: false }, transport: { enabled: false } }), {
      pinned: ["transport"],
    });
    expect([...resolved.overridden].sort()).toEqual(["tools", "transport"]);
    expect(resolved.haltedBy.size).toBe(0);
    expect(Object.entries(resolved.composition.plugins).filter(([, row]) => row.enabled === false)).toEqual([["my-llm", { enabled: false }]]);
    expect([...resolved.locked]).toEqual([
      ["transport", "transport"],
      ["agent", "transport"],
      ["llm", "transport"],
      ["tools", "transport"],
    ]);
  });

  test("a plugin left out by a disabled provider is enabled, unloaded, and halted by that provider", () => {
    const composition = everyone({ "my-llm": { enabled: false }, tools: { enabled: false } });
    const resolved = resolveComposition(known, composition);
    const entries = catalog({ known, composition, resolved, snapshots: [snapshot("llm", "active")], enabledIn: {}, pinned: {} });
    expect(entries.find((entry) => entry.id === "agent")).toMatchObject({ enabled: true, haltedBy: "tools" });
    expect(entries.find((entry) => entry.id === "agent")?.state).toBeUndefined();
    expect(entries.find((entry) => entry.id === "transport")).toMatchObject({ enabled: true, haltedBy: "agent" });
    // Nothing is pinned, so nothing is locked.
    expect(entries.every((entry) => entry.locked === undefined)).toBe(true);
  });

  test("describes a plugin's config as a form with its current values, keeping secrets out", () => {
    const Config = Schema.Struct({
      port: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.sync(() => 7433))).annotate({ description: "Where it listens" }),
      token: Schema.optional(Schema.String).annotate(secret),
    });
    const server = definePlugin({ id: "server", config: Config, layer: () => Layer.empty });
    const withServer: KnownPlugin[] = [...known, { plugin: server, source: "bundled" }];
    const composition = { plugins: { ...everyone().plugins, server: { config: { port: 9000, token: "hunter2" } } } };
    const entries = catalog({
      known: withServer,
      composition,
      resolved: resolveComposition(withServer, composition),
      snapshots: [],
      enabledIn: {},
      configIn: { server: "project" },
      pinned: {},
    });
    const entry = entries.find((candidate) => candidate.id === "server")!;
    expect(entry.configFields?.map((field) => [field.key, field.type, field.secret ?? false])).toEqual([
      ["port", "number", false],
      ["token", "string", true],
    ]);
    expect(entry.config).toEqual({ values: { port: 9000 }, secretsSet: ["token"] });
    expect(entry.configScope).toBe("project");
    expect(JSON.stringify(entries)).not.toContain("hunter2");
    // A plugin without a config Schema has no form.
    expect(entries.find((candidate) => candidate.id === "llm")?.configFields).toBeUndefined();
  });
});

describe("withReplacements", () => {
  test("turning on a provider turns off the enabled provider of the same capability, leaving given rows alone", () => {
    const composition = everyone({ "my-llm": { enabled: false } });
    expect(withReplacements(known, composition, { "my-llm": { enabled: true } })).toEqual({ "my-llm": { enabled: true }, llm: { enabled: false } });
    // Already off, or explicitly listed: untouched.
    expect(withReplacements(known, everyone({ llm: { enabled: false } }), { "my-llm": { enabled: true } })).toEqual({ "my-llm": { enabled: true } });
    expect(withReplacements(known, composition, { "my-llm": { enabled: true }, llm: { enabled: true } })).toEqual({
      "my-llm": { enabled: true },
      llm: { enabled: true },
    });
    // Turning off, or a plugin providing nothing, replaces nothing.
    expect(withReplacements(known, composition, { llm: { enabled: false }, bash: { enabled: true } })).toEqual({
      llm: { enabled: false },
      bash: { enabled: true },
    });
  });
});

describe("wiring and faults", () => {
  test("lists the hooks a plugin intercepts, the events it observes, and its recent faults, newest first", () => {
    const composition = everyone();
    const history = faultHistory(2);
    const fault = (sequence: number, message: string) =>
      Object.assign(new PluginFault({ pluginId: "agent", phase: "observe", operation: "lemma/turn.ended", cause: Cause.fail(new Error(message)) }), {
        sequence,
      });
    history.record(fault(1, "one"), 10);
    history.record(fault(2, "two"), 20);
    history.record(fault(3, "three"), 30);
    const entries = catalog({
      known,
      composition,
      resolved: resolveComposition(known, composition),
      snapshots: [],
      hooks: [
        {
          name: "lemma/llm.request",
          handlers: [
            { pluginId: "tools", order: 0 },
            { pluginId: "agent", order: 10 },
          ],
        },
      ],
      events: [{ name: "lemma/turn.ended", observers: ["agent", "transport"] }],
      faults: history.get(),
      enabledIn: {},
      pinned: {},
    });
    const agent = entries.find((entry) => entry.id === "agent")!;
    expect(agent.hooks).toEqual([{ name: "lemma/llm.request", order: 10 }]);
    expect(agent.observes).toEqual(["lemma/turn.ended"]);
    expect(agent.faults?.map((record) => [record.sequence, record.at, record.message])).toEqual([
      [3, 30, 'Plugin "agent" failed during observe lemma/turn.ended: three'],
      [2, 20, 'Plugin "agent" failed during observe lemma/turn.ended: two'],
    ]);
    expect(entries.find((entry) => entry.id === "llm")).not.toHaveProperty("hooks");
  });
});

describe("restartedBy", () => {
  test("follows provided capabilities to every dependent, transitively", () => {
    expect([...restartedBy(known, ["tools"])].sort()).toEqual(["agent", "bash", "tools", "transport"]);
    expect([...restartedBy(known, ["bash"])]).toEqual(["bash"]);
    // A second provider of the same capability counts too: turning it on replaces the first.
    expect(restartedBy(known, ["my-llm"]).has("transport")).toBe(true);
  });

  test("a plugin offering what the app provides restarts nothing through it", () => {
    expect([...restartedBy([pages, stray], ["stray"])].sort()).toEqual(["pages", "stray"]);
    expect([...restartedBy([pages, stray], ["stray"], { provided: [Slots] })]).toEqual(["stray"]);
  });
});
