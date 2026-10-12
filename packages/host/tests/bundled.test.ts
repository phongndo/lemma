import { describe, expect, test } from "vitest";
import { Layer, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import type { PluginRow } from "@lemma/contracts";
import { planComposition } from "@lemma/composition";
import { appDefaults, bundled as shipped, cliCommand, webDist } from "../src/bundled.ts";
import { runtimeCapabilities } from "../src/runtime.ts";

const plugin = (id: string) => definePlugin({ id, config: Schema.Record(Schema.String, Schema.Unknown), layer: Layer.empty });
const bundled = [plugin("agent.loop"), plugin("transport.server"), plugin("tools.registry")];
const entries = (rows: Readonly<Record<string, PluginRow>> = {}) => planComposition({ bundled, local: [], rows, defaults: appDefaults }).composition.plugins;

describe("bundled", () => {
  test("every bundled plugin runs on what the host provides itself, and none provides any of it", () => {
    const planned = planComposition({
      bundled: shipped,
      local: [],
      rows: {},
      pinned: ["transport.server"],
      defaults: appDefaults,
      provided: runtimeCapabilities,
    });
    expect(planned.diagnostics).toEqual([]);
    expect(Object.keys(planned.resolved.composition.plugins)).toEqual(shipped.map((plugin) => plugin.id));
    const runtime = new Set(runtimeCapabilities.map((tag) => tag.key));
    expect(shipped.flatMap((plugin) => plugin.provides.map((tag) => tag.key)).filter((key) => runtime.has(key))).toEqual([]);
  });
});

describe("appDefaults", () => {
  test("enables every plugin, with the web app served and the CLI named to the agent by default", () => {
    expect(entries()).toEqual({ "agent.loop": { config: { cli: cliCommand } }, "transport.server": { config: { staticDir: webDist } }, "tools.registry": {} });
  });

  test("a transport config row keeps the web app unless it sets staticDir itself", () => {
    expect(entries({ "transport.server": { config: { port: 8000 } } })["transport.server"]).toEqual({ config: { staticDir: webDist, port: 8000 } });
    expect(entries({ "transport.server": { config: { staticDir: "/srv/ui" } } })["transport.server"]).toEqual({ config: { staticDir: "/srv/ui" } });
    expect(entries({ "transport.server": { enabled: false } })["transport.server"]).toEqual({ config: { staticDir: webDist }, enabled: false });
  });

  test("an agent config row keeps the CLI unless it sets cli itself", () => {
    expect(entries({ "agent.loop": { config: { maxSteps: 5 } } })["agent.loop"]).toEqual({ config: { cli: cliCommand, maxSteps: 5 } });
  });

  test("other plugins' config rows replace their config", () => {
    expect(entries({ "tools.registry": { config: { timeoutMs: 5 } } })["tools.registry"]).toEqual({ config: { timeoutMs: 5 } });
  });
});
