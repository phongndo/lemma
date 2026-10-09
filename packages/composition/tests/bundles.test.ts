import { describe, expect, test } from "vitest";
import { Context, Layer, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import type { BundleManifest } from "@lemma/contracts/runtime";
import { expandBundles } from "../src/bundles.ts";
import type { BundleInput } from "../src/bundles.ts";
import { planComposition } from "../src/planner.ts";

const first: BundleManifest = { id: "first", title: "First feature", host: ["shared", "first"], ui: ["shared-view", "first-view"] };
const second: BundleManifest = { id: "second", title: "Second feature", host: ["shared", "second"], ui: ["shared-view", "second-view"] };
const expand = (input: Partial<BundleInput> = {}) => expandBundles({ manifests: [first, second], rows: {}, plugins: {}, ui: {}, ...input });
const defaults = (id: string, config: unknown, required?: boolean): BundleManifest => ({
  id,
  title: id,
  host: ["shared"],
  ui: [],
  defaults: { plugins: { shared: { config, ...(required === undefined ? {} : { required }) } } },
});

class Shared extends Context.Service<Shared, string>()("test/Shared") {}
const shared = definePlugin({ id: "shared", provides: [Shared], layer: Layer.succeed(Shared, "shared") });
const consumer = definePlugin({ id: "first", requires: [Shared], layer: Layer.empty });
const running = (rows: BundleInput["plugins"]) => planComposition({ bundled: [shared, consumer], local: [], rows });

describe("composition-only bundles", () => {
  test("existing configs and plugins need no bundle declarations", () => {
    const plugins = { thirdparty: { config: { x: 1 } }, first: { enabled: false } };
    const ui = { thirdparty: { required: true } };
    expect(expand({ manifests: [], plugins, ui })).toEqual({ plugins, ui, diagnostics: [] });
    expect(expand().plugins).toEqual({ first: {}, second: {}, shared: {} });
  });

  test("shared members are unioned and deduplicated separately in each runtime", () => {
    const result = expand({ manifests: [{ ...first, host: [...first.host, "shared"] }, second], rows: { first: { enabled: false } } });
    expect(result.plugins).toEqual({ first: { enabled: false }, second: {}, shared: {} });
    expect(result.ui).toEqual({ "first-view": { enabled: false }, "second-view": {}, "shared-view": {} });
    expect(result.diagnostics).toEqual([]);
    const off = expand({ rows: { first: { enabled: false }, second: { enabled: false } } });
    expect(off.plugins.shared).toEqual({ enabled: false });
    expect(off.ui["shared-view"]).toEqual({ enabled: false });
    expect(running(off.plugins).resolved.composition.plugins.shared?.enabled).toBe(false);
  });

  test("explicit plugin overrides win even against deselection and defaults", () => {
    const result = expand({
      manifests: [defaults("a", { a: 1, b: 2 }, true)],
      rows: { a: { enabled: false } },
      plugins: { shared: { enabled: true, config: { mine: 3 }, required: false } },
    });
    expect(result.plugins.shared).toEqual({ enabled: true, config: { mine: 3 }, required: false });
    const enabled = expand({ manifests: [defaults("a", { a: 1, b: 2 }, true)], plugins: { shared: { config: {}, required: false } } });
    expect(enabled.plugins.shared).toEqual({ config: {}, required: false });
  });

  test("default-off manifests generate off rows unless selected", () => {
    const manifest = { ...first, enabledByDefault: false };
    expect(expand({ manifests: [manifest] }).plugins.first).toEqual({ enabled: false });
    expect(expand({ manifests: [manifest], rows: { first: { enabled: true } } }).plugins.first).toEqual({});
  });

  test("compatible config defaults merge by key with order-independent object comparison", () => {
    const a = defaults("a", { a: 1, object: { x: 1, y: 2 } }, true);
    const b = defaults("b", { b: 2, object: { y: 2, x: 1 } }, true);
    const result = expand({ manifests: [a, b] });
    expect(result.plugins.shared).toEqual({ config: { a: 1, b: 2, object: { x: 1, y: 2 } }, required: true });
    expect(result.diagnostics).toEqual([]);
    expect(expand({ manifests: [b, a] })).toEqual(result);
  });

  test("conflicting defaults are diagnosed, never decided by declaration order", () => {
    const a = defaults("a", { value: 1 }, true);
    const b = defaults("b", { value: 2 }, false);
    const result = expand({ manifests: [a, b] });
    expect(result.diagnostics.map(({ message }) => message)).toEqual([
      'Bundles "a" and "b" disagree on "plugins.shared.required"; set an explicit plugin row to resolve it',
      'Bundles "a" and "b" disagree on "plugins.shared.config.value"; set an explicit plugin row to resolve it',
    ]);
    expect(result.diagnostics.every(({ severity }) => severity === "error")).toBe(true);
    expect(expand({ manifests: [b, a] })).toEqual(result);
    expect(expand({ manifests: [a, b], plugins: { shared: { required: false, config: { value: 3 } } } }).diagnostics).toEqual([]);
    expect(expand({ manifests: [a, b], rows: { b: { enabled: false } } }).diagnostics).toEqual([]);
  });

  test("whole scalar, array, and null defaults compare without losing their shape", () => {
    for (const value of [null, [1, 2], "value", 0, false]) {
      const result = expand({ manifests: [defaults("a", value), defaults("b", value)] });
      expect(result.plugins.shared?.config).toEqual(value);
      expect(result.diagnostics).toEqual([]);
    }
    expect(expand({ manifests: [defaults("a", [1, 2]), defaults("b", [2, 1])] }).diagnostics).toHaveLength(1);
    expect(expand({ manifests: [defaults("a", {}), defaults("b", null)] }).diagnostics).toHaveLength(1);
  });

  test("UI defaults and explicit overrides follow the same rules", () => {
    const manifests = [1, 2].map((value) => ({
      id: String(value),
      title: String(value),
      host: [],
      ui: ["view"],
      defaults: { ui: { view: { config: { value } } } },
    }));
    expect(expand({ manifests }).diagnostics[0]?.message).toContain("ui.view.config.value");
    expect(expand({ manifests, ui: { view: { config: { value: 3 }, enabled: false } } })).toMatchObject({
      ui: { view: { config: { value: 3 }, enabled: false } },
      diagnostics: [],
    });
  });

  test("invalid bundle declarations fail before runtime planning", () => {
    expect(expand({ manifests: [first, first] }).diagnostics[0]?.message).toContain("defined more than once");
    expect(expand({ rows: { missing: { enabled: true } } }).diagnostics[0]?.message).toContain("names no bundle");
    expect(expand({ manifests: [{ ...first, defaults: { plugins: { elsewhere: { config: {} } } } }] }).diagnostics[0]?.message).toContain(
      "not one of its members",
    );
    expect(expand({ manifests: [{ ...first, defaults: { plugins: { first: { enabled: false } } } }] }).diagnostics[0]?.message).toContain("enabled default");
  });

  test("selected bundles do not prevent capability-based third-party replacement", () => {
    const alternative = definePlugin({ id: "alternative", provides: [Shared], layer: Layer.succeed(Shared, "mine") });
    const result = planComposition({
      bundled: [shared, consumer],
      local: [{ plugin: alternative, source: "user" }],
      rows: expand({ manifests: [first] }).plugins,
    });
    expect(result.resolved.composition.plugins.shared?.enabled).toBe(false);
    expect(result.resolved.composition.plugins.alternative?.enabled).not.toBe(false);
    expect(result.resolved.composition.plugins.first?.enabled).not.toBe(false);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  });

  test("required and pinned plugins keep the existing capability planner's protections", () => {
    const rows = expand({ manifests: [first], rows: { first: { enabled: false } }, plugins: { first: { enabled: true, required: true } } }).plugins;
    expect(running(rows).diagnostics.some(({ severity, message }) => severity === "error" && message.includes("required"))).toBe(true);
    const pinned = planComposition({ bundled: [shared, consumer], local: [], rows, pinned: ["first"] });
    expect(pinned.resolved.composition.plugins.shared?.enabled).not.toBe(false);
    expect(pinned.diagnostics.some(({ message }) => message.includes("ignored"))).toBe(true);
  });

  test("bundle selection cannot silently disable an explicitly required policy plugin", () => {
    const input = { manifests: [first], rows: { first: { enabled: false } } };
    expect(expand({ ...input, plugins: { first: { required: true } } }).diagnostics[0]?.message).toContain("required plugin");
    expect(expand({ ...input, plugins: { first: { required: true, enabled: true } } }).diagnostics).toEqual([]);
    expect(expand({ ...input, plugins: { first: { required: true, enabled: false } } }).diagnostics).toEqual([]);
    expect(expand({ ...input, plugins: { first: { required: false } } }).diagnostics).toEqual([]);
  });

  test("bundles never become runtime plugins or capability dependencies", () => {
    const planned = running(expand({ manifests: [first] }).plugins);
    expect(planned.known.map(({ plugin }) => plugin.id)).toEqual(["shared", "first"]);
    expect(planned.known.flatMap(({ plugin }) => plugin.requires.map(({ key }) => key))).toEqual([Shared.key]);
  });

  test("schema-invalid defaults are still checked by the ordinary planner", () => {
    const configured = definePlugin({ id: "shared", config: Schema.Struct({ count: Schema.Number }), layer: Layer.empty });
    const rows = expand({ manifests: [defaults("a", { count: "bad" }, true)] }).plugins;
    const planned = planComposition({ bundled: [configured], local: [], rows });
    expect(planned.diagnostics.some(({ severity, message }) => severity === "error" && message.includes("invalid"))).toBe(true);
  });

  test("unusual JSON object keys cannot pollute rows or prototypes", () => {
    const manifest = {
      id: "keys",
      title: "Keys",
      host: ["__proto__"],
      ui: [],
      defaults: JSON.parse('{"plugins":{"__proto__":{"config":{"__proto__":{"x":1},"constructor":2}}}}'),
    };
    const result = expand({ manifests: [manifest] });
    expect(Object.hasOwn(result.plugins, "__proto__")).toBe(true);
    expect(result.plugins["__proto__"]?.config).toEqual(JSON.parse('{"__proto__":{"x":1},"constructor":2}'));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
