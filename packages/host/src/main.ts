#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Cause, Deferred, Duration, Effect, Exit, Option, Result, Schema, SchemaIssue, Semaphore, Stream } from "effect";
import { appUrl, describeReload, faultMessage, Notice, PluginsChanged, UiChanged } from "@lemma/contracts/runtime";
import { Diagnostic, Events, makeLoader, ReloadError } from "@lemma/core";
import type { Composition, CoreClosed, CoreSnapshot, Event, Loader, PluginSource, ReloadReport, ReportedFault } from "@lemma/core";
import { catalog, faultHistory, planComposition, restartedBy, withReplacements } from "@lemma/composition";
import type { KnownPlugin, Resolved } from "@lemma/composition";
import type { ChangeReport, ConfigScope, PluginChange, UiComposition } from "@lemma/contracts/runtime";
import { readDiscovery } from "@lemma/contracts/discovery";
import { appDefaults, bundled } from "./bundled.ts";
import { compositionInfo } from "./composition.ts";
import { changedBetween, deferral } from "./deferral.ts";
import type { Running } from "./deferral.ts";
import { loadComposition, projectPluginsDir, readConfigText, updateConfig } from "./config.ts";
import type { ConfigSection } from "./config.ts";
import { loadLocalPlugins } from "./local.ts";
import { resolvePaths } from "./paths.ts";
import { hostRuntime, reportFaults, runtimeCapabilities } from "./runtime.ts";
import type { HostControlHandle } from "./runtime.ts";
import { listUiFiles } from "./ui.ts";
import { watchConfig, watchUi } from "./watch.ts";

const args = new Set(process.argv.slice(2));
/**
 * `--safe` (or `LEMMA_SAFE=1`): the bundled plugins as shipped, reading no
 * config file and no plugin file, and writing neither: the way back from a
 * customization that keeps the host from starting.
 */
const safe = args.has("--safe") || process.env.LEMMA_SAFE === "1";
// `pnpm start` runs from packages/host; INIT_CWD is where the user invoked it.
const paths = resolvePaths({ env: process.env, cwd: process.env.INIT_CWD ?? process.cwd() });
// Consumed here: tools inherit this environment, and a CLI the agent runs must use its own directory, not ours.
delete process.env.INIT_CWD;
const userPluginsDir = join(paths.home, "plugins");

/** Plugins no config change may turn off, with the reason clients show. Everything they need is locked with them. */
const pinned: Readonly<Record<string, string>> = {
  transport: "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
};
/** What the host provides itself (see `hostRuntime`): planned as present, and refused from a plugin. */
const provided = runtimeCapabilities;

const log = (message: string) =>
  Effect.sync(() => {
    console.log(`lemma: ${message}`);
  });
const printDiagnostics = (diagnostics: readonly Diagnostic[]) =>
  Effect.sync(() => {
    for (const diagnostic of diagnostics) {
      const where = diagnostic.pluginId === undefined ? "" : ` [${diagnostic.pluginId}]`;
      console.error(`lemma: ${diagnostic.severity}${where}: ${diagnostic.message}${diagnostic.suggestion === undefined ? "" : `\n  ${diagnostic.suggestion}`}`);
    }
  });

/** What one read of the config files and plugin directories produced. */
interface Loaded {
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
  readonly ui: UiComposition;
}

/** The last load the loader accepted; the catalog and `configure` reason about this. */
let applied!: Loaded;
/**
 * What each config file held when the host last read or wrote it. The watcher
 * debounces both files into one event naming only the last, so an event
 * rereads both and reloads when either differs: the host's own write to one
 * file must not hide a hand edit to the other.
 */
const seenConfig = new Map<string, string | undefined>();
const source: PluginSource = {
  resolve: (id) => {
    const plugin = applied.known.find((entry) => entry.plugin.id === id)?.plugin;
    return plugin
      ? Effect.succeed(plugin)
      : Effect.fail(
          new Diagnostic({
            severity: "error",
            pluginId: id,
            message: `No plugin "${id}"`,
            suggestion: `Known plugins: ${applied.known.map((entry) => entry.plugin.id).join(", ")}. Local plugins go in ${userPluginsDir} or, in a trusted project, ${projectPluginsDir(paths)}.`,
          }),
        );
  },
};

const EMPTY_UI: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };

/**
 * Read config files and local plugins into the next composition (see
 * `planComposition`): what cannot run is left out with a warning unless it is
 * required, or a change brought it in. Warnings print here; errors fail.
 */
const load = (): Effect.Effect<Loaded, ReloadError> =>
  Effect.gen(function* () {
    const input = { bundled, pinned: Object.keys(pinned), defaults: appDefaults, provided, localRequired: true };
    if (safe) {
      const planned = planComposition({ ...input, local: [], rows: {} });
      const errors = planned.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length) return yield* new ReloadError({ diagnostics: errors });
      return { ...planned, enabledIn: {}, configIn: {}, trusted: false, ui: EMPTY_UI };
    }
    const loaded = yield* loadComposition(paths);
    // Project plugins run only in a project the user config trusts; see `loadComposition`.
    const local = yield* loadLocalPlugins(loaded.trusted ? [userPluginsDir, projectPluginsDir(paths)] : [userPluginsDir], {
      bundled: Object.fromEntries(input.bundled.map((plugin) => [plugin.id, plugin])),
    });
    const planned = planComposition({
      ...input,
      local: local.plugins.map(({ plugin, dir }) => ({ plugin, source: dir === userPluginsDir ? ("user" as const) : ("project" as const) })),
      rows: loaded.rows,
    });
    // A change that would leave out a plugin not left out already is refused (the file is put back, the running
    // composition kept), whichever plugin it touched; one already left out stays so, and blocks nothing.
    const previous: Loaded | undefined = applied;
    const refused = previous === undefined ? [] : [...planned.problems].filter(([id]) => !previous.problems.has(id));
    const diagnostics = [
      ...local.diagnostics,
      ...loaded.diagnostics,
      ...planned.diagnostics.filter(
        (diagnostic) => !refused.some(([id]) => diagnostic.pluginId === id && diagnostic.message.startsWith(`"${id}" is left out`)),
      ),
      ...refused.map(
        ([id, problem]) => new Diagnostic({ severity: "error", pluginId: id, message: `"${id}" cannot run: ${problem}`, suggestion: "Fix it, or turn it off" }),
      ),
    ];
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length) return yield* new ReloadError({ diagnostics: errors });
    // Only for a composition that will run: a rejected one's warnings describe nothing that happens.
    yield* printDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
    const files = yield* listUiFiles(paths, loaded.trusted);
    return {
      known: planned.known,
      composition: planned.composition,
      resolved: planned.resolved,
      required: planned.required,
      problems: planned.problems,
      enabledIn: loaded.enabledIn,
      configIn: loaded.configIn,
      trusted: loaded.trusted,
      ui: { ...loaded.ui, files },
    };
  });

const describe = (report: ReloadReport): string => {
  const parts = [
    describeReload(report) ?? "",
    report.interrupted ? `interrupted ${report.interrupted} in-flight task(s)` : "",
    report.faults.length ? `${report.faults.length} dispose fault(s)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing changed";
};

const untilSignal = Effect.callback<void>((resume) => {
  const done = () => resume(Effect.void);
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  return Effect.sync(() => {
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
  });
});

const openBrowser = (url: string) =>
  Effect.sync(() => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(command, [url], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  });

const rejected = (diagnostic: Diagnostic) => new ReloadError({ diagnostics: [diagnostic] });

/** Both config files' text, undefined for one that is missing or unreadable. */
const readConfigFiles = Effect.forEach([paths.userConfig, paths.projectConfig], (path) =>
  Effect.map(readConfigText(path).pipe(Effect.orElseSucceed(() => undefined)), (text) => [path, text] as const),
);

/**
 * How long stopping may take in all. The core's default (its 10 second dispose deadline) would cut it short of a
 * plugin that asks for longer to close: the agent takes up to 30 seconds, letting running turns reach a point to
 * resume from.
 */
const SHUTDOWN_TIMEOUT = Duration.seconds(40);

/** What `loaded` runs, as `changedBetween` compares it. */
const running = (loaded: Loaded): Running =>
  new Map(
    Object.entries(loaded.resolved.composition.plugins).flatMap(([id, entry]) => {
      const plugin = loaded.known.find((known) => known.plugin.id === id)?.plugin;
      return entry.enabled === false || plugin === undefined ? [] : [[id, { plugin, config: entry.config }] as const];
    }),
  );

/** The plugins that applying `next` in place of `current` starts, stops, or restarts, with what needs them in either. */
const touchedBy = (current: Loaded, next: Loaded): ReadonlySet<string> => {
  const changed = changedBetween(running(current), running(next));
  return new Set([...restartedBy(current.known, changed, { provided }), ...restartedBy(next.known, changed, { provided })]);
};

/** Decodes the configs of `ids` as the loader will, so a deferred change is refused before it is applied. */
const checkConfigs = (next: Loaded, ids: readonly string[]): Effect.Effect<void, ReloadError> => {
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

const program = Effect.gen(function* () {
  const programScope = yield* Effect.scope;
  // The runtime's services are built inside makeLoader, before the loader exists: its handle binds to the loader once it does.
  const ready = yield* Deferred.make<Loader>();
  const reloading = yield* Semaphore.make(1);
  const withLoader = <A, E>(f: (loader: Loader) => Effect.Effect<A, E>) => Effect.flatMap(Deferred.await(ready), f);
  const publish = <P>(loader: Loader, event: Event<P>, payload: P) => loader.core.run(Effect.flatMap(Events, (events) => events.publish(event, payload)));
  const faults = faultHistory();
  /** Every known plugin as clients see it, from the last applied load and a core snapshot. */
  const catalogOf = (snapshot: CoreSnapshot) =>
    catalog({
      ...applied,
      snapshots: snapshot.plugins,
      hooks: snapshot.hooks,
      events: snapshot.events,
      registries: snapshot.registries,
      faults: faults.get(),
      problems: applied.problems,
      pinned,
    });
  /** Web apps apply `ui` rows and files themselves; tell them when either changed. */
  const publishUi = (loader: Loader, previous: UiComposition, next: UiComposition) =>
    JSON.stringify(previous) === JSON.stringify(next) ? Effect.void : publish(loader, UiChanged, next);
  // The source resolves ids against the load being applied, so the next set is visible before the loader accepts it.
  const apply = (loader: Loader, next: Loaded) =>
    Effect.gen(function* () {
      const previous = applied;
      applied = next;
      const report = yield* loader.apply(next.resolved.composition).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            applied = previous;
          }),
        ),
      );
      yield* publishUi(loader, previous.ui, next.ui).pipe(Effect.ignore);
      return report;
    });
  /** Writes rows into a config file and applies the result; a change the host rejects is undone in the file. */
  const write = (loader: Loader, rows: Readonly<Record<string, PluginChange>>, scope: ConfigScope, section: ConfigSection) =>
    Effect.gen(function* () {
      const path = scope === "user" ? paths.userConfig : paths.projectConfig;
      const update = yield* updateConfig(path, rows, scope, section).pipe(Effect.mapError(rejected));
      seenConfig.set(path, update.text);
      // The written rows are read back like any other change; if the host rejects them, the file is put back.
      return yield* Effect.flatMap(load(), (next) => apply(loader, next)).pipe(
        Effect.tapError(() => update.restore.pipe(Effect.tap(() => Effect.sync(() => seenConfig.set(path, update.previous))))),
      );
    });
  /** Re-reads the config files and applies them, one change at a time. */
  const reloadNow = (loader: Loader) => reloading.withPermits(1)(Effect.flatMap(load(), (loaded) => apply(loader, loaded)));
  /**
   * A change that restarts a plugin whose work is making it would wait on that
   * work or cut it off (`deferral`), so it is checked at once and `change`
   * runs once `after` (see `ChangeReport`). Clients then hear the plugin
   * list (`change` logs what it did) or, if it failed, `failure` and why, once
   * `undo` has run.
   */
  const applyLater = (
    loader: Loader,
    after: Effect.Effect<void>,
    change: Effect.Effect<void, ReloadError | CoreClosed>,
    failure: string,
    undo: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.forkIn(
      Effect.andThen(after, change).pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.flatMap(handle.plugins, (plugins) => publish(loader, PluginsChanged, { plugins })),
          onFailure: (error) => {
            const diagnostics = error._tag === "ReloadError" ? error.diagnostics : [];
            const why = error._tag === "ReloadError" ? diagnostics.map((diagnostic) => diagnostic.message).join("; ") : "the host is closing";
            return undo.pipe(
              Effect.andThen(printDiagnostics(diagnostics)),
              Effect.andThen(publish(loader, Notice, { level: "error", source: "host", message: `${failure}: ${why}` })),
            );
          },
        }),
        Effect.ignore,
      ),
      programScope,
    );
  /** The report of a change that applies later: it has changed nothing yet. */
  const deferred: ChangeReport = { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [], deferred: true };
  /** Writes rows now, checked as the loader will check them, and applies them once `after` (`applyLater`); if that fails, the file is put back. */
  const writeDeferred = (loader: Loader, rows: Readonly<Record<string, PluginChange>>, scope: ConfigScope, after: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const path = scope === "user" ? paths.userConfig : paths.projectConfig;
      const update = yield* updateConfig(path, rows, scope, "plugins").pipe(Effect.mapError(rejected));
      seenConfig.set(path, update.text);
      const restore = update.restore.pipe(Effect.tap(() => Effect.sync(() => seenConfig.set(path, update.previous))));
      const next = yield* load().pipe(Effect.tapError(() => restore));
      yield* checkConfigs(next, Object.keys(rows)).pipe(Effect.tapError(() => restore));
      const change = Effect.flatMap(reloadNow(loader), (report) => log(`applied a config change: ${describe(report)}`));
      yield* applyLater(loader, after, change, "The config change could not be applied and was undone", restore);
      return deferred;
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
  // One change at a time, reading and applying together: the watcher, `Host.Reload`, and `Host.Configure` can
  // race, and a reload that read the files earlier must not apply after one that read them later.
  const reload = withLoader((loader) =>
    reloading.withPermits(1)(
      Effect.gen(function* () {
        const next = yield* load();
        // One that restarts the plugin asking for it (`commands-host` running `host.reload`, or `commands` serving that
        // run), or the transport serving the request, is checked now and applied once that work is over.
        const touched = touchedBy(applied, next);
        const after = yield* deferral(touched, Object.keys(pinned));
        if (after === undefined) return yield* apply(loader, next);
        yield* checkConfigs(next, [...touched]);
        const change = Effect.flatMap(reloadNow(loader), (report) => log(`reloaded: ${describe(report)}`));
        yield* applyLater(loader, after, change, "The reload could not be applied; the running composition is unchanged");
        return deferred;
      }),
    ),
  );
  const handle: HostControlHandle = {
    plugins: withLoader((loader) => Effect.map(loader.core.inspect, catalogOf)),
    ui: Effect.sync(() => applied.ui),
    configureUi: (rows, options) =>
      withLoader((loader) =>
        reloading.withPermits(1)(
          Effect.gen(function* () {
            if (safe) return yield* safeMode();
            const scope = options?.scope ?? "user";
            if (scope === "project" && !applied.trusted) return yield* untrustedProject();
            yield* write(loader, rows, scope, "ui");
            return applied.ui;
          }),
        ),
      ),
    composition: withLoader((loader) =>
      Effect.gen(function* () {
        const composition = yield* loader.composition;
        const { plugins } = yield* loader.core.inspect;
        return compositionInfo(composition, plugins);
      }),
    ),
    restart: (pluginId, options) =>
      withLoader((loader) =>
        Effect.gen(function* () {
          const snapshot = yield* loader.core.inspect;
          // Force-restarting a locked plugin (the pinned transport, or a plugin it needs) restarts the transport and drops the
          // client that asked; refuse rather than surprise.
          if (options?.force) {
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
          // plugin asking for it (`commands-host` running `host.restart-plugin`, or `commands` serving that run) applies
          // once that work is over.
          const state = snapshot.plugins.find((plugin) => plugin.id === pluginId)?.state;
          const after =
            state === undefined || (state === "active" && !options?.force)
              ? undefined
              : yield* deferral(restartedBy(applied.known, [pluginId], { provided }), Object.keys(pinned));
          if (after === undefined) return yield* Effect.as(loader.core.restart(pluginId, options), {});
          const change = Effect.andThen(loader.core.restart(pluginId, options), log(`restarted ${pluginId}`));
          yield* applyLater(loader, after, change, `"${pluginId}" could not be restarted`);
          return { deferred: true };
        }),
      ),
    reload,
    configure: (requested, options) =>
      withLoader((loader) =>
        reloading.withPermits(1)(
          Effect.gen(function* () {
            if (safe) return yield* safeMode();
            const scope = options?.scope ?? "user";
            if (scope === "project" && !applied.trusted) return yield* untrustedProject();
            // Checked here so the answer is immediate and the file is never touched: the load would refuse these too.
            const entries = catalogOf(yield* loader.core.inspect);
            for (const [id, row] of Object.entries(requested)) {
              // Resolving an unknown id yields the source's diagnostic, which lists the known plugins.
              const entry = entries.find((candidate) => candidate.id === id) ?? (yield* Effect.mapError(source.resolve(id), rejected), undefined);
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
            // A change that restarts the plugin asking for it (the transport serving the call, or one whose channel call
            // or command asks) applies once that work is over.
            const after = yield* deferral(restartedBy(applied.known, Object.keys(rows), { provided }), Object.keys(pinned));
            if (after !== undefined) return yield* writeDeferred(loader, rows, scope, after);
            return yield* write(loader, rows, scope, "plugins");
          }),
        ),
      ),
  };

  if (safe) yield* log("safe mode: the bundled plugins as shipped; no config file or plugin file is read or written");
  applied = yield* load();
  // What cannot start is left failed, restartable, unless it is required: the essential plugins, your own, and rows marked so.
  const loader = yield* makeLoader({
    source,
    composition: applied.resolved.composition,
    provide: hostRuntime({ paths, control: handle }),
    shutdownTimeout: SHUTDOWN_TIMEOUT,
    partialStart: { required: applied.required },
  }).pipe(
    // A plugin of yours that fails to start keeps the host down only because it is required: say how to start without it.
    Effect.mapError(
      (error) =>
        new ReloadError({
          diagnostics: error.diagnostics.map((diagnostic) =>
            diagnostic.suggestion === undefined &&
            diagnostic.pluginId !== undefined &&
            applied.required.includes(diagnostic.pluginId) &&
            pinned[diagnostic.pluginId] === undefined
              ? new Diagnostic({ ...diagnostic, suggestion: `Fix it, or set "required": false in its row to start without it` })
              : diagnostic,
          ),
        }),
    ),
  );
  yield* Deferred.succeed(ready, loader);
  // Heard from here on; faults from before, the sweep below records (once each, by sequence).
  yield* Effect.forkScoped(reportFaults(loader, faults), { startImmediately: true });
  const { plugins } = yield* loader.core.inspect;
  for (const plugin of plugins) {
    // Raised before the reporter subscribed: the Plugins page's history gets them here.
    if (plugin.state === "failed" && plugin.fault !== undefined) faults.record(plugin.fault as ReportedFault);
  }
  yield* printDiagnostics(
    plugins.flatMap((plugin) =>
      plugin.state === "failed" && plugin.fault !== undefined
        ? [
            new Diagnostic({
              severity: "warning",
              pluginId: plugin.id,
              message: `"${plugin.id}" failed to start: ${faultMessage(plugin.fault)}`,
              suggestion: `Fix it, then restart it from the Plugins page or with \`lemma plugins restart ${plugin.id}\``,
            }),
          ]
        : plugin.haltedBy !== undefined
          ? [
              new Diagnostic({
                severity: "warning",
                pluginId: plugin.id,
                message: `"${plugin.id}" is not running: it needs "${plugin.haltedBy}", which failed to start`,
              }),
            ]
          : [],
    ),
  );
  yield* log(
    `running ${plugins
      .filter((plugin) => plugin.state === "active")
      .map((plugin) => plugin.id)
      .join(", ")}`,
  );
  yield* log(`home ${paths.home}, project ${paths.cwd}`);

  // In safe mode no config file is read, even to remember it.
  if (!safe) for (const [path, text] of yield* readConfigFiles) seenConfig.set(path, text);
  // In safe mode the files are not read, so their changes are nothing to apply.
  yield* Effect.forkScoped(
    Stream.runForEach(safe ? Stream.empty : watchConfig(paths), () =>
      Effect.gen(function* () {
        // Only what differs from the last read or write is new; a change this process wrote (a configure, or its undo) is already applied.
        const current = yield* readConfigFiles;
        const changed = current.filter(([path, text]) => seenConfig.get(path) !== text).map(([path]) => path);
        if (changed.length === 0) return;
        for (const [path, text] of current) seenConfig.set(path, text);
        yield* log(`${changed.length === 1 ? changed[0] : changed.join(" and ")} changed; reloading`).pipe(
          // The host's own change, no request: it applies at once, and clients hear of it as of one made through `HostControl`.
          Effect.andThen(reloadNow(loader)),
          Effect.matchEffect({
            onFailure: (error) => printDiagnostics(error.diagnostics).pipe(Effect.andThen(log("reload rejected; the running composition is unchanged"))),
            onSuccess: (report) =>
              log(`reloaded: ${describe(report)}`).pipe(
                Effect.andThen(Effect.flatMap(handle.plugins, (plugins) => publish(loader, PluginsChanged, { plugins }))),
                Effect.ignore,
              ),
          }),
        );
      }),
    ),
  );

  // A UI file added, edited, or removed changes only what web apps load.
  yield* Effect.forkScoped(
    Stream.runForEach(safe ? Stream.empty : watchUi(paths), () =>
      reloading.withPermits(1)(
        Effect.gen(function* () {
          const previous = applied;
          const files = yield* listUiFiles(paths, previous.trusted);
          applied = { ...previous, ui: { ...previous.ui, files } };
          yield* publishUi(loader, previous.ui, applied.ui).pipe(Effect.ignore);
        }),
      ),
    ),
  );

  const discovery = yield* readDiscovery(paths.home);
  if (discovery !== undefined) {
    const url = appUrl(discovery.url, "/", discovery.token);
    yield* log(`open ${url}`);
    if (!args.has("--no-open")) yield* openBrowser(url);
  }

  yield* untilSignal;
  yield* log("shutting down");
});

const exit = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(exit)) {
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof ReloadError) {
    await Effect.runPromise(printDiagnostics(failure.value.diagnostics));
    console.error("lemma: cannot start with this composition");
    if (!safe) console.error("lemma: --safe starts the bundled plugins as shipped, reading no config file or plugin file, while you fix it");
  } else if (!Cause.hasInterruptsOnly(exit.cause)) {
    console.error(Cause.pretty(exit.cause));
  }
  process.exit(1);
}
