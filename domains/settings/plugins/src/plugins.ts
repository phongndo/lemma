import { capabilityName } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";

/** What a search over plugins matches. */
export const pluginText = (plugin: PluginStatus): string =>
  [
    plugin.id,
    plugin.version,
    plugin.state,
    plugin.source,
    plugin.enabled ? "on enabled" : "off disabled",
    plugin.fault?.message,
    plugin.problem,
    plugin.haltedBy,
    plugin.locked,
    ...plugin.provides.map(capabilityName),
    ...plugin.requires.map(capabilityName),
  ]
    .filter(Boolean)
    .join(" ");

const loaded = (plugin: PluginStatus) => plugin.enabled && plugin.state !== "disabled";

/** Running plugins that stop when `id` is turned off: those requiring a capability it provides, transitively, nearest first. */
export function dependentsOf(plugins: readonly PluginStatus[], id: string): string[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const found: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = byId.get(queue.shift()!);
    if (current === undefined) continue;
    for (const plugin of plugins) {
      if (plugin.id === id || found.includes(plugin.id) || !loaded(plugin)) continue;
      if (plugin.requires.some((key) => current.provides.includes(key))) {
        found.push(plugin.id);
        queue.push(plugin.id);
      }
    }
  }
  return found;
}

/** Enabled plugins that are not loaded because `id` is off, directly or through another one waiting on it. */
export function waitingOn(plugins: readonly PluginStatus[], id: string): string[] {
  const found: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const plugin of plugins) {
      if (found.includes(plugin.id) || !plugin.enabled || plugin.state !== "disabled" || plugin.haltedBy !== current) continue;
      found.push(plugin.id);
      queue.push(plugin.id);
    }
  }
  return found;
}

/** The row's one-phrase status: the core's state, or why the plugin is not running. */
export function describeState(plugin: PluginStatus): string {
  if (!plugin.enabled) return "Off";
  switch (plugin.state) {
    case "active":
      return "Running";
    case "failed":
      return "Failed";
    case "activating":
      return "Starting";
    case "draining":
      return "Stopping";
    case "pending":
      return "Waiting";
    case "closed":
      return plugin.haltedBy === undefined ? "Stopped" : `Halted by ${plugin.haltedBy}`;
    case "disabled":
      return plugin.problem !== undefined ? "Left out" : plugin.haltedBy === undefined ? "Not loaded" : `Needs ${plugin.haltedBy}`;
  }
}

const providesOf = (plugins: readonly PluginStatus[], id: string): readonly string[] => plugins.find((plugin) => plugin.id === id)?.provides ?? [];

/** Enabled plugins providing a capability `id` also provides: the host turns them off when `id` is turned on. */
export const replaces = (plugins: readonly PluginStatus[], id: string): string[] => {
  const provides = providesOf(plugins, id);
  return plugins.filter((plugin) => plugin.id !== id && plugin.enabled && plugin.provides.some((key) => provides.includes(key))).map((plugin) => plugin.id);
};

/** Which composition a plugin's half belongs to: the host's, or the web app's. */
export type PluginKind = "host" | "web";

/**
 * A plugin as the table lists it: one id, with a host half, a web half, or both. `kind` and `plugin` are the half it
 * shows first (the host's, when it has one); `pair` is its other half, which the same row turns on and off.
 */
export interface KindedPlugin {
  readonly kind: PluginKind;
  readonly plugin: PluginStatus;
  readonly pair?: { readonly kind: PluginKind; readonly plugin: PluginStatus };
}

/** One entry per plugin id: a host half and a web half with the same id are one plugin. */
export const pairHalves = (host: readonly PluginStatus[], web: readonly PluginStatus[]): KindedPlugin[] => {
  const webById = new Map(web.map((plugin) => [plugin.id, plugin]));
  const hostIds = new Set(host.map((plugin) => plugin.id));
  return [
    ...host.map((plugin): KindedPlugin => {
      const half = webById.get(plugin.id);
      return half === undefined ? { kind: "host", plugin } : { kind: "host", plugin, pair: { kind: "web", plugin: half } };
    }),
    ...web.filter((plugin) => !hostIds.has(plugin.id)).map((plugin): KindedPlugin => ({ kind: "web", plugin })),
  ];
};

/** The halves of an entry, the one it shows first first. */
export const halvesOf = (entry: KindedPlugin): readonly { readonly kind: PluginKind; readonly plugin: PluginStatus }[] =>
  entry.pair === undefined ? [entry] : [entry, entry.pair];

const STATES: Readonly<Record<string, (plugin: PluginStatus) => boolean>> = {
  running: (plugin) => plugin.state === "active",
  failed: (plugin) => plugin.state === "failed" || plugin.problem !== undefined,
  off: (plugin) => !plugin.enabled,
  halted: (plugin) => plugin.enabled && plugin.haltedBy !== undefined,
  locked: (plugin) => plugin.locked !== undefined,
  configurable: (plugin) => (plugin.configFields?.length ?? 0) > 0,
  faulted: (plugin) => (plugin.faults?.length ?? 0) > 0 || plugin.fault !== undefined,
};

/** The filter words the plugins table understands, for its placeholder and help. */
export const PLUGIN_FILTERS = [
  "is:running",
  "is:failed",
  "is:off",
  "is:halted",
  "is:locked",
  "is:configurable",
  "is:faulted",
  "kind:host",
  "kind:web",
  "source:user",
];

/**
 * A plugins table filter: `is:<state>`, `kind:host|web`, `source:bundled|user|project`,
 * and words matched against `pluginText`; `-` before any term excludes it. Every term must hold.
 */
export const matchPlugins = (entries: readonly KindedPlugin[], query: string): KindedPlugin[] => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // A term holds for a plugin when it holds for either of its halves.
  const test = (term: string, entry: KindedPlugin): boolean =>
    halvesOf(entry).some(({ kind, plugin }) => {
      const [key, value] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : [undefined, term];
      if (key === "is") return STATES[value]?.(plugin) ?? false;
      if (key === "kind") return kind === value;
      if (key === "source") return plugin.source === value;
      return `${pluginText(plugin)} ${kind}`.toLowerCase().includes(term);
    });
  return entries.filter((entry) => terms.every((term) => (term.startsWith("-") && term.length > 1 ? !test(term.slice(1), entry) : test(term, entry))));
};
