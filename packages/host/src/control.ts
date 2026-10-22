import { Deferred, Effect, Result, Schema, SchemaIssue, Semaphore } from "effect";
import type { Scope } from "effect";
import { describeReload, Notice, PluginsChanged, WebChanged } from "@lemma/contracts";
import type { ChangeReport, CompositionChange, ConfigScope, FaultRecord, PluginChange, WebComposition } from "@lemma/contracts";
import { Diagnostic, Events, ReloadError } from "@lemma/core";
import type { Composition, CoreClosed, CoreSnapshot, Event, Loader, PluginSource, ReloadReport } from "@lemma/core";
import { catalog, closestId, LEFT_OUT, withReplacements } from "@lemma/composition";
import type { CompositionHistory, KnownPlugin, Resolved } from "@lemma/composition";
import { compositionInfo } from "./composition.ts";
import { projectPluginsDir } from "./config.ts";
import type { ConfigUpdate } from "./config.ts";
import { deferral as deferralOf } from "./deferral.ts";
import type { PathsService } from "./paths.ts";
import type { HostControlHandle } from "./runtime.ts";
import type { CodeOwner } from "./stall-owners.ts";
import { userPluginsDir } from "./web.ts";

/*
 * How the host changes its composition: reloads, configures, and restarts,
 * one at a time, each refused, applied, or deferred. main.ts gives it the
 * files and the loader; tests give it their own (`tests/runtime.test.ts`).
 */

/** What one read of the config files and plugin directories produced, once the host accepts it. */
export interface Loaded {
  readonly known: readonly KnownPlugin[];
  /** Every known plugin with its row, as the files and app defaults describe it. */
  readonly composition: Composition;
  /** What the loader runs: `composition` minus what is off, left out, or needs either. */
  readonly resolved: Resolved;
  /** What must start (see `Plan.required`). */
  readonly required: readonly string[];
  /** Enabled plugins left out because they cannot run, with why. */
  readonly problems: ReadonlyMap<string, string>;
  readonly enabledIn: Readonly<Record<string, ConfigScope>>;
  readonly configIn: Readonly<Record<string, ConfigScope>>;
  readonly trusted: boolean;
  /** The web app's rows and files, which it plans itself. */
  readonly web: WebComposition;
  /** The web halves' ids, known without running them: the bundled ones, and each web file's plugin (it is named for it). */
  readonly webIds: readonly string[];
  /** Where each known plugin's code is, so a stall names whose code blocked the loop (`watchStalls`). */
  readonly code: readonly CodeOwner[];
}

/** A read before the host accepts it: with every diagnostic the files, the plugin files, and the planner gave. */
export interface Read extends Loaded {
  readonly diagnostics: readonly Diagnostic[];
}

export interface ChangesOptions {
  readonly paths: PathsService;
  /** Reads the config files and plugin directories (`--safe`: the bundled plugins as shipped, reading neither). */
  readonly read: Effect.Effect<Read, ReloadError>;
  /** A config file's text, undefined for one missing or unreadable. */
  readonly readConfig: (path: string) => Effect.Effect<string | undefined>;
  /** Writes rows into a config file (`updateConfig`). */
  readonly updateConfig: (
    path: string,
    rows: Readonly<Record<string, PluginChange>>,
    scope: ConfigScope,
    formerly: Readonly<Record<string, readonly string[]>>,
  ) => Effect.Effect<ConfigUpdate, Diagnostic>;
  /** The bundled web halves' former ids, by plugin: their `formerly`, which the host cannot read without running them. */
  readonly webFormerly: Readonly<Record<string, readonly string[]>>;
  /** The web files as they are now (`listWebFiles`). */
  readonly webFiles: (trusted: boolean) => Effect.Effect<WebComposition["files"]>;
  /** Plugins no change may turn off, with the reason clients show; they serve the requests that ask for changes. */
  readonly pinned: Readonly<Record<string, string>>;
  /** `--safe`: no config file is read or written. */
  readonly safe: boolean;
  readonly process: HostControlHandle["process"];
  /** Where each change's outcome is kept (`Trace.changes`). */
  readonly changes: CompositionHistory;
  /** Recent faults by plugin, for the catalog (`faultHistory`). */
  readonly faults: { readonly get: () => ReadonlyMap<string, readonly FaultRecord[]> };
  readonly log: (message: string) => Effect.Effect<void>;
  readonly printDiagnostics: (diagnostics: readonly Diagnostic[]) => Effect.Effect<void>;
  /** Told when `code` may have changed: before a load's plugins start, and once it is accepted or refused. */
  readonly onCode?: () => void;
  /** When a change may apply (`deferral`); tests replace it. */
  readonly deferral?: typeof deferralOf;
}

export interface HostChanges {
  /** Resolves ids against the load being applied, or else the one applied last. */
  readonly source: PluginSource;
  /** `HostControl`, as the host runtime serves it; its methods wait until `bind`. */
  readonly handle: HostControlHandle;
  /** The load the loader accepted last. */
  readonly applied: () => Loaded;
  /** Where plugins' code is: of the load being applied or asked about, or else the one applied last. */
  readonly code: () => readonly CodeOwner[];
  /** Gives the handle its loader, once it exists, and remembers the config files as they are now. */
  readonly bind: (loader: Loader) => Effect.Effect<void>;
  /** A config file changed: reloads when either file differs from what the host last read or wrote. */
  readonly configChanged: Effect.Effect<void>;
  /** A plugin file changed: reloads, and tells web apps of the web files even when the reload is refused. */
  readonly pluginsChanged: Effect.Effect<void>;
}

const rejected = (diagnostic: Diagnostic) => new ReloadError({ diagnostics: [diagnostic] });

/** A change's report as a line for the log. */
export const describe = (report: ReloadReport): string => {
  const parts = [
    describeReload(report) ?? "",
    report.interrupted ? `interrupted ${report.interrupted} in-flight task(s)` : "",
    report.faults.length ? `${report.faults.length} dispose fault(s)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing changed";
};

/** Decodes the configs of `ids` as the loader will, so a deferred change is refused before it is applied. */
const checkConfigs = (next: Loaded, ids: Iterable<string>): Effect.Effect<void, ReloadError> => {
  const diagnostics: Diagnostic[] = [];
  for (const id of ids) {
    const plugin = next.known.find((entry) => entry.plugin.id === id)?.plugin;
    const entry = next.resolved.composition.plugins[id];
    if (plugin?.config === undefined || entry === undefined) continue;
    const decoded = Schema.decodeUnknownResult(plugin.config)(entry.config ?? {});
    if (Result.isSuccess(decoded)) continue;
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues[0];
    const at = issue?.path?.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number") ?? [];
    diagnostics.push(
      new Diagnostic({
        severity: "error",
        pluginId: id,
        path: ["config", ...at],
        message: `Invalid config for "${id}"${at.length ? ` at ${at.join(".")}` : ""}: ${issue?.message ?? "does not match its schema"}`,
      }),
    );
  }
  return diagnostics.length ? Effect.fail(new ReloadError({ diagnostics })) : Effect.void;
};

/**
 * The host's changes to its composition, with the first load read and
 * accepted. Every change takes one lock, reading and applying together: the
 * watchers, `Host.Reload`, `Host.Configure`, and `Host.RestartPlugin` can
 * race, and a reload that read the files earlier must not apply after one
 * that read them later. A load is the applied one only once the loader has
 * accepted it; while it is applied, the source resolves against it.
 */
export const makeHostChanges = (options: ChangesOptions): Effect.Effect<HostChanges, ReloadError, Scope.Scope> =>
  Effect.gen(function* () {
    const { paths, pinned, safe, changes, log, printDiagnostics } = options;
    const deferral = options.deferral ?? deferralOf;
    const programScope = yield* Effect.scope;
    const ready = yield* Deferred.make<Loader>();
    const reloading = yield* Semaphore.make(1);
    const withLoader = <A, E>(f: (loader: Loader) => Effect.Effect<A, E>) => Effect.flatMap(Deferred.await(ready), f);
    const publish = <P>(loader: Loader, event: Event<P>, payload: P) => loader.core.run(Effect.flatMap(Events, (events) => events.publish(event, payload)));
    const refresh = () => options.onCode?.();

    /**
     * Accepts a read (see `planComposition`): what cannot run is left out with
     * a warning, unless it is required or a change brought it in. Warnings
     * print here; errors fail.
     */
    const accept = (read: Read, previous: Loaded | undefined): Effect.Effect<Loaded, ReloadError> =>
      Effect.gen(function* () {
        // A change that would leave out a plugin not left out already is refused (the file is put back, the running
        // composition kept), whichever plugin it touched; one already left out stays so, and blocks nothing.
        const refused = previous === undefined ? [] : [...read.problems].filter(([id]) => !previous.problems.has(id));
        const diagnostics = [
          ...read.diagnostics.filter((diagnostic) => diagnostic.code !== LEFT_OUT || !refused.some(([id]) => diagnostic.pluginId === id)),
          ...refused.map(
            ([id, problem]) =>
              new Diagnostic({ severity: "error", pluginId: id, message: `"${id}" cannot run: ${problem}`, suggestion: "Fix it, or turn it off" }),
          ),
        ];
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length) return yield* new ReloadError({ diagnostics: errors });
        // Only for a composition that will run: a rejected one's warnings describe nothing that happens.
        yield* printDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
        return read;
      });

    let applied: Loaded = yield* accept(yield* options.read, undefined);
    /** The load being applied, or asked about: what the source resolves against until the loader accepts or refuses it. */
    let candidate: Loaded | undefined;
    /**
     * What each config file held when the host last read or wrote it. The
     * watcher debounces both files into one event naming only the last, so an
     * event rereads both and reloads when either differs: the host's own write
     * to one file must not hide a hand edit to the other.
     */
    const seenConfig = new Map<string, string | undefined>();

    const source: PluginSource = {
      resolve: (id) => {
        const known = (candidate ?? applied).known;
        const plugin = known.find((entry) => entry.plugin.id === id)?.plugin;
        return plugin
          ? Effect.succeed(plugin)
          : Effect.fail(
              new Diagnostic({
                severity: "error",
                pluginId: id,
                message: `No plugin "${id}"`,
                suggestion: `Known plugins: ${known.map((entry) => entry.plugin.id).join(", ")}. Local plugins go in ${userPluginsDir(paths)} or, in a trusted project, ${projectPluginsDir(paths)}.`,
              }),
            );
      },
    };
    /** `effect` with the source resolving against `next`. Run under `reloading`, as every change is. */
    const resolvingFrom = <A, E>(next: Loaded, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        candidate = next;
        return effect;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            candidate = undefined;
          }),
        ),
      );

    const load = Effect.suspend(() => Effect.flatMap(options.read, (read) => accept(read, applied)));
    /** Both config files' text. */
    const readConfigFiles = Effect.forEach([paths.userConfig, paths.projectConfig], (path) =>
      Effect.map(options.readConfig(path), (text) => [path, text] as const),
    );

    /** Every known plugin as clients see it, from the last applied load and a core snapshot. */
    const catalogOf = (snapshot: CoreSnapshot) =>
      catalog({
        ...applied,
        snapshots: snapshot.plugins,
        hooks: snapshot.hooks,
        events: snapshot.events,
        registries: snapshot.registries,
        faults: options.faults.get(),
        problems: applied.problems,
        pinned,
      });
    /** Web apps plan their halves from the rows and files themselves; tell them when either changed. */
    const publishWeb = (loader: Loader, previous: WebComposition, next: WebComposition) =>
      JSON.stringify(previous) === JSON.stringify(next) ? Effect.void : publish(loader, WebChanged, next);
    /** What applying `next` starts, restarts, or stops: the loader's answer. */
    const affected = (loader: Loader, next: Loaded) => resolvingFrom(next, loader.affected(next.resolved.composition));
    /** Applies `next`, which becomes the applied load once the loader accepts it. */
    const apply = (loader: Loader, next: Loaded) =>
      Effect.gen(function* () {
        const previous = applied;
        const report = yield* resolvingFrom(
          next,
          // Before the plugins it brings start, so a stall in one's activation names it.
          Effect.sync(refresh).pipe(
            Effect.andThen(loader.apply(next.resolved.composition)),
            Effect.tap(() =>
              Effect.sync(() => {
                applied = next;
              }),
            ),
          ),
        ).pipe(Effect.ensuring(Effect.sync(refresh)));
        yield* publishWeb(loader, previous.web, next.web).pipe(Effect.ignore);
        return report;
      });

    /**
     * Keeps `change`'s outcome for the devtools' timeline (`Trace.changes`): what it did, or why it was refused. One that
     * applies later is kept when it does.
     */
    const recorded =
      (cause: CompositionChange["cause"], subjects?: readonly string[]) =>
      <A extends Partial<ReloadReport> & { readonly deferred?: boolean }, E extends ReloadError | CoreClosed>(
        change: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        change.pipe(
          Effect.tap((report) =>
            Effect.sync(() => {
              if (report.deferred !== true) changes.applied(cause, report, subjects);
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() =>
              changes.refused(
                cause,
                error._tag === "ReloadError" ? error.diagnostics.map((diagnostic) => diagnostic.message).join("; ") : "the host is closing",
                subjects,
              ),
            ),
          ),
        );
    /** Re-reads the config files and applies them, one change at a time. */
    const reloadNow = (loader: Loader, cause: CompositionChange["cause"], subjects?: readonly string[]) =>
      recorded(cause, subjects)(reloading.withPermits(1)(Effect.flatMap(load, (loaded) => apply(loader, loaded))));

    /**
     * Puts a config file back as it was before `update`, remembering it so;
     * what it could not put back, it returns as diagnostics, and the file,
     * still holding the change, is remembered as such.
     */
    const putBack = (path: string, update: ConfigUpdate): Effect.Effect<readonly Diagnostic[]> =>
      update.restore.pipe(
        Effect.andThen(
          Effect.sync(() => {
            seenConfig.set(path, update.previous);
          }),
        ),
        Effect.as([]),
        Effect.catch((diagnostic) => Effect.as(printDiagnostics([diagnostic]), [diagnostic])),
      );

    /**
     * A change that restarts a plugin whose work is making it would wait on
     * that work or cut it off (`deferral`), so it is checked at once and
     * `change` runs once `after` (see `ChangeReport`). Clients then hear the
     * plugin list (`change` logs what it did) or, if it failed, `failure` and
     * why, once `undo` has run, with what it says became of the change.
     */
    const applyLater = (
      loader: Loader,
      after: Effect.Effect<void>,
      change: Effect.Effect<void, ReloadError | CoreClosed>,
      failure: string,
      undo: Effect.Effect<string | undefined> = Effect.succeed(undefined),
    ) =>
      Effect.forkIn(
        Effect.andThen(after, change).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.flatMap(handle.plugins, (plugins) => publish(loader, PluginsChanged, { plugins })),
            onFailure: (error) =>
              Effect.gen(function* () {
                const diagnostics = error._tag === "ReloadError" ? error.diagnostics : [];
                const why = error._tag === "ReloadError" ? diagnostics.map((diagnostic) => diagnostic.message).join("; ") : "the host is closing";
                const undone = yield* undo;
                yield* printDiagnostics(diagnostics);
                const message = `${failure}: ${why}${undone === undefined ? "" : `; ${undone}`}`;
                yield* publish(loader, Notice, { level: "error", source: "host", message });
              }),
          }),
          Effect.ignore,
        ),
        programScope,
      );
    /** The report of a change that applies later: it has changed nothing yet. */
    const deferred: ChangeReport = { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [], deferred: true };

    /**
     * Writes rows into a config file and applies the result, now or once the
     * work asking for it is over (`applyLater`), checked as the loader will
     * check it; a change the host rejects is undone in the file.
     */
    const write = (loader: Loader, rows: Readonly<Record<string, PluginChange>>, scope: ConfigScope) =>
      Effect.gen(function* () {
        const path = scope === "user" ? paths.userConfig : paths.projectConfig;
        // A renamed plugin's row under its former id (`formerly`) moves to its id as it is written, a web half's too.
        const formerly = {
          ...options.webFormerly,
          ...Object.fromEntries(applied.known.flatMap(({ plugin }) => (plugin.formerly === undefined ? [] : [[plugin.id, plugin.formerly]]))),
        };
        const update = yield* options.updateConfig(path, rows, scope, formerly).pipe(Effect.mapError(rejected));
        seenConfig.set(path, update.text);
        const undo = putBack(path, update);
        // The written rows are read back like any other change.
        const decided = Effect.gen(function* () {
          const next = yield* load;
          const touched = yield* affected(loader, next);
          // A change that restarts the plugin asking for it (the transport serving the call, or one whose channel call
          // or command asks) applies once that work is over.
          const after = yield* deferral(touched);
          if (after === undefined) return yield* apply(loader, next);
          yield* checkConfigs(next, touched);
          const change = Effect.flatMap(reloadNow(loader, "configure", Object.keys(rows)), (report) => log(`applied a config change: ${describe(report)}`));
          const undone = Effect.map(undo, (left) => (left.length ? left.map((diagnostic) => diagnostic.message).join("; ") : `${path} was put back`));
          yield* applyLater(loader, after, change, "The config change could not be applied", undone);
          return deferred;
        });
        return yield* decided.pipe(
          Effect.catch((error) => Effect.flatMap(undo, (left) => Effect.fail(new ReloadError({ diagnostics: [...error.diagnostics, ...left] })))),
        );
      });
    const safeMode = () =>
      rejected(
        new Diagnostic({
          severity: "error",
          message: "The host is running with --safe: it reads and writes no config file",
          suggestion: `Edit ${paths.userConfig} by hand, or restart the host without --safe`,
        }),
      );
    const untrustedProject = () =>
      rejected(
        new Diagnostic({
          severity: "error",
          message: `${paths.projectConfig} is not read because ${paths.cwd} is not a trusted project`,
          suggestion: `Add "${paths.cwd}" to "trustedProjects" in ${paths.userConfig}, or change the user config instead`,
        }),
      );

    const reload = withLoader((loader) =>
      reloading.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* load;
          // One that restarts the plugin asking for it (`commands.host` running `host.reload`, or `commands.registry` serving that
          // run), or the transport serving the request, is checked now and applied once that work is over.
          const touched = yield* affected(loader, next);
          const after = yield* deferral(touched);
          if (after === undefined) return yield* apply(loader, next);
          yield* checkConfigs(next, touched);
          const change = Effect.flatMap(reloadNow(loader, "reload"), (report) => log(`reloaded: ${describe(report)}`));
          yield* applyLater(loader, after, change, "The reload could not be applied; the running composition is unchanged");
          return deferred;
        }).pipe(recorded("reload")),
      ),
    );

    const handle: HostControlHandle = {
      process: options.process,
      plugins: withLoader((loader) => Effect.map(loader.core.inspect, catalogOf)),
      web: Effect.sync(() => applied.web),
      composition: withLoader((loader) =>
        Effect.gen(function* () {
          const composition = yield* loader.composition;
          const { plugins } = yield* loader.core.inspect;
          return compositionInfo(composition, plugins);
        }),
      ),
      restart: (pluginId, restartOptions) =>
        // Not under `reloading`: the kernel orders a restart with any change it is applying, and a restart whose plugin's
        // work waits on `reloading` (a channel call that reloads or configures) would otherwise wait on its own disposal.
        withLoader((loader) =>
          Effect.gen(function* () {
            const snapshot = yield* loader.core.inspect;
            // Force-restarting a locked plugin (the pinned transport, or a plugin it needs) restarts the transport and drops the
            // client that asked; refuse rather than surprise.
            if (restartOptions?.force) {
              const entry = catalogOf(snapshot).find((candidate) => candidate.id === pluginId);
              if (entry?.locked !== undefined && entry.state === "active") {
                return yield* rejected(
                  new Diagnostic({
                    severity: "error",
                    pluginId,
                    message: `"${pluginId}" cannot be restarted while running: ${entry.locked}`,
                    suggestion: "Change its config and reload, or restart the host",
                  }),
                );
              }
            }
            // Only a loaded plugin that is not running, or is forced, restarts, with what needs it: one that restarts the
            // plugin asking for it (`commands.host` running `host.restart-plugin`, or `commands.registry` serving that run)
            // applies once that work is over. One the loader cannot plan restarts nothing, so it fails at once.
            const state = snapshot.plugins.find((plugin) => plugin.id === pluginId)?.state;
            const touched =
              state === undefined || (state === "active" && !restartOptions?.force)
                ? undefined
                : yield* loader.affected(yield* loader.composition, { restart: [pluginId] }).pipe(Effect.orElseSucceed(() => undefined));
            const after = touched === undefined ? undefined : yield* deferral(touched);
            const restart = recorded("restart", [pluginId])(loader.core.restart(pluginId, restartOptions));
            if (after === undefined) return yield* Effect.as(restart, {});
            const change = Effect.andThen(restart, log(`restarted ${pluginId}`));
            yield* applyLater(loader, after, change, `"${pluginId}" could not be restarted`);
            return { deferred: true };
          }),
        ),
      reload,
      configure: (requested, configureOptions) =>
        withLoader((loader) =>
          reloading.withPermits(1)(
            Effect.gen(function* () {
              if (safe) return yield* safeMode();
              const scope = configureOptions?.scope ?? "user";
              if (scope === "project" && !applied.trusted) return yield* untrustedProject();
              // Checked here so the answer is immediate and the file is never touched: the load would refuse these too.
              const entries = catalogOf(yield* loader.core.inspect);
              const known = [...applied.known.map(({ plugin }) => plugin.id), ...applied.webIds];
              for (const [id, row] of Object.entries(requested)) {
                // An id the host does not know is a web half's, written for the web app; one neither app has is a mistake.
                if (!known.includes(id)) {
                  const renamed =
                    applied.known.find(({ plugin }) => plugin.formerly?.includes(id) === true)?.plugin.id ??
                    Object.entries(options.webFormerly).find(([, former]) => former.includes(id))?.[0];
                  const meant = renamed ?? closestId(id, known);
                  return yield* rejected(
                    new Diagnostic({
                      severity: "error",
                      pluginId: id,
                      message: renamed === undefined ? `No plugin "${id}"` : `No plugin "${id}": it is "${renamed}" since a rename`,
                      suggestion: meant === undefined ? "`lemma plugins` lists them" : `Did you mean "${meant}"?`,
                    }),
                  );
                }
                const entry = entries.find((candidate) => candidate.id === id);
                if (row.enabled === false && entry?.locked !== undefined) {
                  return yield* rejected(new Diagnostic({ severity: "error", pluginId: id, message: `"${id}" cannot be turned off: ${entry.locked}` }));
                }
              }
              // Turning on a provider turns off the one it replaces; a pinned plugin cannot be replaced that way.
              const rows = withReplacements(applied.known, applied.composition, requested);
              for (const id of Object.keys(rows)) {
                if (requested[id] === undefined && pinned[id] !== undefined) {
                  const replacer = Object.keys(requested).find((candidate) => requested[candidate]?.enabled === true) ?? "?";
                  return yield* rejected(
                    new Diagnostic({
                      severity: "error",
                      pluginId: replacer,
                      message: `"${replacer}" provides what "${id}" provides, and "${id}" cannot be turned off: ${pinned[id]}`,
                    }),
                  );
                }
              }
              return yield* write(loader, rows, scope);
            }).pipe(recorded("configure", Object.keys(requested))),
          ),
        ),
    };

    /**
     * The web files as they are now, told to web apps when they changed, though the host's own load was refused: a web
     * half or a stylesheet is no part of that, and waits on no host half's file being fixed.
     */
    const refreshWebFiles = (loader: Loader) =>
      reloading.withPermits(1)(
        Effect.gen(function* () {
          const files = yield* options.webFiles(applied.trusted);
          const previous = applied.web;
          applied = { ...applied, web: { ...previous, files } };
          yield* publishWeb(loader, previous, applied.web).pipe(Effect.ignore);
        }),
      );
    /** A change on disk, the host's own with no request: it applies at once, and clients hear of it as of one made through `HostControl`. */
    const reloadFromDisk = (loader: Loader, refused: Effect.Effect<void> = Effect.void) =>
      reloadNow(loader, "reload").pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            printDiagnostics(error.diagnostics).pipe(Effect.andThen(log("reload rejected; the running composition is unchanged")), Effect.andThen(refused)),
          onSuccess: (report) =>
            log(`reloaded: ${describe(report)}`).pipe(
              Effect.andThen(Effect.flatMap(handle.plugins, (plugins) => publish(loader, PluginsChanged, { plugins }))),
              Effect.ignore,
            ),
        }),
      );

    return {
      source,
      handle,
      applied: () => applied,
      code: () => (candidate ?? applied).code,
      bind: (loader) =>
        Effect.gen(function* () {
          // In safe mode no config file is read, even to remember it.
          if (!safe) for (const [path, text] of yield* readConfigFiles) seenConfig.set(path, text);
          yield* Deferred.succeed(ready, loader);
        }),
      configChanged: withLoader((loader) =>
        Effect.gen(function* () {
          // Only what differs from the last read or write is new; a change this process wrote (a configure, or its undo) is already applied.
          const current = yield* readConfigFiles;
          const changed = current.filter(([path, text]) => seenConfig.get(path) !== text).map(([path]) => path);
          if (changed.length === 0) return;
          for (const [path, text] of current) seenConfig.set(path, text);
          yield* log(`${changed.length === 1 ? changed[0] : changed.join(" and ")} changed; reloading`);
          yield* reloadFromDisk(loader);
        }),
      ),
      // A plugin's file added, edited, or removed: its host half reloads (an unchanged file keeps its definition, so only
      // what changed restarts), and web apps hear of its web half and stylesheets.
      pluginsChanged: withLoader((loader) => log("a plugin file changed; reloading").pipe(Effect.andThen(reloadFromDisk(loader, refreshWebFiles(loader))))),
    };
  });
