import { Cause, Effect, Exit, Scope, Stream } from "effect";
import type { Context } from "effect";
import { Show, createEffect, createRoot, createSignal, on } from "solid-js";
import { render } from "solid-js/web";
import { runPromise } from "@lemma/client";
import type { Host } from "@lemma/client";
import { faultMessage, toPluginStatus } from "@lemma/contracts";
import type { PluginStatus, ReloadResult, UiComposition, UiFile } from "@lemma/contracts";
import { Diagnostic, makeLoader, ReloadError } from "@lemma/core";
import { settlePaint } from "@lemma/ui/paint";
import type { Loader, Plugin, PluginSource, ReloadReport, ReportedFault } from "@lemma/core";
import { catalog, faultHistory, planComposition, withReplacements } from "@lemma/composition";
import type { Plan } from "@lemma/composition";
import type { AnyRoute } from "@lemma/router";
import { createWebRuntime, provides } from "../runtime/index.ts";
import { routesOf } from "@lemma/ui";
import { First, SlotsContext } from "@lemma/ui";
import { createFileLoader } from "./files.ts";
import { Root, Slots } from "@lemma/ui";
import type { UiPluginsService } from "@lemma/ui";
import type { SlotsService } from "@lemma/ui";

/**
 * Always on, with everything they need ("Needed by …"): the switches that turn
 * plugins back on, and the frame they are shown in. Without these a switch on
 * the Plugins page could take the page itself away; `?safe` is the way back
 * from a web half that breaks them.
 */
const PINNED: Readonly<Record<string, string>> = {
  "settings.plugins": "Where plugins are turned back on; replace it with a web half of your own instead of turning it off",
  "frame.shell": "Draws the frame every other view shows in, settings included; replace it with a web half of your own instead of turning it off",
  "frame.pages": "Shows the page the address names, settings included; replace it with a web half of your own instead of turning it off",
};
/** The keys of what the runtime provides (`UiPlugins.runtime`). */
const RUNTIME = provides.map((tag) => tag.key);
const EMPTY: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
/** How long the first paint waits for the host's rows before starting with the defaults. */
const FIRST_ROWS_MS = 3_000;

export interface BootOptions {
  readonly host: Host;
  readonly token: string | undefined;
  /** The app's own plugins, in order. The runtime they are written against is the boot's (`src/runtime/`), not among them. */
  readonly bundled: readonly Plugin[];
  /**
   * The app's own addresses, which links from outside the page name (`lemma
   * open`, a desktop deep link, a bookmark): known whatever plugins run, so one
   * whose page's plugin is off says so rather than that nothing lives there.
   */
  readonly appRoutes: readonly AnyRoute[];
  /** Loads the object web halves receive (see `createFileLoader`). */
  readonly api: () => Promise<unknown>;
  readonly element: HTMLElement;
  /** `?safe`: ignore the rows and the plugin directories' files, running the app as shipped. */
  readonly safe: boolean;
}

const toResult = (report: ReloadReport | undefined): ReloadResult => ({
  started: report?.started ?? [],
  restarted: report?.restarted ?? [],
  stopped: report?.stopped ?? [],
});

const timeout = <A,>(promise: Promise<A>, ms: number): Promise<A | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

/**
 * Runs the web app as a composition of web plugins on the kernel, planned from
 * the bundled plugins, the config's rows, and the web halves in the plugin
 * directories, over the runtime the app provides them (`createWebRuntime`),
 * and renders the `root` slot. A plugin is one id with a host half, a web
 * half, or both: its one row decides both, and a web half whose host half is
 * not running waits for it. A `ui-changed` from the host (an edited config
 * file, a file added to `~/.lemma/plugins`, a switch on the Plugins page), or
 * a host half starting or stopping, is applied in place: only what changed,
 * and what depends on it, restarts.
 */
export async function boot(options: BootOptions): Promise<void> {
  const { host, safe } = options;
  const [statuses, setStatuses] = createSignal<readonly PluginStatus[]>([]);
  const [files, setFiles] = createSignal<readonly UiFile[]>([]);
  const [problems, setProblems] = createSignal<readonly string[]>([]);
  const [routes, setRoutes] = createSignal<readonly { readonly route: AnyRoute; readonly pluginId: string }[]>([]);
  const fileLoader = createFileLoader(options.token, options.api);
  let ui: UiComposition = EMPTY;
  /** What the running plan was made from: the rows and files, and which host halves ran (see `planFor`). */
  let planned: string | undefined;
  let plan!: Plan;
  let loader!: Loader;
  /** The page's slots, the running core's: set once it has started. */
  let slots!: SlotsService;
  let queue: Promise<unknown> = Promise.resolve();
  const toasted = new Set<string>();
  const faults = faultHistory();

  /** A capability of the running composition (the runtime's, or a plugin's), or undefined when nothing provides it. */
  const serviceOf = <I, S>(tag: Context.Key<I, S>): Promise<S | undefined> =>
    Effect.runPromiseExit(loader.core.run(tag)).then((exit) => (Exit.isSuccess(exit) ? exit.value : undefined));
  const refresh = async () => {
    const snapshot = await runPromise(loader.core.inspect);
    const infos = catalog({
      known: plan.known,
      composition: plan.composition,
      resolved: plan.resolved,
      snapshots: snapshot.plugins,
      hooks: snapshot.hooks,
      events: snapshot.events,
      registries: snapshot.registries,
      faults: faults.get(),
      problems: plan.problems,
      enabledIn: safe ? {} : ui.enabledIn,
      configIn: safe ? {} : ui.configIn,
      pinned: PINNED,
    });
    setStatuses(infos.map(toPluginStatus));
  };

  const service: UiPluginsService = {
    list: statuses,
    runtime: () => RUNTIME,
    files,
    routes,
    problems,
    safe,
    refresh,
    restart: async (plugin, restartOptions) => {
      await runPromise(loader.core.restart(plugin.id, restartOptions?.force ? { force: true } : undefined));
      await refresh();
    },
    // A plugin's one row decides both its halves: the host writes it and applies its own, and this page its web half.
    setEnabled: async (plugin, enabled) => {
      // Turning on a plugin that provides what another does turns that one off, as on the host.
      const rows = withReplacements(plan.known, plan.composition, { [plugin.id]: { enabled } });
      await host.host.configure(rows, ui.enabledIn[plugin.id] === "project" ? { scope: "project" } : undefined);
      return toResult(await apply());
    },
    setConfig: async (plugin, values) => {
      await host.host.configure({ [plugin.id]: { values } }, ui.configIn[plugin.id] === "project" ? { scope: "project" } : undefined);
      return toResult(await apply());
    },
  };
  const runtime = createWebRuntime({ host, plugins: service, appRoutes: options.appRoutes });
  /** New problems become warnings, once each; all of them stay listed on the Plugins page. */
  const report = (found: readonly string[]) => {
    setProblems(found);
    const fresh = found.filter((problem) => !toasted.has(problem));
    for (const problem of found) toasted.add(problem);
    for (const problem of fresh) {
      console.warn(`lemma ui: ${problem}`);
      runtime.notify.toast({ level: "warning", source: "ui", message: problem });
    }
  };

  /**
   * The host's plugins as planning reads them: the ids it has (a row naming one is its own, not one this page lacks),
   * and those not running, whose web halves wait. Until the host has listed them, every id may be its.
   */
  const hostHalves = () => {
    const list = runtime.hostPlugins.list();
    const known = list.length > 0;
    const ids = new Set(list.map((plugin) => plugin.id));
    const stopped = new Map(list.filter((plugin) => plugin.state !== "active").map((plugin) => [plugin.id, `its host half is ${plugin.state}`] as const));
    // What re-planning follows: the ids, and the states of those with a web half here, so a host-only plugin's restart
    // or fault re-plans nothing.
    // (Before the first plan, the bundled ones.)
    const planned = (plan as Plan | undefined)?.known ?? [];
    const halved = new Set([...options.bundled.map((plugin) => plugin.id), ...planned.map(({ plugin }) => plugin.id)]);
    const key = JSON.stringify(list.map((plugin) => (halved.has(plugin.id) ? [plugin.id, plugin.state] : [plugin.id])));
    return { known, ids, stopped, key };
  };
  /**
   * The composition for these rows and files (`planComposition`): what cannot
   * run is left out, with what needs it, and said so; `errors` are what keeps
   * it from running at all (a pinned plugin that cannot).
   */
  const planFor = async (next: UiComposition) => {
    const loaded = safe ? { plugins: [], problems: [] } : await fileLoader.load(next.files);
    const halves = hostHalves();
    // Whether a required plugin runs is the host's to decide for its half: here, a web half waiting on its host half is
    // left out with a word rather than an error that would keep every later change from applying.
    const rows = Object.fromEntries(
      Object.entries(next.plugins).map(([id, row]) => [id, row.required === true && halves.stopped.has(id) ? { ...row, required: false } : row]),
    );
    const planned = planComposition({
      bundled: options.bundled,
      local: loaded.plugins,
      rows: safe ? {} : rows,
      pinned: Object.keys(PINNED),
      provided: runtime.services.provides,
      elsewhere: halves.known ? (id) => halves.ids.has(id) : () => true,
      blocked: halves.stopped,
    });
    const said = (diagnostic: Diagnostic) => `${diagnostic.message}${diagnostic.suggestion === undefined ? "" : `. ${diagnostic.suggestion}`}`;
    return {
      plan: planned,
      errors: planned.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map(said),
      // A plugin waiting on one that is off, or a web half on its host half, is what turning that one off means (and a
      // host half that failed is announced as its fault): the Plugins page shows it, unannounced.
      problems: [
        ...loaded.problems,
        ...planned.diagnostics
          .filter((diagnostic) => diagnostic.severity === "warning")
          .filter((diagnostic) => !planned.resolved.haltedBy.has(diagnostic.pluginId ?? "") && !halves.stopped.has(diagnostic.pluginId ?? ""))
          .map(said),
      ],
    };
  };
  const adopt = (next: Plan) => {
    plan = next;
    setRoutes(next.known.flatMap(({ plugin }) => routesOf(plugin).map((route) => ({ route, pluginId: plugin.id }))));
  };
  const source: PluginSource = {
    resolve: (id) => {
      const found = plan.known.find((entry) => entry.plugin.id === id);
      return found !== undefined
        ? Effect.succeed(found.plugin)
        : Effect.fail(new Diagnostic({ severity: "error", pluginId: id, message: `No web app plugin "${id}"` }));
    },
  };
  const describeFailure = (cause: Cause.Cause<unknown>): string[] => {
    const failure = Cause.squash(cause);
    return failure instanceof ReloadError
      ? failure.diagnostics.map((diagnostic) => `${diagnostic.pluginId === undefined ? "" : `${diagnostic.pluginId}: `}${diagnostic.message}`)
      : [String(failure)];
  };

  /**
   * Applies the host's rows and files as they are when its turn comes, so a
   * change heard late cannot undo a newer one; unchanged ones are a no-op. One
   * at a time. A change that cannot start keeps the running composition (the
   * plugins it would replace go on as they were), and says why. With no host to
   * ask, nothing changes: the next connection asks again.
   */
  const apply = (): Promise<ReloadReport | undefined> => {
    const run = queue.then(async () => {
      if (safe) return undefined;
      const next = await host.ui.composition().catch(() => undefined);
      if (next === undefined) return undefined;
      synced = host.status().generation;
      const key = JSON.stringify([next, hostHalves().key]);
      if (key === planned) return undefined;
      const made = await planFor(next);
      if (made.errors.length > 0) {
        report([...made.problems, ...made.errors]);
        return undefined;
      }
      const previous = plan;
      // The source resolves ids against the plan being applied.
      plan = made.plan;
      const exit = await Effect.runPromiseExit(loader.apply(made.plan.resolved.composition));
      if (Exit.isSuccess(exit)) {
        adopt(made.plan);
        ui = next;
        planned = key;
        setFiles(next.files);
      } else plan = previous;
      await refresh();
      report(Exit.isSuccess(exit) ? made.problems : [...made.problems, ...describeFailure(exit.cause)]);
      return Exit.isSuccess(exit) ? exit.value : undefined;
    });
    queue = run.catch(() => {});
    return run;
  };

  // The first paint waits briefly for the rows, so a replaced part never flashes the bundled one.
  /** The connection generation whose rows were fetched; -1 until one fetch succeeds. */
  let synced = -1;
  const firstRows = safe
    ? undefined
    : host.ui.composition().then((rows) => {
        synced = host.status().generation;
        return rows;
      });
  // And for the host's plugins, so a web half whose host half is not running never starts only to stop.
  const firstHalves = safe ? undefined : runtime.hostPlugins.refresh();
  // Both under one bound, so a slow host holds the first paint back FIRST_ROWS_MS at most, keeping the rows if they came.
  let rowsFound: UiComposition | undefined;
  await timeout(Promise.allSettled([firstRows?.then((rows) => (rowsFound = rows)), firstHalves]), FIRST_ROWS_MS);
  const initial = rowsFound ?? EMPTY;
  const scope = await runPromise(Scope.make());
  /**
   * Starts `planned` with what can start: a plugin that fails is left failed, unless it is pinned or a pinned plugin
   * needs it. The runtime's slots and router are built for the loader, and released with it.
   */
  const start = (planned: Plan) =>
    Effect.runPromiseExit(
      Scope.provide(
        makeLoader({ source, composition: planned.resolved.composition, partialStart: { required: planned.required }, provide: runtime.services }),
        scope,
      ),
    );
  let first = await planFor(initial);
  adopt(first.plan);
  let made = first.errors.length > 0 ? undefined : await start(first.plan);
  let bootProblems = [...first.problems, ...first.errors];
  if (made !== undefined && Exit.isSuccess(made)) {
    ui = initial;
    planned = JSON.stringify([initial, hostHalves().key]);
  } else {
    // Rows or files that keep the app's own frame from starting still leave the app as shipped.
    if (made !== undefined) bootProblems = [...bootProblems, ...describeFailure(made.cause)];
    first = await planFor(EMPTY);
    adopt(first.plan);
    made = await start(first.plan);
    if (Exit.isFailure(made)) throw new Error(`The web app cannot start: ${describeFailure(made.cause).join("; ")}`);
  }
  loader = made.value;
  slots = await runPromise(loader.core.run(Slots));
  // The look the last load remembered stays only if a plugin painted it again.
  settlePaint();
  // Plugins that failed to start, left failed: no fault stream existed yet to hear them.
  for (const plugin of (await runPromise(loader.core.inspect)).plugins) {
    if (plugin.state !== "failed" || plugin.fault === undefined) continue;
    faults.record(plugin.fault as ReportedFault);
    bootProblems = [...bootProblems, `"${plugin.id}" failed to start: ${faultMessage(plugin.fault)}`];
  }
  setFiles(ui.files);
  await refresh();
  // A host half starting or stopping starts or stops its web half: planned again with the same rows. For the page's life.
  createRoot(() =>
    createEffect(
      on(
        () => hostHalves().key,
        () => void apply(),
        { defer: true },
      ),
    ),
  );

  // Development builds: the running composition for DevTools and the UI check (`scripts/check-ui.ts`).
  if (import.meta.env.DEV) Object.assign(window, { lemma: { slots: () => slots, plugins: service, faults, service: serviceOf } });
  render(() => {
    // The frame failing leaves nothing that could say so: the page says it itself, with the way back.
    const failure = () => slots.failures(Root)[0];
    // Parts anywhere on the page find their providers through this.
    return (
      <SlotsContext.Provider value={() => slots}>
        <First
          slot={Root}
          fallback={
            <Show when={failure()} keyed>
              {(failed) => (
                <main class="boot-failed" role="alert">
                  <p>
                    The app's frame{failed.pluginId === undefined ? "" : `, from the “${failed.pluginId}” plugin,`} failed:{" "}
                    <code>{failed.error instanceof Error ? failed.error.message : String(failed.error)}</code>
                  </p>
                  <p>
                    <a href="?safe">Open the app as shipped</a>, without your plugins and rows, to fix it.
                  </p>
                </main>
              )}
            </Show>
          }
        />
      </SlotsContext.Provider>
    );
  }, options.element);
  report(bootProblems);

  Effect.runFork(
    Stream.runForEach(loader.core.faults, (fault) =>
      Effect.promise(async () => {
        console.error(`lemma ui: ${fault.message}`, Cause.pretty(fault.cause));
        faults.record(fault);
        await refresh();
        runtime.notify.toast({ level: "error", source: fault.pluginId, message: faultMessage(fault) });
      }),
    ),
  );
  if (safe) return;
  host.onEvent((event) => {
    if (event.type === "ui-changed") void apply();
  });
  // A first reply slower than the first paint still applies.
  void firstRows?.then(
    () => apply(),
    () => {},
  );
  // Read again on every connection whose rows this page has not read: rows and files may have changed while it was down.
  host.onStatus((status) => {
    if (status.state === "connected" && status.generation !== synced) void apply();
  });
}
