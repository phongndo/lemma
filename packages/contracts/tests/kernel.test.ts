import { describe, expect, test } from "vitest";
import { capabilityName, hookChain, kernelOf, providerOf, recoverable, tablesOf, usersOf } from "../src/kernel.ts";
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
    const hosted = kernelOf([plugin("agent", { requires: ["lemma/Paths"] })], ["lemma/Paths", "lemma/api@1"]);
    expect(hosted.capabilities).toEqual([
      { key: "lemma/Paths", providers: [], runtime: true, users: ["agent"] },
      { key: "lemma/api@1", providers: [], runtime: true, users: [] },
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
