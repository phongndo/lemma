import { Cause, Context, Schema } from "effect";
import type { Effect } from "effect";
import { Event } from "@lemma/core";
import type { CoreClosed, PluginFault, PluginState, ReloadError, ReloadReport, RestartOptions } from "@lemma/core";
import type { PluginStatus } from "./status.ts";

/**
 * Locations the host resolves once: Lemma's home, the config files, and the
 * working directory. Defaults: `~/.lemma` for user data; `<cwd>/.lemma` for
 * project data. A plugin keeps its own files in `home`, under a name of its
 * own that its README gives.
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
    /** Working directory the host was started in. */
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
 * A plugin is one id with a host half, a web half, or both, and its one row
 * decides both: the host plans its halves and the web app its own, from the
 * same rows.
 */
export const ConfigFile = Schema.Struct({
  /** User file only: absolute directories whose projects (and their subdirectories) may configure the host and load plugins. */
  trustedProjects: Schema.optional(Schema.Array(Schema.String)),
  plugins: Schema.optional(Schema.Record(Schema.String, PluginRow)),
});
export type ConfigFile = typeof ConfigFile.Type;

/** Where a plugin's definition came from: the app, `<home>/plugins`, or a trusted project's `.lemma/plugins`. */
export const PluginSource = Schema.Literals(["bundled", "user", "project"]);
export type PluginSource = typeof PluginSource.Type;

/** A hook a plugin intercepts, with its handler's order (lower runs first). */
export const HookUse = Schema.Struct({
  name: Schema.String,
  /** Its phase, and that phase's place among the hook's phases (first 0), when the hook declares phases: they order before `order`. */
  phase: Schema.optional(Schema.String),
  rank: Schema.optional(Schema.Number),
  order: Schema.Number,
});
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
  /**
   * What it belongs to, as an `InteractionOrigin` (`session:<id>`), so a client can show it with that work's questions
   * rather than on its own.
   */
  origin: Schema.optional(Schema.String),
});
export type NoticePayload = typeof NoticePayload.Type;
export const Notice = Event.make<NoticePayload>("lemma/notice");

/**
 * What a configure or reload did. `deferred`: the change restarts a plugin
 * whose work is asking for it, which the change would otherwise wait on or cut
 * off: a call that plugin serves (as `llm.add-custom` saves the llm plugin's
 * config) or a command it registered (as `host.reload` restarts
 * `commands-host`), or the transport serving the request. So it was checked
 * (and a configure's rows written), and applies once that work has ended, the
 * reply sent; the report is then empty, and if the transport restarts,
 * clients reconnect. A deferred change that still fails is reported as an
 * error `Notice`, a configure's rows undone in the file. A stream a plugin
 * serves is no such work: it ends as soon as its plugin leaves, so a change it
 * asks for applies at once, ending it.
 */
export interface ChangeReport extends ReloadReport {
  readonly deferred?: boolean;
}

/** What a restart did. `deferred`: as for a configure or reload (`ChangeReport`), the plugin restarting once the work asking for it has ended. */
export interface RestartReport {
  readonly deferred?: boolean;
}

/**
 * The host contracts' API version: a major number that changes when one of
 * them changes incompatibly. A plugin written for a version requires
 * `HostApi(version)`, and the host provides the version it implements, this
 * one, so a plugin written for another is left out with a message naming the
 * version rather than failing at some later call.
 */
export const HOST_API = 4;
/** What a plugin written for host API `version` requires; the host provides `HostApi(HOST_API)`. */
export const HostApi = (version: number): Context.Key<`lemma/api@${number}`, number> => Context.Service<`lemma/api@${number}`, number>(`lemma/api@${version}`);

/**
 * Handle on the loader, provided by the host itself (it owns the loader; no
 * plugin can provide this) so transports and UIs can inspect and change the
 * running composition without reaching into the kernel. Its methods wait
 * until the composition is up, so a plugin may call one from work it forks
 * while activating (`owner.background`); called directly in its setup, one
 * waits on that plugin's own activation until the activate deadline. A change
 * through it publishes `PluginsChanged`.
 *
 * A change (`restart`, `reload`, `configure`) drains all work in flight under
 * `core.run` before swapping, whichever plugins it touches, so call it from a
 * plugin's own code (a transport's handler, a command): from inside `core.run`
 * it would wait on itself until the dispose deadline. A plugin's disposal
 * also waits for the work run with its items, such as the channel calls it
 * serves and the commands it registered: a change that would restart the
 * plugin whose work asks for it is deferred until that work has ended (see
 * `ChangeReport`). Once asked, a change runs to its end and publishes
 * `PluginsChanged` even if its caller stops waiting, as a stream does when the
 * change restarts its plugin.
 */
export class HostControl extends Context.Service<
  HostControl,
  {
    /**
     * What the host provides itself, by capability key: `Paths`, `HostControl`, `Interaction`, `Trace`, and
     * `HostApi(HOST_API)`. Any plugin may require them; none provides them, and none has a row. Fixed for the host's life.
     */
    readonly runtime: readonly string[];
    /** The host's process: when it started, and what started it, as it said (`LEMMA_STARTED_BY`: `cli`, `desktop`, `service`). */
    readonly process: { readonly pid: number; readonly startedAt: number; readonly startedBy?: string };
    /** Every known plugin, enabled or not. */
    readonly plugins: Effect.Effect<readonly PluginInfo[]>;
    readonly composition: Effect.Effect<CompositionInfo>;
    /**
     * A failed plugin and what it halted; with `force`, a running one too, and what needs it, unless the app depends
     * on it (a `ReloadError` says so). Deferred as `ChangeReport` says.
     */
    readonly restart: (pluginId: string, options?: RestartOptions) => Effect.Effect<RestartReport, ReloadError | CoreClosed>;
    /** Re-read the config files and apply the resulting composition. Deferred as `ChangeReport` says. */
    readonly reload: Effect.Effect<ChangeReport, ReloadError>;
    /**
     * Write plugin rows into a config file (the user's by default) and apply the
     * result. A change the host rejects is undone in the file, so a bad row never
     * outlives the call; the diagnostics say why. A row naming a web half (one
     * the host knows by its file's name, `WebFile.plugin`) is written for the
     * web app, which plans its halves from the same rows (`WebChanged`); one
     * naming no plugin either app has is refused, naming the plugin meant when
     * it is a typo off.
     */
    readonly configure: (
      plugins: Readonly<Record<string, PluginChange>>,
      options?: { readonly scope?: ConfigScope },
    ) => Effect.Effect<ChangeReport, ReloadError>;
    /** What the web app plans its halves from: the rows, and the web halves and stylesheets in the plugins directories. */
    readonly web: Effect.Effect<WebComposition>;
  }
>()("lemma/HostControl") {}

/**
 * A file in `<home>/plugins` or a trusted project's `.lemma/plugins` that the
 * web app loads: a script is a web half (`notes.web.js`, or a plugin
 * package's `lemma.web`), an ES module whose default export makes web
 * plugins; a style is a stylesheet applied after the app's own (`theme.css`,
 * or a package's `lemma.styles`).
 */
export const WebFile = Schema.Struct({
  /** Its path in the plugins directory, with `/` on every platform: `notes.web.js`, `ticker/web.js`. */
  name: Schema.String,
  /**
   * The plugin it belongs to, by its name: a web half's file is named for its plugin (`notes.web.js` is `notes`), and
   * a package's folder for its own (`ticker/`). So the host knows a web half's id without running it, and the web app
   * loads one only if it defines that plugin. Absent for a stylesheet of no package.
   */
  plugin: Schema.optional(Schema.String),
  source: Schema.Literals(["user", "project"]),
  kind: Schema.Literals(["script", "style"]),
  /** Where it is on the host. */
  path: Schema.String,
  /**
   * Served by the transport under `/api/web/<source>@<version>/<name>` (it needs the token, in the path as
   * `/api/web/t/<token>/…` or as for any `/api` call); its version changes when the file does, or for a package, any
   * file of it its web half may import (`WEB_IMPORTABLE`), so such a module is served beside it under the same version.
   */
  url: Schema.String,
});
export type WebFile = typeof WebFile.Type;

/**
 * What of a package's own files, beside its listed ones, its web half may import by a relative path: modules and
 * stylesheets, by extension, outside its dependencies and not hidden. The transport serves them, and the package's
 * version (`WebFile.url`) follows them.
 */
export const WEB_IMPORTABLE: ReadonlySet<string> = new Set([".js", ".mjs", ".ts", ".mts", ".css"]);

/**
 * What the web app needs to plan its halves: the rows of both config files
 * (every plugin's, host halves' too: a plugin's one row decides both its
 * halves), and the files to load.
 */
export const WebComposition = Schema.Struct({
  plugins: Schema.Record(Schema.String, PluginRow),
  /** Per plugin id, the file whose row sets `enabled` (the project's wins). */
  enabledIn: Schema.Record(Schema.String, ConfigScope),
  /** Per plugin id, the file whose row sets `config`. */
  configIn: Schema.Record(Schema.String, ConfigScope),
  files: Schema.Array(WebFile),
});
export type WebComposition = typeof WebComposition.Type;

/** Emitted when the rows or the web halves' files change, so web apps apply them. */
export const WebChanged = Event.make<WebComposition>("lemma/web.changed");

/** Emitted after any composition change or plugin fault so clients can refresh plugin views. */
export const PluginsChanged = Event.make<{ readonly plugins: readonly PluginInfo[] }>("lemma/plugins.changed");
