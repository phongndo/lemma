import { describe, expect, test } from "vitest";
import { Layer, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import type { PluginRow } from "@lemma/contracts";
import { planComposition } from "@lemma/composition";
import { appDefaults, cliCommand, webDist } from "../src/bundled.ts";

const plugin = (id: string) => definePlugin({ id, config: Schema.Record(Schema.String, Schema.Unknown), layer: Layer.empty });
const bundled = [plugin("agent"), plugin("transport"), plugin("tools")];
const entries = (rows: Readonly<Record<string, PluginRow>> = {}) => planComposition({ bundled, local: [], rows, defaults: appDefaults }).composition.plugins;

describe("appDefaults", () => {
  test("enables every plugin, with the web app served and the CLI named to the agent by default", () => {
    expect(entries()).toEqual({ agent: { config: { cli: cliCommand } }, transport: { config: { staticDir: webDist } }, tools: {} });
  });

  test("a transport config row keeps the web app unless it sets staticDir itself", () => {
    expect(entries({ transport: { config: { port: 8000 } } }).transport).toEqual({ config: { staticDir: webDist, port: 8000 } });
    expect(entries({ transport: { config: { staticDir: "/srv/ui" } } }).transport).toEqual({ config: { staticDir: "/srv/ui" } });
    expect(entries({ transport: { enabled: false } }).transport).toEqual({ config: { staticDir: webDist }, enabled: false });
  });

  test("an agent config row keeps the CLI unless it sets cli itself", () => {
    expect(entries({ agent: { config: { maxSteps: 5 } } }).agent).toEqual({ config: { cli: cliCommand, maxSteps: 5 } });
  });

  test("other plugins' config rows replace their config", () => {
    expect(entries({ tools: { config: { timeoutMs: 5 } } }).tools).toEqual({ config: { timeoutMs: 5 } });
  });
});
