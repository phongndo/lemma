import { describe, expect, it } from "vitest";
import type { PluginStatus } from "@lemma/contracts";
import { bindingRows, conflicts, formatBindings, keysFor, overridesFrom, parseBindings, withOverride } from "../src/model/keybindings.ts";

describe("keybindings", () => {
  it("uses the user's keys over an action's own, and an empty list unbinds", () => {
    expect(keysFor("a", "mod+k", {})).toEqual(["mod+k"]);
    expect(keysFor("a", "mod+k", { a: ["mod+p"] })).toEqual(["mod+p"]);
    expect(keysFor("a", "mod+k", { a: [] })).toEqual([]);
    expect(keysFor("b", undefined, {})).toEqual([]);
  });

  it("drops an override that matches the default or is reset", () => {
    expect(withOverride({}, "a", ["mod+p", "mod+p"], ["mod+k"])).toEqual({ a: ["mod+p"] });
    expect(withOverride({ a: ["mod+p"] }, "a", ["mod+k"], ["mod+k"])).toEqual({});
    expect(withOverride({ a: ["mod+p"], b: [] }, "a", undefined, ["mod+k"])).toEqual({ b: [] });
  });

  it("finds bindings two actions share", () => {
    const found = conflicts([
      { id: "a", keys: ["mod+k", "mod+j"] },
      { id: "b", keys: ["mod+k"] },
      { id: "c", keys: ["mod+j", "mod+j"] },
    ]);
    expect([...found]).toEqual([
      ["mod+k", ["a", "b"]],
      ["mod+j", ["a", "c"]],
    ]);
  });

  it("reads and writes bindings as one line per action", () => {
    const lines = formatBindings({ "shell.toggle-sidebar": ["mod+b", "mod+k"], "a.unbound": [] });
    expect(lines).toEqual(["a.unbound =", "shell.toggle-sidebar = mod+b, mod+k"]);
    expect(parseBindings(lines)).toEqual({ "a.unbound": [], "shell.toggle-sidebar": ["mod+b", "mod+k"] });
    expect(parseBindings(["no equals", " = mod+k", "x = Mod+K ,, ", 7])).toEqual({ x: ["mod+k"] });
  });

  it("reads the keymap plugin's bindings from the plugin list", () => {
    const plugin = (values: unknown) => ({ id: "keymap", config: { values, secretsSet: [] } }) as unknown as PluginStatus;
    expect(overridesFrom([plugin({ bindings: ["a = mod+k"] })])).toEqual({ a: ["mod+k"] });
    expect(overridesFrom([plugin({})])).toEqual({});
    expect(overridesFrom([])).toEqual({});
  });

  it("lists a row per action and key by name, and finds actions without keys only when searching", () => {
    const actions = [
      { id: "shell.sidebar", title: "Toggle sidebar", category: "View", keys: ["mod+b", "mod+\\"] },
      { id: "palette.open", title: "Command palette", keys: "mod+k", keywords: ["commands"] },
      { id: "host.reload", title: "Reload Lemma" },
    ];
    const rows = (query: string, overrides = {}) =>
      bindingRows(actions, overrides, query, (key) => key.toUpperCase()).map((row) => `${row.action.id} ${row.key ?? "-"}`);
    expect(rows("")).toEqual(["palette.open mod+k", "shell.sidebar mod+b", "shell.sidebar mod+\\"]);
    expect(rows("MOD+B")).toEqual(["shell.sidebar mod+b"]);
    expect(rows("view b")).toEqual(["shell.sidebar mod+b", "shell.sidebar mod+\\"]);
    expect(rows("reload")).toEqual(["host.reload -"]);
    expect(rows("", { "host.reload": ["mod+r"], "palette.open": [] })).toEqual(["host.reload mod+r", "shell.sidebar mod+b", "shell.sidebar mod+\\"]);
  });

  it("lists a key the config repeats once", () => {
    const rows = bindingRows([{ id: "a", title: "A" }], { a: ["mod+k", "mod+k"] }, "", (key) => key);
    expect(rows.map((row) => row.key)).toEqual(["mod+k"]);
  });
});
