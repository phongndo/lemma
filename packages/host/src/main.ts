#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Cause, Deferred, Duration, Effect, Either, Exit, Option, ParseResult, Schema, Stream } from "effect";
import { HostControl, Notice, PluginsChanged, UiChanged } from "@lemma/contracts";
import { Diagnostic, Events, makeLoader, ReloadError } from "@lemma/core";
import type { Composition, CoreSnapshot, Event, Loader, Plugin, PluginSource, ReloadReport } from "@lemma/core";
import {
  catalog,
  compositionInfo,
  faultHistory,
  HOST_PLUGIN_ID,
  hostPlugin,
  listUiFiles,
  loadComposition,
  projectPluginsDir,
  readConfigText,
  resolveComposition,
  resolvePaths,
  restartedBy,
  updateConfig,
  watchConfig,
  watchUi,
  withReplacements,
} from "@lemma/plugin-host";
import type { ConfigSection, HostControlService, KnownPlugin, Resolved } from "@lemma/plugin-host";
import type { ConfigScope, ConfigureReport, PluginChange, UiComposition } from "@lemma/contracts";
import { readDiscovery } from "@lemma/plugin-transport";
import { bundled, withDefaults } from "./bundled.ts";
import { loadLocalPlugins } from "./local.ts";

const args = new Set(process.argv.slice(2));
// `pnpm start` runs from packages/host; INIT_CWD is where the user invoked it.
const paths = resolvePaths({ env: process.env, cwd: process.env.INIT_CWD ?? process.cwd() });
// Consumed here: tools inherit this environment, and a CLI the agent runs must use its own directory, not ours.
delete process.env.INIT_CWD;
const userPluginsDir = join(paths.home, "plugins");

/** Plugins no config change may turn off, with the reason clients show. Everything they need is locked with them. */
const pinned: Readonly<Record<string, string>> = {
  host: "Reads the config files and loads every other plugin",
  transport: "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
};

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
  /** What the loader runs: `composition` minus plugins whose requirements a disabled plugin leaves unmet. */
  readonly resolved: Resolved;
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

/** The plugin a halted one ultimately waits on: the first in its chain that is turned off. */
const rootOf = (resolved: Resolved, id: string): string => {
  let current = id;
  for (let next = resolved.haltedBy.get(current); next !== undefined; next = resolved.haltedBy.get(current)) current = next;
  return current;
};

/** Read config files and local plugins into the next composition. Warnings print here; errors fail. */
const load = (host: Plugin): Effect.Effect<Loaded, ReloadError> =>
  Effect.gen(function* () {
    const loaded = yield* loadComposition(paths);
    // Project plugins run only in a project the user config trusts; see `loadComposition`.
    const local = yield* loadLocalPlugins(loaded.trusted ? [userPluginsDir, projectPluginsDir(paths)] : [userPluginsDir]);
    const diagnostics = [...local.diagnostics, ...loaded.diagnostics];
    // A local plugin with a bundled id takes the bundled one's place, in its position; later directories win.
    const byId = new Map<string, KnownPlugin>();
    for (const plugin of bundled(host)) byId.set(plugin.id, { plugin, source: "bundled" });
    for (const { plugin, dir } of local.plugins) {
      const previous = byId.get(plugin.id);
      const shadows = previous?.source === "bundled" || previous?.shadows === true;
      byId.set(plugin.id, { plugin, source: dir === userPluginsDir ? "user" : "project", ...(shadows ? { shadows } : {}) });
    }
    const known = [...byId.values()];
    const composition = withDefaults([...byId.keys()], loaded.composition);
    const resolved = resolveComposition(known, composition, Object.keys(pinned));
    for (const [id, by] of resolved.haltedBy) {
      const root = rootOf(resolved, id);
      const chain = root === by ? `"${by}"` : `"${by}", which needs "${root}"`;
      diagnostics.push(
        new Diagnostic({
          severity: "warning",
          pluginId: id,
          message: `"${id}" is not loaded: it needs ${chain}, and "${root}" is turned off`,
          suggestion: `Turn "${root}" on to load "${id}"`,
        }),
      );
    }
    // The host's policy for a row turning off what cannot be turned off: refuse the config rather than ignore the row.
    for (const id of resolved.overridden) {
      const root = resolved.locked.get(id)!;
      const message = id === root ? `"${id}" cannot be turned off: ${pinned[id]}` : `"${id}" cannot be turned off: "${root}" needs it (${pinned[root]})`;
      diagnostics.push(new Diagnostic({ severity: "error", pluginId: id, message, suggestion: `Remove its "enabled" row` }));
    }
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length) return yield* new ReloadError({ diagnostics: errors });
    // Only for a composition that will run: a rejected one's warnings describe nothing that happens.
    yield* printDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
    const files = yield* listUiFiles(paths, loaded.trusted);
    return { known, composition, resolved, enabledIn: loaded.enabledIn, configIn: loaded.configIn, trusted: loaded.trusted, ui: { ...loaded.ui, files } };
  });

const describe = (report: ReloadReport): string => {
  const parts = [
    report.started.length ? `started ${report.started.join(", ")}` : "",
    report.restarted.length ? `restarted ${report.restarted.join(", ")}` : "",
    report.stopped.length ? `stopped ${report.stopped.join(", ")}` : "",
    report.interrupted ? `interrupted ${report.interrupted} in-flight task(s)` : "",
    report.faults.length ? `${report.faults.length} dispose fault(s)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing changed";
};

const untilSignal = Effect.async<void>((resume) => {
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

/** How long a deferred change waits for its reply to leave before the transport that sends it restarts. */
const DEFER = Duration.millis(250);
/**
 * How long stopping may take in all. The core's default (its 10 second dispose deadline) would cut it short of a
 * plugin that asks for longer to close: the agent takes up to 30 seconds, letting running turns reach a point to
 * resume from.
 */
const SHUTDOWN_TIMEOUT = Duration.seconds(40);

/** Decodes the configs of `ids` as the loader will, so a change that restarts the transport is refused before it is applied. */
const checkConfigs = (next: Loaded, ids: readonly string[]): Effect.Effect<void, ReloadError> => {
  const diagnostics: Diagnostic[] = [];
  for (const id of ids) {
    const plugin = next.known.find((entry) => entry.plugin.id === id)?.plugin;
    const entry = next.resolved.composition.plugins[id];
    if (plugin?.config === undefined || entry === undefined) continue;
    const decoded = Schema.decodeUnknownEither(plugin.config)(entry.config ?? {});
    if (Either.isRight(decoded)) continue;
    const issue = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)[0];
    const at = issue?.path.filter((segment): segment is string | number => typeof segment !== "symbol") ?? [];
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
  // The host plugin activates inside makeLoader, so its handle binds to the loader once it exists.
  const ready = yield* Deferred.make<Loader>();
  const reloading = yield* Effect.makeSemaphore(1);
  const withLoader = <A, E>(f: (loader: Loader) => Effect.Effect<A, E>) => Effect.flatMap(Deferred.await(ready), f);
  let host: Plugin;
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
      return yield* Effect.flatMap(load(host), (next) => apply(loader, next)).pipe(
        Effect.tapError(() => update.restore.pipe(Effect.tap(() => Effect.sync(() => seenConfig.set(path, update.previous))))),
      );
    });
  /**
   * A change that restarts the transport would drop the connection asking for
   * it, so it is checked and written now and applied once the reply is out
   * (see `ConfigureReport`). If applying still fails, the file is put back and
   * clients hear why.
   */
  const writeDeferred = (loader: Loader, rows: Readonly<Record<string, PluginChange>>, scope: ConfigScope) =>
    Effect.gen(function* () {
      const path = scope === "user" ? paths.userConfig : paths.projectConfig;
      const update = yield* updateConfig(path, rows, scope, "plugins").pipe(Effect.mapError(rejected));
      seenConfig.set(path, update.text);
      const restore = update.restore.pipe(Effect.tap(() => Effect.sync(() => seenConfig.set(path, update.previous))));
      const next = yield* load(host).pipe(Effect.tapError(() => restore));
      yield* checkConfigs(next, Object.keys(rows)).pipe(Effect.tapError(() => restore));
      const later = reloading
        .withPermits(1)(Effect.flatMap(load(host), (loaded) => apply(loader, loaded)))
        .pipe(
          Effect.matchEffect({
            onSuccess: (report) =>
              log(`applied a config change: ${describe(report)}`).pipe(
                Effect.zipRight(Effect.flatMap(handle.plugins, (plugins) => publish(loader, PluginsChanged, { plugins }))),
              ),
            onFailure: (error) =>
              restore.pipe(
                Effect.zipRight(printDiagnostics(error.diagnostics)),
                Effect.zipRight(
                  publish(loader, Notice, {
                    level: "error",
                    source: HOST_PLUGIN_ID,
                    message: `The config change could not be applied and was undone: ${error.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
                  }),
                ),
              ),
          }),
          Effect.ignore,
        );
      yield* Effect.forkIn(Effect.delay(later, DEFER), programScope);
      const report: ConfigureReport = { started: [], restarted: [], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [], deferred: true };
      return report;
    });
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
  const reload = withLoader((loader) => reloading.withPermits(1)(Effect.flatMap(load(host), (next) => apply(loader, next))));
  const handle: HostControlService = {
    plugins: withLoader((loader) => Effect.map(loader.core.inspect, catalogOf)),
    ui: Effect.sync(() => applied.ui),
    configureUi: (rows, options) =>
      withLoader((loader) =>
        reloading.withPermits(1)(
          Effect.gen(function* () {
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
          // Replacing a plugin the transport needs restarts the transport too, dropping the client that asked; refuse rather than surprise.
          if (options?.force) {
            const entry = catalogOf(yield* loader.core.inspect).find((candidate) => candidate.id === pluginId);
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
          return yield* loader.core.restart(pluginId, options);
        }),
      ),
    reload,
    configure: (requested, options) =>
      withLoader((loader) =>
        reloading.withPermits(1)(
          Effect.gen(function* () {
            const scope = options?.scope ?? "user";
            if (scope === "project" && !applied.trusted) return yield* untrustedProject();
            // Checked here so the answer is immediate and the file is never touched: the load would refuse these too.
            const entries = catalogOf(yield* loader.core.inspect);
            for (const [id, row] of Object.entries(requested)) {
              if (id === HOST_PLUGIN_ID) {
                return yield* rejected(
                  new Diagnostic({
                    severity: "error",
                    pluginId: id,
                    message: `The "${id}" row is fixed: ${pinned[id]}`,
                    suggestion: "Configure another plugin",
                  }),
                );
              }
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
            // The transport serves this call; a change that restarts it is applied after the reply.
            const restarts = restartedBy(applied.known, Object.keys(rows));
            if (Object.keys(pinned).some((id) => restarts.has(id))) return yield* writeDeferred(loader, rows, scope);
            return yield* write(loader, rows, scope, "plugins");
          }),
        ),
      ),
  };
  // Recorded on the stream the host plugin reacts to, so the catalog it publishes already has the fault.
  host = hostPlugin({
    control: handle,
    faults: Stream.unwrap(withLoader((loader) => Effect.succeed(loader.core.faults))).pipe(Stream.tap((fault) => Effect.sync(() => faults.record(fault)))),
  });

  applied = yield* load(host);
  const loader = yield* makeLoader({ source, composition: applied.resolved.composition, shutdownTimeout: SHUTDOWN_TIMEOUT });
  yield* Deferred.succeed(ready, loader);
  // Captured once: a reload drains in-flight core.run work, so it must not run inside core.run.
  const control = yield* loader.core.run(HostControl);
  const { plugins } = yield* loader.core.inspect;
  yield* log(`running ${plugins.map((plugin) => plugin.id).join(", ")}`);
  yield* log(`home ${paths.home}, project ${paths.cwd}`);

  yield* Effect.forkScoped(
    Stream.runForEach(loader.core.faults, (fault) =>
      Effect.sync(() => {
        console.error(`lemma: ${fault.message}\n${Cause.pretty(fault.cause)}`);
      }),
    ),
  );
  for (const [path, text] of yield* readConfigFiles) seenConfig.set(path, text);
  yield* Effect.forkScoped(
    Stream.runForEach(watchConfig(paths), () =>
      Effect.gen(function* () {
        // Only what differs from the last read or write is new; a change this process wrote (a configure, or its undo) is already applied.
        const current = yield* readConfigFiles;
        const changed = current.filter(([path, text]) => seenConfig.get(path) !== text).map(([path]) => path);
        if (changed.length === 0) return;
        for (const [path, text] of current) seenConfig.set(path, text);
        yield* log(`${changed.length === 1 ? changed[0] : changed.join(" and ")} changed; reloading`).pipe(
          Effect.zipRight(control.reload),
          Effect.matchEffect({
            onFailure: (error) => printDiagnostics(error.diagnostics).pipe(Effect.zipRight(log("reload rejected; the running composition is unchanged"))),
            onSuccess: (report) => log(`reloaded: ${describe(report)}`),
          }),
        );
      }),
    ),
  );

  // A UI file added, edited, or removed changes only what web apps load.
  yield* Effect.forkScoped(
    Stream.runForEach(watchUi(paths), () =>
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
    const url = `${discovery.url}/?token=${encodeURIComponent(discovery.token)}`;
    yield* log(`open ${url}`);
    if (!args.has("--no-open")) yield* openBrowser(url);
  }

  yield* untilSignal;
  yield* log("shutting down");
});

const exit = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof ReloadError) {
    await Effect.runPromise(printDiagnostics(failure.value.diagnostics));
    console.error("lemma: cannot start with this composition");
  } else if (!Cause.isInterruptedOnly(exit.cause)) {
    console.error(Cause.pretty(exit.cause));
  }
  process.exit(1);
}
