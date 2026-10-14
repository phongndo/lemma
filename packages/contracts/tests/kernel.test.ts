import { describe, expect, test } from "vitest";
import { capabilityName, hookChain, kernelOf, pluginWiring, providerOf, recoverable, tablesOf, usersOf } from "../src/kernel.ts";
import type { PluginStatus } from "../src/status.ts";

const plugin = (id: string, fields: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  source: "bundled",
  enabled: true,
  state: "active",
  provides: [],
  requires: [],
  ...fields,
});

describe("plugin wiring", () => {
  const plugins = [
    plugin("llm-off", { enabled: false, state: "disabled", provides: ["lemma/Llm"] }),
    plugin("llm", { provides: ["lemma/Llm"], hooks: [{ name: "turn.before", order: 0 }] }),
    plugin("agent", {
      requires: ["lemma/Llm"],
      hooks: [
        { name: "turn.before", order: 10 },
        { name: "turn.before", order: -5 },
      ],
    }),
  ];

  test("who provides a capability (the enabled one), who needs it, and what it is called", () => {
    expect(providerOf(plugins, "lemma/Llm")?.id).toBe("llm");
    expect(usersOf(plugins, "lemma/Llm")).toEqual(["agent"]);
    expect(capabilityName("lemma/Llm")).toBe("Llm");
  });

  test("a hook's handlers in run order, a plugin's several included", () => {
    expect(hookChain(plugins, "turn.before")).toEqual([
      { plugin: "agent", order: -5 },
      { plugin: "llm", order: 0 },
      { plugin: "agent", order: 10 },
    ]);
  });

  test("a hook's handlers by phase before order, where the hook declares phases", () => {
    const phased = [
      plugin("compaction", { hooks: [{ name: "agent.request", phase: "fit", rank: 1, order: -1_000 }] }),
      plugin("skills", { hooks: [{ name: "agent.request", phase: "shape", rank: 0, order: 1_000 }] }),
    ];
    expect(hookChain(phased, "agent.request")).toEqual([
      { plugin: "skills", phase: "shape", rank: 0, order: 1_000 },
      { plugin: "compaction", phase: "fit", rank: 1, order: -1_000 },
    ]);
    expect(kernelOf(phased, []).hooks[0]?.handlers.map((handler) => handler.plugin)).toEqual(["skills", "compaction"]);
  });

  test("a plugin's wiring in the five shapes: parts and channels apart from what it adds, each hook's place, each call's provider", () => {
    const wired = plugin("agent", {
      requires: ["lemma/Llm", "lemma/Paths"],
      provides: ["lemma/Agent"],
      hooks: [
        { name: "turn.before", order: 10 },
        { name: "turn.before", order: -5 },
      ],
      observes: ["turn.ended"],
      contributes: [
        { name: "lemma/tools", items: 1, keys: ["ask"] },
        { name: "part.chat.tool", items: 1, keys: ["agent.tool"] },
        { name: "lemma/channels", items: 2, keys: ["agent.prompt", "agent.events"] },
      ],
    });
    const all = [...plugins.filter((other) => other.id !== "agent"), wired, plugin("ui", { requires: ["lemma/Agent"] })];
    expect(pluginWiring(all, wired, ["lemma/Paths"])).toEqual({
      adds: [{ name: "lemma/tools", items: 1, keys: ["ask"] }],
      parts: [{ name: "part.chat.tool", items: 1, keys: ["agent.tool"] }],
      hooks: [
        { name: "turn.before", order: 10, position: 3, of: 3 },
        { name: "turn.before", order: -5, position: 1, of: 3 },
      ],
      observes: ["turn.ended"],
      calls: [
        { key: "lemma/Llm", providers: [all[1], all[0]], runtime: false },
        { key: "lemma/Paths", providers: [], runtime: true },
      ],
      serves: [{ key: "lemma/Agent", users: ["ui"] }],
      channels: ["agent.prompt", "agent.events"],
    });
  });

  test("each of a plugin's handlers of one hook at one phase and order has its own place", () => {
    const twice = plugin("twice", {
      hooks: [
        { name: "turn.before", order: 0 },
        { name: "turn.before", order: 0 },
      ],
    });
    const all = [plugin("alpha", { hooks: [{ name: "turn.before", order: 0 }] }), twice, plugin("zulu", { hooks: [{ name: "turn.before", order: 0 }] })];
    expect(pluginWiring(all, twice, []).hooks.map(({ position, of }) => `${position} of ${of}`)).toEqual(["2 of 4", "3 of 4"]);
  });

  test("a restart helps a failed plugin or one a failure halted", () => {
    expect(recoverable(plugin("a", { state: "failed" }))).toBe(true);
    expect(recoverable(plugin("a", { state: "closed", haltedBy: "llm" }))).toBe(true);
    expect(recoverable(plugin("a"))).toBe(false);
    expect(recoverable(plugin("a", { state: "disabled", haltedBy: "tools" }))).toBe(false);
  });
});

describe("kernelOf", () => {
  const plugins = [
    plugin("agent", { provides: ["lemma/Agent"], requires: ["lemma/Llm"], hooks: [{ name: "turn.before", order: 10 }], observes: ["tool.executed"] }),
    plugin("guard", { hooks: [{ name: "turn.before", order: -5 }], contributes: [{ name: "lemma/tools.guards", items: 1 }] }),
    plugin("tools", { contributes: [{ name: "lemma/tools", items: 2, keys: ["read", "write"] }], observes: ["tool.executed"] }),
    plugin("llm-off", { enabled: false, state: "disabled", provides: ["lemma/Llm"] }),
    plugin("orphan", { requires: ["lemma/Nothing"] }),
  ];
  const kernel = kernelOf(plugins, []);

  test("each hook's chain runs in order, lowest first", () => {
    expect(kernel.hooks).toEqual([
      {
        name: "turn.before",
        handlers: [
          { plugin: "guard", order: -5 },
          { plugin: "agent", order: 10 },
        ],
      },
    ]);
  });

  test("each registry lists its contributors and counts their items", () => {
    expect(kernel.registries).toEqual([
      { name: "lemma/tools", items: 2, contributors: [{ plugin: "tools", items: 2, keys: ["read", "write"] }] },
      { name: "lemma/tools.guards", items: 1, contributors: [{ plugin: "guard", items: 1, keys: [] }] },
    ]);
  });

  test("each event lists its observers; each capability its providers, in what state, and its dependents", () => {
    expect(kernel.events).toEqual([{ name: "tool.executed", observers: ["agent", "tools"] }]);
    expect(kernel.capabilities).toEqual([
      { key: "lemma/Agent", providers: [{ plugin: "agent", state: "active", enabled: true }], runtime: false, users: [] },
      { key: "lemma/Llm", providers: [{ plugin: "llm-off", state: "disabled", enabled: false }], runtime: false, users: ["agent"] },
      { key: "lemma/Nothing", providers: [], runtime: false, users: ["orphan"] },
    ]);
  });

  test("what the app provides itself is a capability with no plugin behind it, listed whether or not a plugin requires it", () => {
    const hosted = kernelOf([plugin("agent", { requires: ["lemma/Paths"] })], ["lemma/Paths", "lemma/api@2"]);
    expect(hosted.capabilities).toEqual([
      { key: "lemma/Paths", providers: [], runtime: true, users: ["agent"] },
      { key: "lemma/api@2", providers: [], runtime: true, users: [] },
    ]);
  });
});

describe("tablesOf", () => {
  test("an array of objects is a table; an object of such arrays is a table per key", () => {
    expect(
      tablesOf([
        { a: 1, b: "x" },
        { a: 2, c: true },
      ]),
    ).toEqual([
      {
        columns: ["a", "b", "c"],
        rows: [
          ["1", "x", ""],
          ["2", "", "true"],
        ],
      },
    ]);
    expect(tablesOf({ tools: [{ name: "read" }], guards: [] })).toEqual([
      { title: "tools", columns: ["name"], rows: [["read"]] },
      { title: "guards", columns: [], rows: [] },
    ]);
  });

  test("anything else is not tables, and shows as JSON", () => {
    expect(tablesOf({ count: 3 })).toBeUndefined();
    expect(tablesOf([1, 2])).toBeUndefined();
    expect(tablesOf("text")).toBeUndefined();
  });
});
