import type { PluginStatus, ReloadResult } from "@lemma/contracts";

type Source = PluginStatus["source"];

const SOURCE_ORDER: readonly Source[] = ["bundled", "user", "project"];
export const SOURCE_TITLES: Readonly<Record<Source, string>> = { bundled: "Bundled", user: "Your plugins", project: "Project plugins" };

export interface PluginGroup {
  readonly source: Source;
  readonly title: string;
  readonly plugins: readonly PluginStatus[];
}

/** By where they come from, keeping the host's order within each group; empty groups are dropped. */
export const pluginGroups = (plugins: readonly PluginStatus[]): PluginGroup[] =>
  SOURCE_ORDER.map((source) => ({ source, title: SOURCE_TITLES[source], plugins: plugins.filter((plugin) => plugin.source === source) })).filter(
    (group) => group.plugins.length > 0,
  );

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

/** `lemma/Llm` reads as `Llm`. */
export const capabilityName = (key: string): string => key.slice(key.lastIndexOf("/") + 1);

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

/** Whether a restart would do anything without `force`: the plugin failed, or a failed dependency halted it. */
export const recoverable = (plugin: PluginStatus): boolean => plugin.state === "failed" || (plugin.state === "closed" && plugin.haltedBy !== undefined);

const providesOf = (plugins: readonly PluginStatus[], id: string): readonly string[] => plugins.find((plugin) => plugin.id === id)?.provides ?? [];

/** Every plugin requiring a capability `id` provides, directly, running or not: what the details panel lists. Compare `dependentsOf`. */
export const requiredBy = (plugins: readonly PluginStatus[], id: string): string[] => {
  const provides = providesOf(plugins, id);
  return plugins.filter((plugin) => plugin.id !== id && plugin.requires.some((key) => provides.includes(key))).map((plugin) => plugin.id);
};

/** Enabled plugins providing a capability `id` also provides: the host turns them off when `id` is turned on. */
export const replaces = (plugins: readonly PluginStatus[], id: string): string[] => {
  const provides = providesOf(plugins, id);
  return plugins.filter((plugin) => plugin.id !== id && plugin.enabled && plugin.provides.some((key) => provides.includes(key))).map((plugin) => plugin.id);
};

/** Which composition a plugin belongs to: the host's, or the web app's. */
export type PluginKind = "host" | "web";

export interface KindedPlugin {
  readonly kind: PluginKind;
  readonly plugin: PluginStatus;
}

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
  const test = (term: string, { kind, plugin }: KindedPlugin): boolean => {
    const [key, value] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : [undefined, term];
    if (key === "is") return STATES[value]?.(plugin) ?? false;
    if (key === "kind") return kind === value;
    if (key === "source") return plugin.source === value;
    return `${pluginText(plugin)} ${kind}`.toLowerCase().includes(term);
  };
  return entries.filter((entry) => terms.every((term) => (term.startsWith("-") && term.length > 1 ? !test(term.slice(1), entry) : test(term, entry))));
};

/** Plugins requiring `key`, by id. */
export const usersOf = (plugins: readonly PluginStatus[], key: string): string[] =>
  plugins.filter((plugin) => plugin.requires.includes(key)).map((plugin) => plugin.id);

/** The plugin providing `key`: the enabled one when several do. */
export const providerOf = (plugins: readonly PluginStatus[], key: string): PluginStatus | undefined =>
  plugins.find((plugin) => plugin.enabled && plugin.provides.includes(key)) ?? plugins.find((plugin) => plugin.provides.includes(key));

/** `started x; restarted y; stopped z; failed w`, leaving out `except` (a plugin the message already names). */
export const describeReload = (result: ReloadResult, except?: string): string => {
  const list = (ids: readonly string[] | undefined) => (ids ?? []).filter((id) => id !== except);
  const parts = (
    [
      ["started", result.started],
      ["restarted", result.restarted],
      ["stopped", result.stopped],
      ["failed", result.failed],
    ] as const
  )
    .map(([verb, ids]) => (list(ids).length > 0 ? `${verb} ${list(ids).join(", ")}` : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "nothing changed";
};
