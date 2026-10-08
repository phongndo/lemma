import { Cause, Context, Schema } from "effect";
import type { Effect } from "effect";
import { Event } from "@lemma/core";
import type { CoreClosed, PluginFault, PluginState, ReloadError, ReloadReport, RestartOptions } from "@lemma/core";
import type { PluginStatus } from "./status.ts";

/**
 * Locations the host resolves once. Plugins never compute paths themselves.
 * Defaults: `~/.lemma` for user data; `<cwd>/.lemma` for project data.
 */
export class Paths extends Context.Service<
  Paths,
  {
    /** `~/.lemma` (or `$LEMMA_HOME`). */
    readonly home: string;
    /** `<home>/config.jsonc` */
    readonly userConfig: string;
    /** `<cwd>/.lemma/config.jsonc` */
    readonly projectConfig: string;
    /** `<home>/auth.json` */
    readonly auth: string;
    /** `<home>/sessions` */
    readonly sessions: string;
    /** Working directory the host was started in; the default for new sessions. */
    readonly cwd: string;
  }
>()("lemma/Paths") {}

/**
 * One plugin's row in a config file: whether it runs, with what config, and
 * whether the host may start without it. `required: true` makes a plugin that
 * cannot run stop the host from starting rather than be left out (a plugin
 * enforcing a policy, such as approvals); plugins from your own files are
 * required unless their row says `required: false`.
 */
export const PluginRow = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  config: Schema.optional(Schema.Unknown),
  required: Schema.optional(Schema.Boolean),
});
export type PluginRow = typeof PluginRow.Type;

/**
 * A change to one plugin's row. `config` replaces the row's whole config;
 * `values` sets single config keys and keeps the others (`null` removes a key),
 * which is how a settings form edits one field without restating the rest.
 * `add` and `remove` edit list keys whose items have an `id` (the llm plugin's
 * `providers`) without reading the list, which may hold secrets: `add` puts
 * each item at the end, or in place of the item with its id; `remove` drops
 * the items with those ids.
 */
export const PluginChange = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  config: Schema.optional(Schema.Unknown),
  values: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  add: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))),
  remove: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});
export type PluginChange = typeof PluginChange.Type;

/** Which config file a change is written to. The project file needs the project to be trusted. */
export const ConfigScope = Schema.Literals(["user", "project"]);
export type ConfigScope = typeof ConfigScope.Type;

/**
 * Composition file (JSONC). User and project files merge: project rows override
 * user rows by plugin id; `config` objects are replaced, not deep-merged.
 * A project's file and plugins load only when the user file trusts the project.
 * `ui` rows configure the web app's plugins the same way; the web app plans
 * that composition itself, because only it can load those plugins.
 */
export const ConfigFile = Schema.Struct({
  /** User file only: absolute directories whose projects (and their subdirectories) may configure the host and load plugins. */
  trustedProjects: Schema.optional(Schema.Array(Schema.String)),
  plugins: Schema.optional(Schema.Record(Schema.String, PluginRow)),
  ui: Schema.optional(Schema.Record(Schema.String, PluginRow)),
});
export type ConfigFile = typeof ConfigFile.Type;

/** Where a plugin's definition came from: the app, `<home>/plugins`, or a trusted project's `.lemma/plugins`. */
export const PluginSource = Schema.Literals(["bundled", "user", "project"]);
export type PluginSource = typeof PluginSource.Type;

/** A hook a plugin intercepts, with its handler's order (lower runs first). */
export const HookUse = Schema.Struct({ name: Schema.String, order: Schema.Number });
export type HookUse = typeof HookUse.Type;

/** A registry a plugin contributes to: how many of its items are there, and their keys where the registry names items. */
export const RegistryUse = Schema.Struct({ name: Schema.String, items: Schema.Number, keys: Schema.optional(Schema.Array(Schema.String)) });
export type RegistryUse = typeof RegistryUse.Type;

/** A fault as clients keep it: flattened to text, with when it was reported. */
export const FaultRecord = Schema.Struct({
  /** The core's fault sequence; a gap means faults were dropped. */
  sequence: Schema.Number,
  /** Epoch ms when the app received it. */
  at: Schema.Number,
  phase: Schema.String,
  operation: Schema.optional(Schema.String),
  message: Schema.String,
});
export type FaultRecord = typeof FaultRecord.Type;

/** A fault in a line: the core's message, then what caused it. */
export const faultMessage = (fault: { readonly message: string; readonly cause: Cause.Cause<unknown> }): string => {
  const cause = Cause.squash(fault.cause);
  return `${fault.message}: ${cause instanceof Error ? cause.message : String(cause)}`;
};

/**
 * One plugin the host knows, running or not: what clients see of it
 * (`PluginStatus`), with the core's own `state`, absent while the plugin is not
 * loaded, and its `fault`.
 */
export type PluginInfo = Omit<PluginStatus, "state" | "fault"> & {
  readonly state?: PluginState;
  readonly fault?: PluginFault;
};

/** Identifies the running plugin set, so a logged request can name what produced it. */
export const CompositionInfo = Schema.Struct({
  /** Stable hash of plugin ids, versions, and configs. Changes on every applied reload that changes any of them. */
  id: Schema.String,
  plugins: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.optional(Schema.String) })),
});
export type CompositionInfo = typeof CompositionInfo.Type;

/**
 * A message for the user that is not tied to a session: login progress, a
 * device code to enter, a URL to open, a plugin fault, a reload outcome.
 */
export const NoticePayload = Schema.Struct({
  level: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String,
  source: Schema.optional(Schema.String),
  links: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, label: Schema.optional(Schema.String) }))),
  /** A code the user types elsewhere (device login). */
  code: Schema.optional(Schema.String),
  /**
   * What it belongs to, as an `InteractionOrigin`: a login's link and code
   * carry `login:<provider>`, so a client can show them with that login's
   * questions rather than on their own.
   */
  origin: Schema.optional(Schema.String),
  /**
   * What a login's notice is, so a client need not guess from its order:
   * `sign-in` names the page to open (its first link), `device-code` the code
   * to enter (`code`) and where, `progress` a step under way, `signed-in` and
   * `ended` the login's success and its failure or cancellation. A login's
   * other notices (documentation links, say) have none.
   */
  kind: Schema.optional(Schema.Literals(["sign-in", "device-code", "progress", "signed-in", "ended"])),
});
export type NoticePayload = typeof NoticePayload.Type;
export const Notice = Event.make<NoticePayload>("lemma/notice");

/**
 * What a configure did. `deferred`: the change restarts the transport serving
 * this call, so it was checked and written, and applies once the reply is sent;
 * the report is then empty, and clients reconnect. A deferred change that still
 * fails is undone in the file and reported as an error `Notice`.
 */
export interface ConfigureReport extends ReloadReport {
  readonly deferred?: boolean;
}

/**
 * The host contracts' API version: a major number that changes when one of
 * them changes incompatibly. A plugin written for a version requires
 * `HostApi(version)`, and the host plugin provides each version it supports,
 * so a plugin written for another is left out with a message naming the
 * version rather than failing at some later call. A breaking change gives the
 * changed capability a new key, keeping the old one provided by an adapter for
 * as long as its version is supported.
 */
export const HOST_API = 1;
/** A plugin written for host API `version` requires this; the host plugin provides the versions it supports. */
export const HostApi = (version: number): Context.Key<`lemma/api@${number}`, number> => Context.Service<`lemma/api@${number}`, number>(`lemma/api@${version}`);

/**
 * Handle on the loader, provided by the host application (which owns it) so
 * transports and UIs can inspect and change the running composition without
 * reaching into the kernel.
 */
export class HostControl extends Context.Service<
  HostControl,
  {
    /** Every known plugin, enabled or not. */
    readonly plugins: Effect.Effect<readonly PluginInfo[]>;
    readonly composition: Effect.Effect<CompositionInfo>;
    /** A failed plugin and what it halted; with `force`, a running one too, unless the app depends on it (a `ReloadError` says so). */
    readonly restart: (pluginId: string, options?: RestartOptions) => Effect.Effect<void, ReloadError | CoreClosed>;
    /** Re-read the config files and apply the resulting composition. */
    readonly reload: Effect.Effect<ReloadReport, ReloadError>;
    /**
     * Write plugin rows into a config file (the user's by default) and apply the
     * result. A change the host rejects is undone in the file, so a bad row never
     * outlives the call; the diagnostics say why.
     */
    readonly configure: (
      plugins: Readonly<Record<string, PluginChange>>,
      options?: { readonly scope?: ConfigScope },
    ) => Effect.Effect<ConfigureReport, ReloadError>;
    /** The web app's rows and files. */
    readonly ui: Effect.Effect<UiComposition>;
    /** Write `ui` rows into a config file; web apps apply them when `UiChanged` arrives. */
    readonly configureUi: (
      plugins: Readonly<Record<string, PluginChange>>,
      options?: { readonly scope?: ConfigScope },
    ) => Effect.Effect<UiComposition, ReloadError>;
  }
>()("lemma/HostControl") {}

/**
 * A file in `<home>/ui` or a trusted project's `.lemma/ui` that the web app
 * loads: a script is an ES module whose default export makes UI plugins, a
 * style is a stylesheet applied after the app's own.
 */
export const UiFile = Schema.Struct({
  name: Schema.String,
  source: Schema.Literals(["user", "project"]),
  kind: Schema.Literals(["script", "style"]),
  /** Where it is on the host. */
  path: Schema.String,
  /** Served by the transport under `/api` (it needs the token); changes when the file does. */
  url: Schema.String,
});
export type UiFile = typeof UiFile.Type;

/** What the web app needs to plan its own composition: the `ui` rows of both config files, and the files to load. */
export const UiComposition = Schema.Struct({
  plugins: Schema.Record(Schema.String, PluginRow),
  /** Per plugin id, the file whose row sets `enabled` (the project's wins). */
  enabledIn: Schema.Record(Schema.String, ConfigScope),
  /** Per plugin id, the file whose row sets `config`. */
  configIn: Schema.Record(Schema.String, ConfigScope),
  files: Schema.Array(UiFile),
});
export type UiComposition = typeof UiComposition.Type;

/** Emitted when the `ui` rows or UI files change, so web apps apply them. */
export const UiChanged = Event.make<UiComposition>("lemma/ui.changed");

/** Emitted after any composition change or plugin fault so clients can refresh plugin views. */
export const PluginsChanged = Event.make<{ readonly plugins: readonly PluginInfo[] }>("lemma/plugins.changed");
