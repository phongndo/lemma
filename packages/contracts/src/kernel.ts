import { Order, Predicate } from "effect";
import { Channels } from "./channels.ts";
import type { HookUse, RegistryUse } from "./host.ts";
import type { PluginStatus } from "./status.ts";

/*
 * A composition as its kernel runs it, turned from per-plugin statuses (what
 * each plugin provides, requires, intercepts, observes, and contributes) into
 * per-thing views: each hook's chain in run order, each registry's
 * contributors, each event's observers, each capability's provider and
 * dependents. The same for the host and the web app: both run the core. What
 * the devtools' kernel panels and `lemma kernel` show, and one plugin's wiring
 * (`pluginWiring`), as the Plugins page and the devtools show it.
 */

/** A handler's place in its hook's chain: its phase, when the hook declares phases, and its order within it. */
export interface ChainPlace {
  readonly plugin: string;
  readonly phase?: string;
  /** Its phase's place among the hook's phases (`HookUse.rank`); absent when the hook declares none. */
  readonly rank?: number;
  readonly order: number;
}

export interface HookChain {
  readonly name: string;
  /** In run order: by phase, then lower `order` first, then plugin id. */
  readonly handlers: readonly ChainPlace[];
}

export interface RegistryView {
  readonly name: string;
  readonly contributors: readonly { readonly plugin: string; readonly items: number; readonly keys: readonly string[] }[];
  readonly items: number;
}

export interface EventView {
  readonly name: string;
  readonly observers: readonly string[];
}

export interface CapabilityView {
  readonly key: string;
  /** Usually one; several when an enabled one replaces others that are off. */
  readonly providers: readonly { readonly plugin: string; readonly state: string; readonly enabled: boolean }[];
  /** Provided by the app itself (its runtime, `HostControl.runtime` for the host), not by a plugin. */
  readonly runtime: boolean;
  readonly users: readonly string[];
}

export interface KernelView {
  readonly hooks: readonly HookChain[];
  readonly registries: readonly RegistryView[];
  readonly events: readonly EventView[];
  readonly capabilities: readonly CapabilityView[];
}

const byName = Order.mapInput(Order.String, (item: { readonly name: string }) => item.name);
const runOrder = (a: ChainPlace, b: ChainPlace) => (a.rank ?? 0) - (b.rank ?? 0) || a.order - b.order || Order.String(a.plugin, b.plugin);

const placeOf = (plugin: string, hook: HookUse): ChainPlace => ({
  plugin,
  ...(hook.phase === undefined ? {} : { phase: hook.phase }),
  ...(hook.rank === undefined ? {} : { rank: hook.rank }),
  order: hook.order,
});

/** `lemma/Llm` reads as `Llm`. */
export const capabilityName = (key: string): string => key.slice(key.lastIndexOf("/") + 1);

/** Plugins requiring `key`, by id. */
export const usersOf = (plugins: readonly PluginStatus[], key: string): string[] =>
  plugins.filter((plugin) => plugin.requires.includes(key)).map((plugin) => plugin.id);

/** The plugin providing `key`: the enabled one when several do. */
export const providerOf = (plugins: readonly PluginStatus[], key: string): PluginStatus | undefined =>
  plugins.find((plugin) => plugin.enabled && plugin.provides.includes(key)) ?? plugins.find((plugin) => plugin.provides.includes(key));

/** Every plugin's handlers of hook `name`, in run order (`HookChain.handlers`). */
export const hookChain = (plugins: readonly PluginStatus[], name: string): HookChain["handlers"] =>
  plugins.flatMap((plugin) => plugin.hooks?.filter((hook) => hook.name === name).map((hook) => placeOf(plugin.id, hook)) ?? []).sort(runOrder);

/** Which kernel a plugin runs on: the host's, or the web app's. */
export type KernelKind = "host" | "web";

/** Each kernel as a sentence names it: a "host" plugin, a "web app" plugin. */
export const KERNEL_LABEL: Readonly<Record<KernelKind, string>> = { host: "host", web: "web app" };

/** Who provides a runtime capability on each kernel: its app itself, which no plugin replaces. */
export const RUNTIME_LABEL: Readonly<Record<KernelKind, string>> = { host: "the host", web: "the web app" };

/** A hook a plugin intercepts, and where its handler runs among every plugin's handlers of it. */
export interface WiredHook extends HookUse {
  /** Its place in the hook's chain, from 1 (`hookChain`). */
  readonly position: number;
  /** How many handlers the chain has. */
  readonly of: number;
}

/**
 * How one plugin meets the others, in the five shapes every domain's contract offers (docs/plugins.md): what it adds,
 * intercepts, observes, calls, and serves.
 */
export interface PluginWiring {
  /** Add: the registries and slots it adds items to, but for parts and the channels it serves. */
  readonly adds: readonly RegistryUse[];
  /** Intercept: the parts it draws (the `part.*` slots it adds to), which is how a web half takes over a piece. */
  readonly parts: readonly RegistryUse[];
  /** Intercept: the hooks it handles. */
  readonly hooks: readonly WiredHook[];
  /** Observe: the events it hears. */
  readonly observes: readonly string[];
  /** Call: each capability it requires, with the plugins providing it (the enabled one first), or its app providing it itself. */
  readonly calls: readonly { readonly key: string; readonly providers: readonly PluginStatus[]; readonly runtime: boolean }[];
  /** Serve: each capability it provides, with the plugins requiring it. */
  readonly serves: readonly { readonly key: string; readonly users: readonly string[] }[];
  /** Serve: the channels it serves to clients (`Channels`), by id. */
  readonly channels: readonly string[];
}

/** A part's slot (`part.*`): a web half adding to one draws that part. */
const isPart = (name: string) => name.startsWith("part.");

/** How `plugin` meets the rest of `plugins` (`PluginWiring`); `runtime` is what their app provides itself, by capability key. */
export const pluginWiring = (plugins: readonly PluginStatus[], plugin: PluginStatus, runtime: readonly string[]): PluginWiring => {
  const contributes = plugin.contributes ?? [];
  // A plugin may handle one hook more than once at one phase and order: its nth such handler is the nth in the chain.
  const seen = new Map<string, number>();
  return {
    adds: contributes.filter((registry) => registry.name !== Channels.name && !isPart(registry.name)),
    parts: contributes.filter((registry) => isPart(registry.name)),
    hooks: (plugin.hooks ?? []).map((hook) => {
      const chain = hookChain(plugins, hook.name);
      const key = JSON.stringify([hook.name, hook.phase, hook.order]);
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      const places = chain.flatMap((entry, index) => (entry.plugin === plugin.id && entry.phase === hook.phase && entry.order === hook.order ? [index] : []));
      return { ...hook, position: (places[nth] ?? -1) + 1, of: chain.length };
    }),
    observes: plugin.observes ?? [],
    calls: plugin.requires.map((key) => {
      const providing = plugins.filter((other) => other.provides.includes(key));
      return {
        key,
        providers: [...providing.filter((other) => other.enabled), ...providing.filter((other) => !other.enabled)],
        runtime: runtime.includes(key),
      };
    }),
    serves: plugin.provides.map((key) => ({ key, users: usersOf(plugins, key) })),
    channels: contributes.find((registry) => registry.name === Channels.name)?.keys ?? [],
  };
};

/** Whether a restart would do anything without `force`: the plugin failed, or a failed dependency halted it. */
export const recoverable = (plugin: { readonly state?: string | undefined; readonly haltedBy?: string | undefined }): boolean =>
  plugin.state === "failed" || (plugin.state === "closed" && plugin.haltedBy !== undefined);

/** `plugins` as their kernel runs them; `runtime` is what the app provides itself, by capability key. */
export const kernelOf = (plugins: readonly PluginStatus[], runtime: readonly string[]): KernelView => {
  const hooks = new Map<string, ChainPlace[]>();
  const registries = new Map<string, { plugin: string; items: number; keys: readonly string[] }[]>();
  const events = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const hook of plugin.hooks ?? []) hooks.set(hook.name, [...(hooks.get(hook.name) ?? []), placeOf(plugin.id, hook)]);
    for (const registry of plugin.contributes ?? [])
      registries.set(registry.name, [...(registries.get(registry.name) ?? []), { plugin: plugin.id, items: registry.items, keys: registry.keys ?? [] }]);
    for (const event of plugin.observes ?? []) events.set(event, [...(events.get(event) ?? []), plugin.id]);
  }
  const provided = new Set(runtime);
  const keys = [...new Set([...runtime, ...plugins.flatMap((plugin) => [...plugin.provides, ...plugin.requires])])].sort();
  return {
    hooks: [...hooks].map(([name, handlers]) => ({ name, handlers: handlers.sort(runOrder) })).sort(byName),
    registries: [...registries]
      .map(([name, contributors]) => ({ name, contributors, items: contributors.reduce((sum, contributor) => sum + contributor.items, 0) }))
      .sort(byName),
    events: [...events].map(([name, observers]) => ({ name, observers })).sort(byName),
    capabilities: keys.map((key) => ({
      key,
      providers: plugins
        .filter((plugin) => plugin.provides.includes(key))
        .map((plugin) => ({ plugin: plugin.id, state: plugin.state, enabled: plugin.enabled })),
      runtime: provided.has(key),
      users: usersOf(plugins, key),
    })),
  };
};

/** A table: column names and rows of text cells. */
export interface Table {
  readonly title?: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

const cell = (value: unknown): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));

const tableOf = (rows: readonly unknown[], title?: string): Table | undefined => {
  if (!rows.every(Predicate.isObject)) return undefined;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { ...(title === undefined ? {} : { title }), columns, rows: rows.map((row) => columns.map((column) => cell(row[column]))) };
};

/**
 * An inspector's snapshot as tables, when it has their shape: an array of
 * objects is one table (columns from their keys); an object whose values are
 * such arrays is a table per key. Undefined for any other shape, which shows
 * as JSON.
 */
export const tablesOf = (value: unknown): readonly Table[] | undefined => {
  if (Array.isArray(value)) {
    const table = tableOf(value);
    return table === undefined ? undefined : [table];
  }
  if (!Predicate.isObject(value)) return undefined;
  const tables: Table[] = [];
  for (const [key, rows] of Object.entries(value)) {
    const table = Array.isArray(rows) ? tableOf(rows, key) : undefined;
    if (table === undefined) return undefined;
    tables.push(table);
  }
  return tables;
};
