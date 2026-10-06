import { Cause } from "effect";
import { describe, expect, test } from "vitest";
import { PluginFault } from "@lemma/core";
import { describeReload, toPluginStatus } from "../src/rpc.ts";

describe("describeReload", () => {
  test("names what changed, failures included, leaving out the plugin the message already names", () => {
    expect(describeReload({ started: ["a"], restarted: ["b", "c"], stopped: [], failed: ["d"] }, "c")).toBe("started a; restarted b; failed d");
    expect(describeReload({ started: [], restarted: ["c"], stopped: [] }, "c")).toBeUndefined();
  });
});

describe("toPluginStatus", () => {
  const info = { id: "bash", source: "bundled", enabled: true, provides: [], requires: ["lemma/Tools"] } as const;

  test("carries a plugin's wiring to clients: hooks, events, and what it contributes", () => {
    const wiring = {
      hooks: [{ name: "lemma/tool.execute", order: 0 }],
      observes: ["lemma/turn.ended"],
      contributes: [{ name: "lemma/tools", items: 1, keys: ["bash"] }],
    };
    expect(toPluginStatus({ ...info, state: "active", ...wiring })).toMatchObject({ state: "active", ...wiring });
  });

  test("a plugin the core has not loaded is disabled, and a fault reads as a line", () => {
    expect(toPluginStatus(info).state).toBe("disabled");
    const fault = new PluginFault({ pluginId: "bash", phase: "activate", cause: Cause.fail(new Error("no shell")) });
    expect(toPluginStatus({ ...info, state: "failed", fault }).fault).toEqual({ phase: "activate", message: `${fault.message}: no shell` });
  });
});
