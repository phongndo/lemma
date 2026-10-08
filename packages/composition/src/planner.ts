import { Predicate, Result, Schema, SchemaIssue } from "effect";
import type { PluginRow } from "@lemma/contracts";
import { checkComposition, Diagnostic } from "@lemma/core";
import type { Capability, Composition, CompositionError, Plugin, PluginEntry } from "@lemma/core";
import { reservedKeys, resolveComposition } from "./catalog.ts";
import type { KnownPlugin, Resolved } from "./catalog.ts";

/*
 * One planner for the host's plugins and the web app's, so both decide alike
 * what runs: browser-safe, like `catalog.ts`.
 */

/** A plugin from a file, with which directory it came from. */
export interface LocalPlugin {
  readonly plugin: Plugin;
  readonly source: "user" | "project";
}

export interface PlanInput {
  /** The app's own plugins, in order. */
  readonly bundled: readonly Plugin[];
  /** Plugins from files, in load order: one with a bundled id runs in its place, and later ones win. */
  readonly local: readonly LocalPlugin[];
  /** The config files' rows, merged. */
  readonly rows: Readonly<Record<string, PluginRow>>;
  /** Plugins that always run, with everything they need; a problem in one stops the start. */
  readonly pinned?: readonly string[];
  /** Config the app supplies beneath a row's `config`, key by key (the host's `staticDir`). */
  readonly defaults?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Rows the app sets whatever the files say (the host plugin's paths). */
  readonly fixed?: Readonly<Record<string, PluginEntry>>;
  /** Whether plugins from files must start unless their row says `required: false` (the host's policy). */
  readonly localRequired?: boolean;
  /** What the app provides itself (its `provide.provides`): every plugin has it, and a plugin providing it cannot run. */
  readonly provided?: readonly Capability[];
}

export interface Plan {
  /** Bundled plugins in order, each replaced in place by a local one with its id; other local plugins after them. */
  readonly known: readonly KnownPlugin[];
  /** Every known plugin with its row: the defaults, patched by rows. What is enabled is the files' choice. */
  readonly composition: Composition;
  /** What runs: `composition` minus what is off, left out, or needs either. */
  readonly resolved: Resolved;
  /** What must start (pinned and required plugins); everything they need must too (`partialStart`). */
  readonly required: readonly string[];
  /** Enabled plugins left out because they cannot run, each with why. */
  readonly problems: ReadonlyMap<string, string>;
  /** Errors: the plan must not run (a required plugin cannot). Warnings: what was left out or ignored, and why. */
  readonly diagnostics: readonly Diagnostic[];
}

const keys = (plugin: Plugin) => new Set(plugin.provides.map((tag) => tag.key));

/** `lemma/api@2`: a capability naming the API version a plugin is written for (`HostApi`, `UiApi`). */
const API_KEY = /^(.+)\/api@(\d+)$/;

/**
 * The composition to run, and what is left out of it. Every known plugin runs
 * by default. A local plugin with a bundled plugin's id runs instead of it; one
 * providing what a bundled plugin provides turns that plugin off unless a row
 * decides, so adding a file is enough to replace a part. Rows then patch by id.
 *
 * A plugin that cannot run (its config does not decode, it is written for an
 * API version nobody provides, it competes with another provider, it provides
 * what the app provides itself) is left out with the plugins that need it, and
 * the problem is a warning; one that is required (pinned, a row's `required:
 * true`, or a file's plugin under `localRequired`) or needed by one makes the
 * problem an error instead. What the app provides needs no plugin, so
 * requiring it never makes a plugin offering it needed. A replacement left
 * out is never swapped back for the bundled plugin it replaced: what runs
 * only ever shrinks from what was asked for.
 */
export function planComposition(input: PlanInput): Plan {
  const pinned = new Set(input.pinned ?? []);
  const provided = input.provided ?? [];
  const appKeys = new Set(provided.map((tag) => tag.key));
  const reserved = reservedKeys(provided);
  const rows = input.rows;
  const diagnostics: Diagnostic[] = [];

  const byId = new Map<string, KnownPlugin>();
  for (const plugin of input.bundled) byId.set(plugin.id, { plugin, source: "bundled" });
  for (const { plugin, source } of input.local) {
    const previous = byId.get(plugin.id);
    const shadows = previous?.source === "bundled" || previous?.shadows === true;
    byId.set(plugin.id, { plugin, source, ...(shadows ? { shadows } : {}) });
  }
  const known = [...byId.values()];

  const plugins: Record<string, PluginEntry> = {};
  for (const { plugin } of known) {
    const base = input.defaults?.[plugin.id];
    plugins[plugin.id] = base === undefined ? {} : { config: base };
  }
  for (const { plugin, source } of known) {
    if (source === "bundled" || rows[plugin.id]?.enabled === false) continue;
    const provides = keys(plugin);
    for (const other of known) {
      // A row that decides, or a plugin that must run, keeps it on: two providers are then the planner's to report.
      const decided = rows[other.plugin.id]?.enabled !== undefined || rows[other.plugin.id]?.required === true;
      if (other.source !== "bundled" || decided || pinned.has(other.plugin.id)) continue;
      if ([...keys(other.plugin)].some((key) => provides.has(key))) plugins[other.plugin.id] = { ...plugins[other.plugin.id], enabled: false };
    }
  }
  for (const [id, row] of Object.entries(rows)) {
    if (plugins[id] === undefined) {
      // A plugin renamed or removed in an update leaves its row behind: nothing to run, so nothing to refuse.
      const required = row.required === true && row.enabled !== false;
      diagnostics.push(
        new Diagnostic({
          severity: required ? "error" : "warning",
          pluginId: id,
          message: required ? `"${id}" is required, but no plugin has that id` : `The row for "${id}" names no plugin; it is ignored`,
          suggestion: `Remove the "${id}" row, or add the plugin`,
        }),
      );
      continue;
    }
    plugins[id] = entryOf(plugins[id]!, row, input.defaults?.[id]);
  }
  for (const [id, entry] of Object.entries(input.fixed ?? {})) plugins[id] = entry;
  const composition: Composition = { plugins };

  const sourceOf = (id: string) => byId.get(id)?.source;
  const requested = new Set(pinned);
  for (const { plugin, source } of known) {
    const row = rows[plugin.id];
    if (row?.enabled === false) continue;
    if (row?.required === true || (input.localRequired === true && source !== "bundled" && row?.required !== false)) requested.add(plugin.id);
  }

  // Leave out what cannot run until the rest plans, as the kernel would plan it.
  const problems = new Map<string, string>();
  const suggestions = new Map<string, string>();
  // Per plugin that must run and cannot: the problem, and what to do about it.
  const fatal = new Map<string, { readonly problem: string; readonly fix: string }>();
  /** Errors naming no plugin: the app's own list of what it provides is wrong (a reserved key, or one listed twice). */
  const appProblems = new Set<string>();
  const effective = (): Composition => ({
    plugins: Object.fromEntries(Object.entries(plugins).map(([id, entry]) => [id, problems.has(id) ? { ...entry, enabled: false } : entry])),
  });
  let resolved = resolveComposition(known, effective(), { pinned: [...pinned], provided });
  for (let round = 0; round <= known.length; round++) {
    const running = known.filter(({ plugin }) => isRunning(resolved.composition, plugin.id)).map(({ plugin }) => plugin);
    const configs = Object.fromEntries(running.map((plugin) => [plugin.id, resolved.composition.plugins[plugin.id]?.config]));
    const errors = checkComposition(running, configs, { provided });
    if (errors.length === 0) break;
    const needed = closure(known, effective(), requested, reserved);
    let progressed = false;
    for (const error of errors) {
      const problem = describe(error, running, configs, known, appKeys);
      const target = targetOf(error, (id) => !needed.has(id), sourceOf);
      if (target === undefined) {
        if (error.plugins[0] === undefined) appProblems.add(problem);
        else fatal.set(error.plugins[0], { problem, fix: fixFor(error, appKeys) });
        continue;
      }
      if (!problems.has(target)) {
        problems.set(target, problem);
        suggestions.set(target, suggestionFor(error, appKeys));
        progressed = true;
      }
    }
    if (!progressed) break;
    resolved = resolveComposition(known, effective(), { pinned: [...pinned], provided });
  }

  for (const problem of appProblems) {
    diagnostics.push(new Diagnostic({ severity: "error", message: problem, suggestion: "Fix the list of capabilities the app provides (its `provide`)" }));
  }
  for (const [id, { problem, fix }] of fatal) {
    const why = pinned.has(id) ? "the app cannot run without it" : requested.has(id) ? "it is required" : "a required plugin needs it";
    diagnostics.push(
      new Diagnostic({
        severity: "error",
        pluginId: id,
        message: `"${id}" cannot run, and ${why}: ${problem}`,
        suggestion: requested.has(id) && !pinned.has(id) ? `${fix}, or set "required": false in its row to start without it` : fix,
      }),
    );
  }
  for (const [id, problem] of problems) {
    diagnostics.push(new Diagnostic({ severity: "warning", pluginId: id, message: `"${id}" is left out: ${problem}`, suggestion: suggestions.get(id)! }));
  }
  // What must run and does not, though nothing failed to plan: a row turned off what it needs.
  const absent = [...requested].filter((id) => byId.has(id) && !fatal.has(id) && !isRunning(resolved.composition, id));
  for (const id of absent) {
    const by = resolved.haltedBy.get(id);
    const root = by === undefined ? undefined : rootOf(resolved, by);
    const chain = by === undefined ? "" : root === by ? `: it needs "${by}"` : `: it needs "${by}", which needs "${root}"`;
    const why = root === undefined ? "" : `, and "${root}" is ${problems.has(root) ? "left out" : "turned off"}`;
    diagnostics.push(
      new Diagnostic({
        severity: "error",
        pluginId: id,
        message: `"${id}" is required, but it is not loaded${chain}${why}`,
        suggestion: root === undefined ? `Turn "${id}" on` : `Turn "${root}" on, or set "required": false in the row for "${id}"`,
      }),
    );
  }
  for (const [id, by] of resolved.haltedBy) {
    if (absent.includes(id)) continue;
    const root = rootOf(resolved, id);
    const chain = root === by ? `"${by}"` : `"${by}", which needs "${root}"`;
    const left = problems.has(root);
    diagnostics.push(
      new Diagnostic({
        severity: "warning",
        pluginId: id,
        message: `"${id}" is not loaded: it needs ${chain}, and "${root}" is ${left ? "left out" : "turned off"}`,
        suggestion: left ? `Fix "${root}" to load "${id}"` : `Turn "${root}" on to load "${id}"`,
      }),
    );
  }
  for (const id of resolved.overridden) {
    const root = resolved.locked.get(id)!;
    diagnostics.push(
      new Diagnostic({
        severity: "warning",
        pluginId: id,
        message:
          id === root ? `The row turning "${id}" off is ignored: the app cannot run without it` : `The row turning "${id}" off is ignored: "${root}" needs it`,
        suggestion: `Remove its "enabled" row`,
      }),
    );
  }
  for (const { plugin } of known) {
    if (!isRunning(resolved.composition, plugin.id) || plugin.config === undefined) continue;
    const unused = unusedKeys(plugin.config, resolved.composition.plugins[plugin.id]?.config);
    if (unused.length === 0) continue;
    diagnostics.push(
      new Diagnostic({
        severity: "warning",
        pluginId: plugin.id,
        message: `The config for "${plugin.id}" sets ${unused.join(", ")}, which it does not use (renamed or removed?)`,
        suggestion: `Remove ${unused.length === 1 ? "it" : "them"}, or see the plugin's README for its settings`,
      }),
    );
  }

  return { known, composition, resolved, required: [...requested].filter((id) => byId.has(id)), problems, diagnostics };
}

/** A row over an entry: `config` replaces the entry's, keeping app defaults beneath it key by key. `required` is the planner's. */
function entryOf(entry: PluginEntry, row: PluginRow, base: Readonly<Record<string, unknown>> | undefined): PluginEntry {
  const { required: _, ...rest } = row;
  // JSON cannot express undefined, so a decoded row carries only the keys its file wrote.
  const merged = { ...entry, ...rest } as PluginEntry;
  return base !== undefined && Predicate.isObject(row.config) ? { ...merged, config: { ...base, ...row.config } } : merged;
}

const isRunning = (composition: Composition, id: string) => composition.plugins[id] !== undefined && composition.plugins[id]?.enabled !== false;

/** `ids` and every plugin providing what they need, transitively: what must start for them to. No plugin provides a `reserved` key. */
function closure(known: readonly KnownPlugin[], composition: Composition, ids: ReadonlySet<string>, reserved: ReadonlySet<string>): Set<string> {
  const byId = new Map(known.map((entry) => [entry.plugin.id, entry.plugin]));
  const providers = new Map<string, string>();
  for (const { plugin } of known) {
    if (!isRunning(composition, plugin.id)) continue;
    for (const tag of plugin.provides) if (!reserved.has(tag.key) && !providers.has(tag.key)) providers.set(tag.key, plugin.id);
  }
  const found = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const plugin = byId.get(stack.pop()!);
    if (plugin === undefined || found.has(plugin.id)) continue;
    found.add(plugin.id);
    for (const tag of plugin.requires) {
      const provider = providers.get(tag.key);
      if (provider !== undefined) stack.push(provider);
    }
  }
  return found;
}

/** Which plugin to leave out for `error`; undefined when every candidate must run. A replacement goes before a bundled plugin. */
function targetOf(error: CompositionError, optional: (id: string) => boolean, sourceOf: (id: string) => string | undefined): string | undefined {
  switch (error.reason) {
    case "DuplicateCapability":
    case "DependencyCycle": {
      const candidates = [...new Set(error.plugins)].reverse().filter(optional);
      return candidates.find((id) => sourceOf(id) !== "bundled") ?? candidates[0];
    }
    case "InvalidId":
    case "DuplicatePlugin":
    case "ReservedCapability":
    case "MissingCapability":
    case "InvalidConfig": {
      const id = error.plugins[0];
      return id !== undefined && optional(id) ? id : undefined;
    }
    default:
      return undefined;
  }
}

/** The problem in a line, for the plugin it leaves out. `appKeys` are what the app provides itself. */
function describe(
  error: CompositionError,
  running: readonly Plugin[],
  configs: Readonly<Record<string, unknown>>,
  known: readonly KnownPlugin[],
  appKeys: ReadonlySet<string>,
): string {
  if (error.plugins.length === 0) return error.message;
  switch (error.reason) {
    case "InvalidConfig": {
      const plugin = running.find((candidate) => candidate.id === error.plugins[0]);
      const decoded = plugin?.config === undefined ? undefined : Schema.decodeUnknownResult(plugin.config)(configs[plugin.id] ?? {});
      const issue =
        decoded !== undefined && Result.isFailure(decoded) ? SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues[0] : undefined;
      const at = issue?.path?.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number") ?? [];
      return `its config is invalid${at.length ? ` at ${at.join(".")}` : ""}: ${issue?.message ?? error.message}`;
    }
    case "MissingCapability": {
      const api = API_KEY.exec(error.capability ?? "");
      if (api === null) return `it needs "${error.capability}", which no plugin provides`;
      const offered = [...known.flatMap(({ plugin }) => plugin.provides.map((tag) => tag.key)), ...appKeys]
        .map((key) => API_KEY.exec(key))
        .filter((match): match is RegExpExecArray => match !== null && match[1] === api[1])
        .map((match) => match[2]!);
      return `it is written for version ${api[2]} of the ${api[1]} API, and this Lemma provides ${offered.length ? `version ${[...new Set(offered)].join(", ")}` : "no version of it"}`;
    }
    case "DuplicateCapability":
      return `it provides "${error.capability}", as ${error.plugins.map((id) => `"${id}"`).join(" and ")} both do`;
    case "ReservedCapability":
      return appKeys.has(error.capability ?? "") ? `it provides "${error.capability}", which the app provides itself` : error.message;
    default:
      return error.message;
  }
}

/** For a plugin offering what the app provides: it cannot replace the app's service, only change what that service does. */
const stopProviding = (capability: string | undefined) => `Stop providing "${capability}": the app provides it`;

/** What to do about `error` for the plugin it leaves out. */
function suggestionFor(error: CompositionError, appKeys: ReadonlySet<string>): string {
  switch (error.reason) {
    case "InvalidConfig":
      return `Fix its "config" row (its README lists the current settings)`;
    case "MissingCapability":
      return API_KEY.test(error.capability ?? "") ? "Update the plugin for this version of Lemma, or turn it off" : "Fix the plugin, or turn it off";
    case "DuplicateCapability":
      return "Turn one of them off";
    case "ReservedCapability":
      return appKeys.has(error.capability ?? "") ? `${stopProviding(error.capability)}, or turn it off` : "Fix the plugin, or turn it off";
    default:
      return "Fix the plugin, or turn it off";
  }
}

/** What to do about `error` for a plugin that must run, so cannot simply be turned off. */
function fixFor(error: CompositionError, appKeys: ReadonlySet<string>): string {
  return error.reason === "ReservedCapability" && appKeys.has(error.capability ?? "") ? stopProviding(error.capability) : "Fix it";
}

/** The plugin a halted one ultimately waits on: the first in its chain that is off or left out. */
function rootOf(resolved: Resolved, id: string): string {
  let current = id;
  for (let next = resolved.haltedBy.get(current); next !== undefined; next = resolved.haltedBy.get(current)) current = next;
  return current;
}

/** Keys `config` sets that `schema` does not read: a setting renamed or removed since the row was written. */
function unusedKeys(schema: Schema.Decoder<unknown>, config: unknown): string[] {
  if (!Predicate.isObject(config) || Result.isFailure(Schema.decodeUnknownResult(schema)(config))) return [];
  const strict = Schema.decodeUnknownResult(schema, { onExcessProperty: "error", errors: "all" })(config);
  if (Result.isSuccess(strict)) return [];
  return unexpectedKeys(strict.failure.issue);
}

/** The paths an issue reports as excess properties. */
function unexpectedKeys(issue: SchemaIssue.Issue, path: readonly PropertyKey[] = []): string[] {
  switch (issue._tag) {
    case "UnexpectedKey":
      return [path.map(String).join(".")];
    case "Pointer":
      return unexpectedKeys(issue.issue, [...path, ...issue.path]);
    case "Filter":
    case "Encoding":
      return unexpectedKeys(issue.issue, path);
    case "Composite":
    case "AnyOf":
      return issue.issues.flatMap((inner) => unexpectedKeys(inner, path));
    default:
      return [];
  }
}
