import { describe, expect, test } from "vitest";
import { kernelOf } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";
import { formatCapabilities, formatChannels, formatHooks, formatPlugin, formatPlugins, formatReload, formatStatus } from "../src/format.ts";

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
    expect(formatReload({ ...report, restarted: [], deferred: true })).toBe("applying: the host restarts the transport, so clients reconnect");
    expect(formatReload({ ...report, restarted: [], deferred: true }, "the plugins the reload changes, the transport among them")).toBe(
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

describe("a hook with phases", () => {
  const base = { version: "1", source: "bundled" as const, enabled: true, state: "active" as const, provides: [], requires: [] };
  // A handler late in `shape`, by its order, runs before compaction early in `fit`.
  const plugins: PluginStatus[] = [
    { ...base, id: "compaction", hooks: [{ name: "agent.request", phase: "fit", rank: 1, order: -5 }] },
    { ...base, id: "zzz", hooks: [{ name: "agent.request", phase: "shape", rank: 0, order: 1000 }] },
  ];

  test("each chain names each handler's phase, in run order", () => {
    expect(formatHooks(kernelOf(plugins, []))).toBe("agent.request\n  1.  zzz         shape · order 1000\n  2.  compaction  fit · order -5");
  });

  test("a plugin's place in a chain is by phase", () => {
    expect(formatPlugin(plugins, plugins[0]!, [])).toContain("  agent.request  fit · order -5, 2 of 2");
  });
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

describe("formatStatus", () => {
  const info = { version: "0.1.0", cwd: "/work", home: "/home/me/.lemma", composition: { id: "abcdef0123456789", plugins: [] }, runtime: [] };
  const local = { url: "http://127.0.0.1:4100", token: "t", source: "local" as const, name: "local", from: "/home/me/.lemma/transport.json" };

  test("says where the host runs, who started it, what it is doing, and who is attached", () => {
    const text = formatStatus(
      local,
      { ...info, pid: 42, startedBy: "cli" },
      [],
      [{ id: "agent.turns", title: "Turns running", source: "agent.loop", items: ["a turn in s1", "a turn in s2"] }],
      [
        { kind: "web", since: 0, answers: true },
        { kind: "web", since: 0, answers: true },
        { kind: "cli", since: 0, answers: false },
      ],
    );
    expect(text).toMatch(/^environment +local \(http:\/\/127\.0\.0\.1:4100\)$/m);
    expect(text).toMatch(/^host +pid 42, transport 0\.1\.0$/m);
    expect(text).toMatch(/^started +by lemma serve --detach$/m);
    expect(text).toMatch(/^clients +2 web, cli$/m);
    expect(text).toMatch(/^in progress +a turn in s1; a turn in s2$/m);
  });

  test("names a saved environment's file, and says nothing runs or attaches when so", () => {
    const text = formatStatus({ ...local, source: "saved", name: "box", from: "/home/me/.lemma/environments.json" }, info, [], [], []);
    expect(text).toMatch(/^environment +box \(http:\/\/127\.0\.0\.1:4100, from \/home\/me\/\.lemma\/environments\.json\)$/m);
    expect(text).toMatch(/^started +by hand \(lemma serve\)$/m);
    expect(text).toMatch(/^clients +none$/m);
    expect(text).toMatch(/^in progress +nothing$/m);
  });
});
