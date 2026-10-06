import { Order } from "effect";
import type { PluginStatus } from "./rpc.ts";

/*
 * A composition as its kernel runs it, turned from per-plugin statuses (what
 * each plugin provides, requires, intercepts, observes, and contributes) into
 * per-thing views: each hook's chain in run order, each registry's
 * contributors, each event's observers, each capability's provider and
 * dependents. The same for the host and the web app: both run the core. What
 * the devtools' kernel panels and `lemma kernel` show.
 */

export interface HookChain {
  readonly name: string;
  /** In run order: lower `order` first, then plugin id. */
  readonly handlers: readonly { readonly plugin: string; readonly order: number }[];
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
  readonly users: readonly string[];
}

export interface KernelView {
  readonly hooks: readonly HookChain[];
  readonly registries: readonly RegistryView[];
  readonly events: readonly EventView[];
  readonly capabilities: readonly CapabilityView[];
}

const byName = Order.mapInput(Order.string, (item: { readonly name: string }) => item.name);
const runOrder = (a: { readonly plugin: string; readonly order: number }, b: { readonly plugin: string; readonly order: number }) =>
  a.order - b.order || Order.string(a.plugin, b.plugin);

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
  plugins
    .flatMap((plugin) => plugin.hooks?.filter((hook) => hook.name === name).map((hook) => ({ plugin: plugin.id, order: hook.order })) ?? [])
    .sort(runOrder);

/** Whether a restart would do anything without `force`: the plugin failed, or a failed dependency halted it. */
export const recoverable = (plugin: { readonly state?: string | undefined; readonly haltedBy?: string | undefined }): boolean =>
  plugin.state === "failed" || (plugin.state === "closed" && plugin.haltedBy !== undefined);

export const kernelOf = (plugins: readonly PluginStatus[]): KernelView => {
  const hooks = new Map<string, { plugin: string; order: number }[]>();
  const registries = new Map<string, { plugin: string; items: number; keys: readonly string[] }[]>();
  const events = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const hook of plugin.hooks ?? []) hooks.set(hook.name, [...(hooks.get(hook.name) ?? []), { plugin: plugin.id, order: hook.order }]);
    for (const registry of plugin.contributes ?? [])
      registries.set(registry.name, [...(registries.get(registry.name) ?? []), { plugin: plugin.id, items: registry.items, keys: registry.keys ?? [] }]);
    for (const event of plugin.observes ?? []) events.set(event, [...(events.get(event) ?? []), plugin.id]);
  }
  const keys = [...new Set(plugins.flatMap((plugin) => [...plugin.provides, ...plugin.requires]))].sort();
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
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const tableOf = (rows: readonly unknown[], title?: string): Table | undefined => {
  if (!rows.every(isRecord)) return undefined;
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
  if (!isRecord(value)) return undefined;
  const tables: Table[] = [];
  for (const [key, rows] of Object.entries(value)) {
    const table = Array.isArray(rows) ? tableOf(rows, key) : undefined;
    if (table === undefined) return undefined;
    tables.push(table);
  }
  return tables;
};
