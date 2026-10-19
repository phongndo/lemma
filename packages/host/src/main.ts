#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Cause, Duration, Effect, Exit, Option, Stream } from "effect";
import { appUrl, faultMessage } from "@lemma/contracts";
import { Diagnostic, makeLoader, makeSpanCollector, ReloadError } from "@lemma/core";
import type { ReportedFault } from "@lemma/core";
import { compositionHistory, faultHistory, planComposition } from "@lemma/composition";
import type { PluginRow, WebComposition } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { appDefaults, bundled, bundledCode, bundledWeb, optIn } from "./bundled.ts";
import { loadComposition, projectPluginsDir, readConfigText, updateConfig } from "./config.ts";
import { makeHostChanges } from "./control.ts";
import type { HostChanges, Read } from "./control.ts";
import { SHUTDOWN_TIMEOUT_MS } from "./limits.ts";
import { linkHostPackages } from "./links.ts";
import { loadLocalPlugins } from "./local.ts";
import { resolvePaths } from "./paths.ts";
import { holdHostLock, teeLog } from "./process.ts";
import { recordStall, watchStalls } from "./stall.ts";
import type { CodeOwner, StallWatch } from "./stall.ts";
import { catchUnhandled, hostRuntime, reportFaults, runtimeCapabilities } from "./runtime.ts";
import { listWebFiles, userPluginsDir as pluginsDirOf } from "./web.ts";
import { watchConfig, watchPlugins } from "./watch.ts";

const argv = process.argv.slice(2);
const args = new Set(argv);
/** `--name value` or `--name=value` among the host's arguments. */
const argValue = (name: string): string | undefined => {
  const at = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (at === -1) return undefined;
  const arg = argv[at]!;
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[at + 1];
};
/**
 * The transport's `port` and `host` for this run only (`lemma serve --port 8080 --host 0.0.0.0`): over what the config
 * files say, and never written to them.
 */
const transportOverrides: Readonly<Record<string, unknown>> = {
  ...(argValue("port") === undefined ? {} : { port: Number(argValue("port")) }),
  ...(argValue("host") === undefined ? {} : { host: argValue("host") }),
};
const withOverrides = (rows: Readonly<Record<string, PluginRow>>): Readonly<Record<string, PluginRow>> => {
  if (Object.keys(transportOverrides).length === 0) return rows;
  const row = rows["transport.server"] ?? {};
  const config = typeof row.config === "object" && row.config !== null ? row.config : {};
  return { ...rows, "transport.server": { ...row, config: { ...config, ...transportOverrides } } };
};
/**
 * `--safe` (or `LEMMA_SAFE=1`): the bundled plugins as shipped, reading no
 * config file and no plugin file, and writing neither: the way back from a
 * customization that keeps the host from starting.
 */
const safe = args.has("--safe") || process.env.LEMMA_SAFE === "1";
/**
 * `LEMMA_SUPERVISED=1`: started, leading a process group of its own, by a process that holds the host's stdin open
 * while it wants the host (`lemma plugins check`). However that process ends, its end of the pipe closes: the host
 * then stops as on SIGTERM, and, once stopped or however it exits, kills its group, so that neither it nor anything
 * its plugins started in it outlives it (a process started in a group of its own is out of its reach). Resolves when
 * stdin ends.
 */
let supervisorLeft = false;
const supervisorGone =
  process.env.LEMMA_SUPERVISED === "1"
    ? new Promise<void>((resolve) => {
        // What it prints has no reader once its supervisor is gone: a write to the closed pipe must not fail the host,
        // nor end it before it stops, as the CLI that launched it would (`lemma … | head`).
        for (const stream of [process.stdout, process.stderr]) stream.removeAllListeners("error").on("error", () => {});
        process.stdin
          .on("end", resolve)
          .on("close", resolve)
          .on("error", () => resolve())
          .resume();
        // Read without keeping the host running: it exits once its work is done, as any host does.
        (process.stdin as { unref?: () => void }).unref?.();
      }).then(() => {
        supervisorLeft = true;
      })
    : undefined;
// Consumed here, as tools inherit this environment.
delete process.env.LEMMA_SUPERVISED;
/** Kills the host's process group, which a supervised host leads; false if it leads none. */
const killOwnGroup = (): boolean => {
  try {
    process.kill(-process.pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
};
// However it exits (failing to start, a fault that ends it) once its supervisor is gone, nothing else would end what
// its plugins started. While the supervisor runs, it does, and reports what was left.
if (supervisorGone !== undefined) process.on("exit", () => void (supervisorLeft && killOwnGroup()));
/**
 * This process, and what started it, as it said: `LEMMA_STARTED_BY` (`cli` for `lemma serve --detach`, `desktop`,
 * `service`). Consumed here, so what the host's tools start is not taken for it.
 */
const launch = {
  pid: process.pid,
  startedAt: Date.now(),
  ...(process.env.LEMMA_STARTED_BY?.trim() ? { startedBy: process.env.LEMMA_STARTED_BY.trim() } : {}),
};
delete process.env.LEMMA_STARTED_BY;
// `pnpm start` runs from packages/host; INIT_CWD is where the user invoked it.
const paths = resolvePaths({ env: process.env, cwd: process.env.INIT_CWD ?? process.cwd() });
// One host per home, said before anything starts: a second would break the sessions store's single writer.
const holder = holdHostLock(paths.home);
if (holder !== undefined) {
  const which = holder > 0 ? ` (pid ${holder})` : "";
  console.error(`lemma: a host already runs for ${paths.home}${which}; \`lemma status\` shows it, and \`lemma stop\` stops it`);
  process.exit(1);
}
teeLog(
  paths.home,
  `lemma: --- ${new Date(launch.startedAt).toISOString()} pid ${launch.pid}${launch.startedBy === undefined ? "" : `, started by ${launch.startedBy}`} ---`,
);
// What the host's tools run reaches this host: a \`lemma\` command the agent runs finds it in this home, whatever the
// environment the host was started in names (another host's LEMMA_URL, a default environment), and prints JSON.
process.env.LEMMA_HOME = paths.home;
process.env.LEMMA_ENV = "local";
process.env.LEMMA_AGENT = "1";
delete process.env.LEMMA_URL;
delete process.env.LEMMA_TOKEN;
// Consumed here: tools inherit this environment, and a CLI the agent runs must use its own directory, not ours.
delete process.env.INIT_CWD;
const userPluginsDir = pluginsDirOf(paths);

/** Plugins no config change may turn off, with the reason clients show. Everything they need is locked with them. */
const pinned: Readonly<Record<string, string>> = {
  "transport.server": "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
};
/** What the host provides itself (see `hostRuntime`): planned as present, and refused from a plugin. */
const provided = runtimeCapabilities;
/** What `Trace` reads: every span the host's work ends, kept in memory, and the composition's changes. */
const spans = makeSpanCollector();
const changes = compositionHistory();

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

/** The event loop's watchdog (`watchStalls`), told where plugins' code is each time that may have changed. */
let stalls: StallWatch | undefined;
/** The host's changes to its composition, once its first load is read. */
let changing: HostChanges | undefined;

const EMPTY_WEB: WebComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };

/** Reads config files and local plugins into the next composition (see `planComposition`), with every diagnostic. */
const read: Effect.Effect<Read, ReloadError> = Effect.gen(function* () {
  const input = { bundled, optIn, pinned: Object.keys(pinned), defaults: appDefaults, provided, localRequired: true };
  if (safe) {
    const planned = planComposition({ ...input, local: [], rows: withOverrides({}) });
    // The bundled plugins as shipped: only an error in them is said, as it stops the start.
    const diagnostics = planned.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    return { ...planned, diagnostics, enabledIn: {}, configIn: {}, trusted: false, web: EMPTY_WEB, webIds: bundledWeb, code: bundledCode(bundled) };
  }
  const loaded = yield* loadComposition(paths);
  // Project plugins run only in a project the user config trusts; see `loadComposition`.
  const local = yield* loadLocalPlugins(loaded.trusted ? [userPluginsDir, projectPluginsDir(paths)] : [userPluginsDir], {
    bundled: Object.fromEntries(input.bundled.map((plugin) => [plugin.id, plugin])),
  });
  const localPlugins = local.plugins.map(({ plugin, dir }) => ({ plugin, source: dir === userPluginsDir ? ("user" as const) : ("project" as const) }));
  const files = yield* listWebFiles(paths, loaded.trusted);
  // A row naming a web half is the web app's, which plans its halves from the same rows; one naming no plugin either
  // app has is a mistake (renamed, removed, mistyped), said so here with the id meant, and refused when required.
  const webIds = [...new Set([...bundledWeb, ...files.flatMap((file) => (file.kind === "script" && file.plugin !== undefined ? [file.plugin] : []))])];
  const planned = planComposition({
    ...input,
    local: localPlugins,
    rows: withOverrides(loaded.rows),
    elsewhere: (id) => webIds.includes(id),
    elsewhereIds: webIds,
  });
  return {
    known: planned.known,
    composition: planned.composition,
    resolved: planned.resolved,
    required: planned.required,
    problems: planned.problems,
    diagnostics: [...local.diagnostics, ...loaded.diagnostics, ...planned.diagnostics],
    enabledIn: loaded.enabledIn,
    configIn: loaded.configIn,
    trusted: loaded.trusted,
    web: { plugins: loaded.rows, enabledIn: loaded.enabledIn, configIn: loaded.configIn, files },
    webIds,
    code: [...bundledCode(bundled), ...local.plugins.map(({ plugin, code }) => ({ path: code, id: plugin.id }))],
  };
});

const untilSignal = Effect.callback<void>((resume) => {
  const done = () => resume(Effect.void);
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  void supervisorGone?.then(done);
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

const SHUTDOWN_TIMEOUT = Duration.millis(SHUTDOWN_TIMEOUT_MS);

const program = Effect.gen(function* () {
  const faults = faultHistory();
  if (safe) yield* log("safe mode: the bundled plugins as shipped; no config file or plugin file is read or written");
  // What a plugin file imports, where it and an editor find it: `<home>/node_modules`. Never stops the start.
  else
    yield* Effect.tryPromise(() => linkHostPackages(paths.home)).pipe(
      Effect.flatMap((linked) =>
        linked.length === 0 ? Effect.void : log(`linked ${linked.length} packages plugin files import into ${paths.home}/node_modules`),
      ),
      Effect.catch((error) => log(`could not link the packages plugin files import into ${paths.home}/node_modules: ${String(error)}`)),
    );
  const host = yield* makeHostChanges({
    paths,
    read,
    readConfig: (path) => readConfigText(path).pipe(Effect.orElseSucceed(() => undefined)),
    updateConfig,
    webFiles: (trusted) => listWebFiles(paths, trusted),
    pinned,
    safe,
    process: launch,
    changes,
    faults,
    log,
    printDiagnostics,
    onCode: () => stalls?.refresh(),
  });
  changing = host;
  stalls?.refresh();
  const first = host.applied();
  // What cannot start is left failed, restartable, unless it is required: the essential plugins, your own, and rows marked so.
  const loader = yield* makeLoader({
    source: host.source,
    composition: first.resolved.composition,
    provide: hostRuntime({ paths, control: host.handle, trace: { spans, changes } }),
    shutdownTimeout: SHUTDOWN_TIMEOUT,
    partialStart: { required: first.required },
  }).pipe(
    // A plugin of yours that fails to start keeps the host down only because it is required: say how to start without it.
    Effect.mapError(
      (error) =>
        new ReloadError({
          diagnostics: error.diagnostics.map((diagnostic) =>
            diagnostic.suggestion === undefined &&
            diagnostic.pluginId !== undefined &&
            first.required.includes(diagnostic.pluginId) &&
            pinned[diagnostic.pluginId] === undefined
              ? new Diagnostic({ ...diagnostic, suggestion: `Fix it, or set "required": false in its row to start without it` })
              : diagnostic,
          ),
        }),
    ),
  );
  // Recorded before a client can reach the loader, so a change it asks for comes after.
  changes.started((yield* loader.core.inspect).plugins);
  yield* host.bind(loader);
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

  // In safe mode the files are not read, so their changes are nothing to apply.
  yield* Effect.forkScoped(Stream.runForEach(safe ? Stream.empty : watchConfig(paths), () => host.configChanged));
  yield* Effect.forkScoped(Stream.runForEach(safe ? Stream.empty : watchPlugins(paths), () => host.pluginsChanged));

  const discovery = yield* readDiscovery(paths.home);
  if (discovery !== undefined) {
    const url = appUrl(discovery.url, "/", discovery.token);
    yield* log(`open ${url}`);
    if (!args.has("--no-open")) yield* openBrowser(url);
  }

  yield* untilSignal;
  yield* log("shutting down");
});

catchUnhandled();
// A plugin stuck in synchronous work blocks every session: said while it lasts, and kept in the trace as `host.stall`.
const NO_CODE: readonly CodeOwner[] = [];
stalls = watchStalls({ owners: () => changing?.code() ?? NO_CODE, onStall: (stall) => recordStall(spans.tracer, stall) });
const exit = await Effect.runPromiseExit(Effect.scoped(program).pipe(Effect.withTracer(spans.tracer)));
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
// Its own work is done: if the process does not exit now, something its plugins started keeps it running.
console.log("lemma: stopped");
void supervisorGone?.then(() => killOwnGroup() || process.exit(1));
