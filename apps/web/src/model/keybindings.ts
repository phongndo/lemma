import type { PluginStatus } from "@lemma/contracts";

/** Shortcuts the user set, by action id; an empty list unbinds the action. */
export type KeyOverrides = Readonly<Record<string, readonly string[]>>;

/** The plugin whose `bindings` config holds the user's shortcuts. */
export const KEYMAP_PLUGIN = "keymap";

/** An action's own `keys` as a list. */
export const defaultKeys = (keys: string | readonly string[] | undefined): readonly string[] =>
  keys === undefined ? [] : typeof keys === "string" ? [keys] : keys;

/** The keys that run an action: the user's, else its own. */
export const keysFor = (id: string, keys: string | readonly string[] | undefined, overrides: KeyOverrides): readonly string[] =>
  overrides[id] ?? defaultKeys(keys);

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, i) => key === b[i]);

/** Sets one action's keys; undefined, or the same keys as its own, drops the override. */
export const withOverride = (
  overrides: KeyOverrides,
  id: string,
  next: readonly string[] | undefined,
  defaults: readonly string[],
): Record<string, readonly string[]> => {
  const { [id]: _old, ...rest } = overrides;
  if (next === undefined) return rest;
  const unique = [...new Set(next)];
  return same(unique, defaults) ? rest : { ...rest, [id]: unique };
};

/** Bindings more than one action uses, with those actions' ids in order. */
export const conflicts = (bound: readonly { readonly id: string; readonly keys: readonly string[] }[]): ReadonlyMap<string, readonly string[]> => {
  const users = new Map<string, string[]>();
  for (const { id, keys } of bound) for (const key of new Set(keys)) users.set(key, [...(users.get(key) ?? []), id]);
  return new Map([...users].filter(([, ids]) => ids.length > 1));
};

/**
 * Overrides from the keymap plugin's `bindings` config: one line per action,
 * `shell.toggle-sidebar = mod+b, mod+k`, where nothing after `=` unbinds it.
 * Lines without an `=` are skipped; a later line for the same action wins.
 */
export const parseBindings = (lines: readonly unknown[]): KeyOverrides => {
  const overrides: Record<string, readonly string[]> = {};
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const at = line.indexOf("=");
    const id = line.slice(0, at).trim();
    if (at === -1 || id === "") continue;
    overrides[id] = line
      .slice(at + 1)
      .split(",")
      .map((key) => key.trim().toLowerCase())
      .filter(Boolean);
  }
  return overrides;
};

/** Overrides as the config's lines, by action id. */
export const formatBindings = (overrides: KeyOverrides): string[] =>
  Object.entries(overrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, keys]) => `${id} = ${keys.join(", ")}`.trimEnd());

/** The user's shortcuts, from the keymap plugin's config as the plugin list reports it. */
export const overridesFrom = (plugins: readonly PluginStatus[]): KeyOverrides => {
  const bindings = plugins.find((plugin) => plugin.id === KEYMAP_PLUGIN)?.config?.values.bindings;
  return Array.isArray(bindings) ? parseBindings(bindings) : {};
};

/** The binding to show beside an action: its first, the user's over its own. */
export const shownKeys = (
  action: { readonly id: string; readonly keys?: string | readonly string[] | undefined },
  plugins: readonly PluginStatus[],
): string | undefined => keysFor(action.id, action.keys, overridesFrom(plugins))[0];
