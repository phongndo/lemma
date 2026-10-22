import { describe, expect, test } from "vitest";
import { Layer, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import type { PluginRow } from "@lemma/contracts";
import { planComposition } from "@lemma/composition";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appDefaults, bundled as shipped, bundledCode, bundledWeb, cliCommand, webDist } from "../src/bundled.ts";
import { KINDS } from "../src/paths.ts";
import { runtimeCapabilities } from "../src/runtime.ts";
import { domainPlugins } from "../../../scripts/plugins.ts";

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

  test("holds the host half of every plugin in domains/, under the id its folder names", () => {
    const halves = [...domainPlugins()].filter(([, plugin]) => plugin.host !== undefined).map(([id]) => id);
    expect(shipped.map((plugin) => plugin.id).sort()).toEqual(halves.sort());
  });

  test("knows where every bundled plugin's code is, for a stall to name it", () => {
    const code = bundledCode(shipped);
    expect(code.map((owner) => owner.id)).toEqual(shipped.map((plugin) => plugin.id));
    for (const owner of code) expect(existsSync(join(owner.path, "package.json")), owner.path).toBe(true);
  });

  test("knows the id of every web half in domains/, which the web app runs, so a row naming one is no typo", () => {
    const halves = [...domainPlugins()].filter(([, plugin]) => plugin.web !== undefined).map(([id]) => id);
    expect([...bundledWeb].sort()).toEqual(halves.sort());
  });
});

describe("appDefaults", () => {
  test("enables every plugin, with the web app served on its kind's port and the CLI named to the agent by default", () => {
    expect(entries()).toEqual({
      "agent.loop": { config: { cli: cliCommand } },
      "transport.server": { config: { staticDir: webDist, port: KINDS.checkout.port } },
      "tools.registry": {},
    });
  });

  test("a transport config row keeps the web app and the port unless it sets them itself", () => {
    expect(entries({ "transport.server": { config: { port: 8000 } } })["transport.server"]).toEqual({ config: { staticDir: webDist, port: 8000 } });
    expect(entries({ "transport.server": { config: { staticDir: "/srv/ui" } } })["transport.server"]).toEqual({
      config: { staticDir: "/srv/ui", port: KINDS.checkout.port },
    });
    expect(entries({ "transport.server": { enabled: false } })["transport.server"]).toEqual({
      config: { staticDir: webDist, port: KINDS.checkout.port },
      enabled: false,
    });
  });

  test("names the CLI so the agent's shell runs it on the host's Node.js, with none on PATH", () => {
    const shell = execFileSync("/bin/sh", ["-c", `${cliCommand} --version --text`], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
    expect(shell.trim()).toBe(JSON.parse(readFileSync(new URL("../../../apps/cli/package.json", import.meta.url), "utf8")).version);
  });

  test("an agent config row keeps the CLI unless it sets cli itself", () => {
    expect(entries({ "agent.loop": { config: { maxSteps: 5 } } })["agent.loop"]).toEqual({ config: { cli: cliCommand, maxSteps: 5 } });
  });

  test("other plugins' config rows replace their config", () => {
    expect(entries({ "tools.registry": { config: { timeoutMs: 5 } } })["tools.registry"]).toEqual({ config: { timeoutMs: 5 } });
  });
});
