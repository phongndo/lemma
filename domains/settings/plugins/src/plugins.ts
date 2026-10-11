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

/** The domain a plugin's id names, `tools` for `tools.bash`; none for an id without one, as a user's plugin often has. */
export const domainOf = (id: string): string | undefined => {
  const at = id.indexOf(".");
  return at > 0 ? id.slice(0, at) : undefined;
};

/** A domain's plugins, as the table folds them under one row; or, with `domain` `""`, the plugins in none. */
export interface PluginGroup {
  readonly domain: string;
  readonly entries: readonly KindedPlugin[];
}

const byId = (a: KindedPlugin, b: KindedPlugin) => a.plugin.id.localeCompare(b.plugin.id);

/**
 * The plugins as they are organized: one group per domain, by name, each domain's plugins by id, then those in no
 * domain, a user's own, as their ids rarely name one (a user's plugin that names a domain, replacing a bundled one,
 * is in that domain).
 */
export const groupPlugins = (entries: readonly KindedPlugin[]): PluginGroup[] => {
  const groups = new Map<string, KindedPlugin[]>();
  for (const entry of entries) {
    const domain = domainOf(entry.plugin.id) ?? "";
    groups.set(domain, [...(groups.get(domain) ?? []), entry]);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([domain, members]) => ({ domain, entries: [...members].sort(byId) }));
};

/** A domain's row while it is folded: the halves its plugins have, and how they are doing, the worst first. */
export interface DomainSummary {
  readonly kinds: readonly PluginKind[];
  /** `Running`, or what is not: `1 failed · 2 off`. */
  readonly state: string;
  /** Its state dot's: failed when one is, off when one is off or not running, else active. */
  readonly tone: "active" | "failed" | "off";
}

export const summarizeDomain = (group: PluginGroup): DomainSummary => {
  const halves = group.entries.flatMap(halvesOf);
  const failing = (entry: KindedPlugin) => halvesOf(entry).some(({ plugin }) => plugin.state === "failed" || plugin.problem !== undefined);
  const failed = group.entries.filter(failing).length;
  const off = group.entries.filter((entry) => !entry.plugin.enabled).length;
  const stopped = group.entries.filter(
    (entry) => entry.plugin.enabled && !failing(entry) && halvesOf(entry).some(({ plugin }) => plugin.state !== "active"),
  ).length;
  const said = [...(failed === 0 ? [] : [`${failed} failed`]), ...(off === 0 ? [] : [`${off} off`]), ...(stopped === 0 ? [] : [`${stopped} not running`])];
  return {
    kinds: (["host", "web"] as const).filter((kind) => halves.some((half) => half.kind === kind)),
    state: said.length === 0 ? "Running" : said.join(" · "),
    tone: failed > 0 ? "failed" : off + stopped > 0 ? "off" : "active",
  };
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
  "domain:tools",
];

/**
 * A plugins table filter: `is:<state>`, `kind:host|web`, `source:bundled|user|project`, `domain:<domain>`,
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
      if (key === "domain") return domainOf(plugin.id) === value;
      return `${pluginText(plugin)} ${kind}`.toLowerCase().includes(term);
    });
  return entries.filter((entry) => terms.every((term) => (term.startsWith("-") && term.length > 1 ? !test(term.slice(1), entry) : test(term, entry))));
};
