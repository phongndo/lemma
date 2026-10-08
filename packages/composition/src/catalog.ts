import { configValues, describeConfig, faultMessage } from "@lemma/contracts";
import type { ConfigField, ConfigScope, FaultRecord, PluginChange, PluginInfo, PluginSource } from "@lemma/contracts";
import { Events, Hooks, PluginContext, Registries } from "@lemma/core";
import type { Composition, EventSnapshot, HookSnapshot, Plugin, PluginSnapshot, RegistrySnapshot, ReportedFault } from "@lemma/core";

/** The plugin that loads every other one. Defined here, in the browser-safe package, so the web app's catalog and the host share it. */
export const HOST_PLUGIN_ID = "host";

/** A plugin definition the app can load, with where it came from. */
export interface KnownPlugin {
  readonly plugin: Plugin;
  readonly source: PluginSource;
  /** A local plugin whose id a bundled plugin also has; the local one loads. */
  readonly shadows?: boolean;
}

/** Runtime capabilities the core supplies to every plugin; not dependencies between plugins. */
const builtins = new Set<string>([Hooks.key, PluginContext.key, Events.key, Registries.key]);

const isEnabled = (composition: Composition, id: string): boolean => composition.plugins[id]?.enabled !== false;

/** Capability key to the plugin id providing it. An enabled provider wins over a disabled one with the same capability. */
function providersOf(known: readonly KnownPlugin[], composition: Composition): Map<string, string> {
  const providers = new Map<string, string>();
  for (const pass of [true, false]) {
    for (const { plugin } of known) {
      if (isEnabled(composition, plugin.id) !== pass) continue;
      for (const tag of plugin.provides) if (!providers.has(tag.key)) providers.set(tag.key, plugin.id);
    }
  }
  return providers;
}

export interface Resolved {
  /** The composition to load: enabled plugins whose required capabilities all come from loaded plugins. */
  readonly composition: Composition;
  /** Enabled plugins left out, each with the plugin (off or itself left out) that provides a capability it requires. */
  readonly haltedBy: ReadonlyMap<string, string>;
  /** Plugins that cannot be turned off: each pinned plugin (mapped to itself) and every plugin it needs, directly or not, mapped to it. */
  readonly locked: ReadonlyMap<string, string>;
  /** Locked plugins whose row turned them off; they load regardless, and the app decides whether that is an error. */
  readonly overridden: readonly string[];
}

/**
 * Turning a plugin off takes its dependents out of the composition rather than
 * failing the whole change on a missing capability; they return when it does.
 * A pinned plugin, and a provider of everything it needs, stays on whatever
 * the rows say (the providers that are on, else the ones that are off).
 * Unknown ids and capabilities nobody provides are left to the planner, which
 * reports them.
 */
export function resolveComposition(known: readonly KnownPlugin[], rows: Composition, pinned: readonly string[] = []): Resolved {
  const locked = lockedBy(known, rows, pinned);
  const overridden = [...locked.keys()].filter((id) => rows.plugins[id]?.enabled === false);
  const composition: Composition =
    overridden.length === 0
      ? rows
      : { plugins: { ...rows.plugins, ...Object.fromEntries(overridden.map((id) => [id, { ...rows.plugins[id], enabled: true }])) } };
  const providers = providersOf(known, composition);
  const haltedBy = new Map<string, string>();
  const loaded = (id: string) => isEnabled(composition, id) && !haltedBy.has(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { plugin } of known) {
      if (!loaded(plugin.id) || composition.plugins[plugin.id] === undefined) continue;
      for (const tag of plugin.requires) {
        const provider = providers.get(tag.key);
        if (provider === undefined || builtins.has(tag.key) || loaded(provider)) continue;
        haltedBy.set(plugin.id, provider);
        changed = true;
        break;
      }
    }
  }
  const plugins = Object.fromEntries(Object.entries(composition.plugins).filter(([id]) => !haltedBy.has(id)));
  return { composition: { plugins }, haltedBy, locked, overridden };
}

/**
 * What a change to `ids` restarts: those plugins and, transitively, every
 * known plugin requiring a capability one of them provides, since the loader
 * reconstructs dependents along with what they depend on.
 */
export function restartedBy(known: readonly KnownPlugin[], ids: readonly string[]): Set<string> {
  const byId = new Map(known.map((entry) => [entry.plugin.id, entry.plugin]));
  const found = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const provides = new Set(byId.get(queue.shift()!)?.provides.map((tag) => tag.key) ?? []);
    for (const { plugin } of known) {
      if (found.has(plugin.id) || !plugin.requires.some((tag) => provides.has(tag.key))) continue;
      found.add(plugin.id);
      queue.push(plugin.id);
    }
  }
  return found;
}

/** Each pinned plugin (to itself) and every plugin it needs, directly or through other plugins, to the pinned plugin's id. */
function lockedBy(known: readonly KnownPlugin[], composition: Composition, pinned: readonly string[]): Map<string, string> {
  const byId = new Map(known.map((entry) => [entry.plugin.id, entry.plugin]));
  const providers = providersOf(known, composition);
  const locked = new Map<string, string>();
  for (const root of pinned) if (byId.has(root)) locked.set(root, root);
  for (const root of pinned) {
    const stack = [root];
    while (stack.length) {
      const plugin = byId.get(stack.pop()!);
      if (!plugin) continue;
      for (const tag of plugin.requires) {
        const provider = providers.get(tag.key);
        if (provider === undefined || locked.has(provider)) continue;
        locked.set(provider, root);
        stack.push(provider);
      }
    }
  }
  return locked;
}

interface CatalogInput {
  readonly known: readonly KnownPlugin[];
  /** As the config files describe it, before resolution: says what is enabled. */
  readonly composition: Composition;
  readonly resolved: Resolved;
  /** `core.inspect` of the running composition. */
  readonly snapshots: readonly PluginSnapshot[];
  /** `core.inspect` hooks, events, and registries: who intercepts, observes, and contributes what. */
  readonly hooks?: readonly HookSnapshot[];
  readonly events?: readonly EventSnapshot[];
  readonly registries?: readonly RegistrySnapshot[];
  /** Recent faults by plugin id, newest first (see `faultHistory`). */
  readonly faults?: ReadonlyMap<string, readonly FaultRecord[]>;
  /** Enabled plugins the planner left out, with why (`Plan.problems`). */
  readonly problems?: ReadonlyMap<string, string>;
  readonly enabledIn: Readonly<Record<string, ConfigScope>>;
  /** Per plugin id, the file whose row sets `config`. */
  readonly configIn?: Readonly<Record<string, ConfigScope>>;
  /** Plugins the app never turns off, each with the reason shown to the user. */
  readonly pinned: Readonly<Record<string, string>>;
}

const forms = new WeakMap<object, ConfigField[]>();
/** A plugin's settings form, projected once per config Schema. */
const formOf = (plugin: Plugin): ConfigField[] | undefined => {
  const schema = plugin.config;
  if (schema === undefined) return undefined;
  let fields = forms.get(schema);
  if (fields === undefined) {
    fields = describeConfig(schema);
    forms.set(schema, fields);
  }
  return fields;
};

/**
 * A capability has one provider, so turning on a plugin that provides what
 * another enabled plugin provides turns that plugin off in the same change:
 * that is how a provider is swapped for another. Rows already in `rows` are
 * left alone, so a caller can still enable both and let the planner refuse.
 */
export function withReplacements(
  known: readonly KnownPlugin[],
  composition: Composition,
  rows: Readonly<Record<string, PluginChange>>,
): Record<string, PluginChange> {
  const result: Record<string, PluginChange> = { ...rows };
  for (const [id, row] of Object.entries(rows)) {
    if (row.enabled !== true) continue;
    const plugin = known.find((entry) => entry.plugin.id === id)?.plugin;
    if (plugin === undefined) continue;
    const keys = new Set(plugin.provides.map((tag) => tag.key));
    for (const { plugin: other } of known) {
      if (other.id === id || result[other.id] !== undefined || !isEnabled(composition, other.id)) continue;
      if (other.provides.some((tag) => keys.has(tag.key))) result[other.id] = { enabled: false };
    }
  }
  return result;
}

/** Every known plugin in `known` order, joined with its config row and its core snapshot. */
export function catalog({
  known,
  composition,
  resolved,
  snapshots,
  hooks = [],
  events = [],
  registries = [],
  faults,
  problems,
  enabledIn,
  configIn = {},
  pinned,
}: CatalogInput): PluginInfo[] {
  const running = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return known.map(({ plugin, source, shadows }) => {
    const snapshot = running.get(plugin.id);
    const needs = resolved.locked.get(plugin.id);
    const locked = pinned[plugin.id] ?? (needs === undefined ? undefined : `Needed by ${needs}`);
    const haltedBy = snapshot?.haltedBy ?? resolved.haltedBy.get(plugin.id);
    const scope = enabledIn[plugin.id];
    const configScope = configIn[plugin.id];
    // The host's own config is the resolved paths, which no file sets.
    const fields = plugin.id === HOST_PLUGIN_ID ? undefined : formOf(plugin);
    const intercepts = hooks.flatMap((hook) =>
      hook.handlers.filter((handler) => handler.pluginId === plugin.id).map(({ order }) => ({ name: hook.name, order })),
    );
    const observes = events.filter((event) => event.observers.includes(plugin.id)).map((event) => event.name);
    const contributes = registries.flatMap((registry) => {
      const items = registry.items.filter((item) => item.pluginId === plugin.id);
      const keys = items.flatMap((item) => (item.key === undefined ? [] : [item.key]));
      return items.length === 0 ? [] : [{ name: registry.name, items: items.length, ...(keys.length === 0 ? {} : { keys }) }];
    });
    const history = faults?.get(plugin.id);
    const problem = problems?.get(plugin.id);
    return {
      id: plugin.id,
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
      source,
      ...(shadows ? { shadows } : {}),
      enabled: isEnabled(composition, plugin.id),
      ...(scope === undefined ? {} : { scope }),
      ...(locked === undefined ? {} : { locked }),
      provides: plugin.provides.map((tag) => tag.key),
      requires: plugin.requires.map((tag) => tag.key).filter((key) => !builtins.has(key)),
      ...(snapshot === undefined ? {} : { state: snapshot.state }),
      ...(snapshot?.fault === undefined ? {} : { fault: snapshot.fault }),
      ...(haltedBy === undefined ? {} : { haltedBy }),
      ...(problem === undefined ? {} : { problem }),
      ...(fields === undefined || fields.length === 0
        ? {}
        : { configFields: fields, config: configValues(plugin.config!, composition.plugins[plugin.id]?.config, fields) }),
      ...(configScope === undefined ? {} : { configScope }),
      ...(intercepts.length === 0 ? {} : { hooks: intercepts }),
      ...(observes.length === 0 ? {} : { observes }),
      ...(contributes.length === 0 ? {} : { contributes }),
      ...(history === undefined || history.length === 0 ? {} : { faults: history }),
    };
  });
}

/** A fault as text: the kernel's message and its cause, squashed. */
/**
 * Recent faults per plugin, newest first and at most `limit` each: the core
 * keeps only an instance's latest, and a restart clears it, so the history of
 * a flaky plugin lives here, fed by `core.faults`.
 */
export function faultHistory(limit = 20) {
  const byPlugin = new Map<string, FaultRecord[]>();
  return {
    record: (fault: ReportedFault, at: number = Date.now()): void => {
      const record: FaultRecord = {
        sequence: fault.sequence,
        at,
        phase: fault.phase,
        ...(fault.operation === undefined ? {} : { operation: fault.operation }),
        message: faultMessage(fault),
      };
      byPlugin.set(fault.pluginId, [record, ...(byPlugin.get(fault.pluginId) ?? [])].slice(0, limit));
    },
    get: (): ReadonlyMap<string, readonly FaultRecord[]> => byPlugin,
  };
}
