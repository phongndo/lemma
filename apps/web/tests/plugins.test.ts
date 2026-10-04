import { describe, expect, it } from "vitest";
import type { PluginStatus } from "@lemma/contracts";
import {
  dependentsOf,
  describeReload,
  describeState,
  matchPlugins,
  pluginGroups,
  pluginText,
  providerOf,
  recoverable,
  replaces,
  requiredBy,
  usersOf,
  waitingOn,
} from "../src/model/plugins.ts";

const plugin = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  source: "bundled",
  enabled: true,
  provides: [],
  requires: [],
  state: "active",
  ...extra,
});

// transport needs agent, agent needs llm and tools, bash and edit plug into tools.
const plugins: PluginStatus[] = [
  plugin("llm", { provides: ["lemma/Llm"], locked: "Needed by transport" }),
  plugin("tools", { provides: ["lemma/Tools"] }),
  plugin("bash", { requires: ["lemma/Tools"] }),
  plugin("edit", { requires: ["lemma/Tools"], enabled: false, state: "disabled", scope: "user" }),
  plugin("agent", { provides: ["lemma/Agent"], requires: ["lemma/Llm", "lemma/Tools"] }),
  plugin("transport", { requires: ["lemma/Agent"], locked: "Serves the clients" }),
  plugin("notes", { source: "user", requires: ["lemma/Tools"], state: "failed", fault: { phase: "activate", message: "boom" } }),
];

describe("pluginGroups", () => {
  it("groups by source in a fixed order and drops empty groups", () => {
    expect(pluginGroups(plugins).map((group) => [group.title, group.plugins.map((plugin) => plugin.id)])).toEqual([
      ["Bundled", ["llm", "tools", "bash", "edit", "agent", "transport"]],
      ["Your plugins", ["notes"]],
    ]);
  });
});

describe("dependentsOf", () => {
  it("follows provided capabilities through running plugins only, nearest first", () => {
    expect(dependentsOf(plugins, "tools")).toEqual(["bash", "agent", "notes", "transport"]);
    expect(dependentsOf(plugins, "llm")).toEqual(["agent", "transport"]);
    expect(dependentsOf(plugins, "bash")).toEqual([]);
  });
});

describe("requiredBy and replaces", () => {
  it("lists direct dependents whether or not they run, unlike dependentsOf", () => {
    expect(requiredBy(plugins, "tools")).toEqual(["bash", "edit", "agent", "notes"]);
    expect(dependentsOf(plugins, "tools")).not.toContain("edit");
    expect(requiredBy(plugins, "bash")).toEqual([]);
  });

  it("names the enabled providers a plugin replaces when turned on", () => {
    const withAlternative = [...plugins, plugin("my-llm", { source: "user", provides: ["lemma/Llm"], enabled: false, state: "disabled" })];
    expect(replaces(withAlternative, "my-llm")).toEqual(["llm"]);
    expect(replaces(withAlternative, "llm")).toEqual([]);
    expect(replaces(withAlternative, "bash")).toEqual([]);
  });
});

describe("waitingOn", () => {
  it("lists enabled plugins left unloaded by an off plugin, transitively", () => {
    const off = [
      plugin("tools", { provides: ["lemma/Tools"], enabled: false, state: "disabled" }),
      plugin("agent", { provides: ["lemma/Agent"], requires: ["lemma/Tools"], state: "disabled", haltedBy: "tools" }),
      plugin("transport", { requires: ["lemma/Agent"], state: "disabled", haltedBy: "agent" }),
      plugin("edit", { requires: ["lemma/Tools"], enabled: false, state: "disabled" }),
    ];
    expect(waitingOn(off, "tools")).toEqual(["agent", "transport"]);
  });
});

describe("describeState and recoverable", () => {
  it("names the state or the reason the plugin is not running", () => {
    expect(describeState(plugin("a"))).toBe("Running");
    expect(describeState(plugin("a", { enabled: false, state: "disabled" }))).toBe("Off");
    expect(describeState(plugin("a", { state: "disabled", haltedBy: "tools" }))).toBe("Needs tools");
    expect(describeState(plugin("a", { state: "closed", haltedBy: "llm" }))).toBe("Halted by llm");
    expect(describeState(plugin("a", { state: "failed" }))).toBe("Failed");
    expect(recoverable(plugin("a", { state: "failed" }))).toBe(true);
    expect(recoverable(plugin("a", { state: "closed", haltedBy: "llm" }))).toBe(true);
    expect(recoverable(plugin("a"))).toBe(false);
    expect(recoverable(plugin("a", { state: "disabled", haltedBy: "tools" }))).toBe(false);
  });
});

describe("pluginText", () => {
  it("matches on capabilities, source, and on/off words", () => {
    const text = pluginText(plugins[3]!);
    expect(text).toContain("Tools");
    expect(text).toContain("off");
    expect(pluginText(plugins[6]!)).toContain("boom");
    expect(pluginText(plugins[6]!)).toContain("user");
  });
});

describe("matchPlugins", () => {
  const entries = [
    ...plugins.map((plugin) => ({ kind: "host" as const, plugin })),
    { kind: "web" as const, plugin: plugin("composer", { configFields: [{ key: "x", title: "X", type: "string", optional: true }] }) },
  ];
  const ids = (query: string) => matchPlugins(entries, query).map((entry) => entry.plugin.id);

  it("filters by state, kind, and source, and by words", () => {
    expect(ids("is:failed")).toEqual(["notes"]);
    expect(ids("is:off")).toEqual(["edit"]);
    expect(ids("kind:web")).toEqual(["composer"]);
    expect(ids("source:user")).toEqual(["notes"]);
    expect(ids("is:configurable")).toEqual(["composer"]);
    expect(ids("tools kind:host -is:locked")).toEqual(["tools", "bash", "edit", "agent", "notes"]);
    expect(ids("")).toHaveLength(entries.length);
  });

  it("an unknown state matches nothing", () => {
    expect(ids("is:sleepy")).toEqual([]);
  });
});

describe("providerOf and usersOf", () => {
  it("find who provides a capability and who needs it", () => {
    expect(providerOf(plugins, "lemma/Tools")?.id).toBe("tools");
    expect(usersOf(plugins, "lemma/Tools")).toEqual(["bash", "edit", "agent", "notes"]);
  });
});

describe("describeReload", () => {
  it("names what changed, failures included, leaving out the plugin the message already names", () => {
    expect(describeReload({ started: ["a"], restarted: ["b", "c"], stopped: [], failed: ["d"] }, "c")).toBe("started a; restarted b; failed d");
    expect(describeReload({ started: [], restarted: [], stopped: [] })).toBe("nothing changed");
  });
});
