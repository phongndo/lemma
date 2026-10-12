import { describe, expect, it } from "vitest";
import type { PluginStatus } from "@lemma/contracts";
import {
  dependentsOf,
  describeState,
  domainOf,
  groupPlugins,
  matchPlugins,
  pairHalves,
  pluginText,
  replaces,
  summarizeDomain,
  waitingOn,
} from "../src/plugins.ts";

const plugin = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  source: "bundled",
  enabled: true,
  provides: [],
  requires: [],
  state: "active",
  ...extra,
});

// gateway needs agent, agent needs llm and tools, bash and edit plug into tools.
const plugins: PluginStatus[] = [
  plugin("llm", { provides: ["lemma/Llm"], locked: "Needed by gateway" }),
  plugin("tools", { provides: ["lemma/Tools"] }),
  plugin("bash", { requires: ["lemma/Tools"] }),
  plugin("edit", { requires: ["lemma/Tools"], enabled: false, state: "disabled", scope: "user" }),
  plugin("agent", { provides: ["lemma/Agent"], requires: ["lemma/Llm", "lemma/Tools"] }),
  plugin("gateway", { requires: ["lemma/Agent"], locked: "Serves the clients" }),
  plugin("notes", { source: "user", requires: ["lemma/Tools"], state: "failed", fault: { phase: "activate", message: "boom" } }),
];

describe("dependentsOf", () => {
  it("follows provided capabilities through running plugins only, nearest first", () => {
    expect(dependentsOf(plugins, "tools")).toEqual(["bash", "agent", "notes", "gateway"]);
    expect(dependentsOf(plugins, "llm")).toEqual(["agent", "gateway"]);
    expect(dependentsOf(plugins, "bash")).toEqual([]);
  });
});

describe("replaces", () => {
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
      plugin("gateway", { requires: ["lemma/Agent"], state: "disabled", haltedBy: "agent" }),
      plugin("edit", { requires: ["lemma/Tools"], enabled: false, state: "disabled" }),
    ];
    expect(waitingOn(off, "tools")).toEqual(["agent", "gateway"]);
  });
});

describe("describeState", () => {
  it("names the state or the reason the plugin is not running", () => {
    expect(describeState(plugin("a"))).toBe("Running");
    expect(describeState(plugin("a", { enabled: false, state: "disabled" }))).toBe("Off");
    expect(describeState(plugin("a", { state: "disabled", haltedBy: "tools" }))).toBe("Needs tools");
    expect(describeState(plugin("a", { state: "disabled", problem: "its config is invalid at x: Expected number" }))).toBe("Left out");
    expect(describeState(plugin("a", { state: "closed", haltedBy: "llm" }))).toBe("Halted by llm");
    expect(describeState(plugin("a", { state: "failed" }))).toBe("Failed");
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

describe("groupPlugins", () => {
  const entries = pairHalves(
    [plugin("tools.bash"), plugin("agent.loop"), plugin("tools.read", { enabled: false, state: "disabled" }), plugin("todo", { source: "user" })],
    [plugin("tools.bash"), plugin("threads.view"), plugin("threads.client", { state: "failed" }), plugin("threads.composer", { state: "activating" })],
  );

  it("groups the plugins by domain, by name, each domain's by id, then those in no domain", () => {
    const groups = groupPlugins(entries);
    expect(groups.map((group) => [group.domain, group.entries.map((entry) => entry.plugin.id)])).toEqual([
      ["agent", ["agent.loop"]],
      ["threads", ["threads.client", "threads.composer", "threads.view"]],
      ["tools", ["tools.bash", "tools.read"]],
      ["", ["todo"]],
    ]);
    // Both halves of a plugin are one entry in its domain.
    expect(groups[2]!.entries[0]!.pair?.kind).toBe("web");
  });

  it("folds a domain into one line: the halves its plugins have, and what is not running, the worst first", () => {
    const [agent, threads, tools] = groupPlugins(entries);
    expect(summarizeDomain(agent!)).toEqual({ kinds: "host", state: "Running", tone: "active", yours: 0 });
    expect(summarizeDomain(threads!)).toEqual({ kinds: "web", state: "1 failed · 1 not running", tone: "failed", yours: 0 });
    expect(summarizeDomain(tools!)).toEqual({ kinds: "host, web", state: "1 off", tone: "disabled", yours: 0 });
    // A plugin whose web half is off counts as off, as its row shows it, and the user's own are counted.
    const [mixed] = groupPlugins(
      pairHalves([plugin("notes.board", { source: "user" })], [plugin("notes.board", { enabled: false, state: "disabled", source: "user" })]),
    );
    expect(summarizeDomain(mixed!)).toEqual({ kinds: "host, web", state: "1 off", tone: "disabled", yours: 1 });
  });

  it("filters by domain", () => {
    expect(matchPlugins(entries, "domain:tools").map((entry) => entry.plugin.id)).toEqual(["tools.bash", "tools.read"]);
    expect([domainOf("tools.bash"), domainOf("todo"), domainOf(".hidden")]).toEqual(["tools", undefined, undefined]);
  });
});
