import { Cause, Effect, Exit, Scope, Stream } from "effect";
import type { Context } from "effect";
import { Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { runPromise } from "@lemma/client";
import type { Host } from "@lemma/client";
import { faultMessage, toPluginStatus } from "@lemma/contracts";
import type { PluginStatus, ReloadResult, UiComposition, UiFile } from "@lemma/contracts";
import { Diagnostic, makeLoader, ReloadError } from "@lemma/core";
import { settlePaint } from "../lib/paint.ts";
import type { Loader, Plugin, PluginSource, ReloadReport, ReportedFault } from "@lemma/core";
import { catalog, faultHistory, planComposition, withReplacements } from "@lemma/composition";
import type { Plan } from "@lemma/composition";
import type { AnyRoute } from "@lemma/router";
import { createClientPlugin } from "./client.ts";
import { Notify, Root, Slots, UI_API, UiApi, UiPlugins } from "./contracts.ts";
import type { UiPluginsService } from "./contracts.ts";
import { defineUiPlugin, routesOf } from "./define.ts";
import { First, SlotsContext } from "./parts.tsx";
import { createFileLoader } from "./files.ts";
import type { SlotsService } from "./slots.ts";

const APP_ID = "app";
/**
 * Always on, with everything they need ("Needed by …"): the switches that turn
 * plugins back on, and the frame they are shown in. Without these a switch on
 * the Plugins page could take the page itself away; `?safe` is the way back
 * from a UI file that breaks them.
 */
const PINNED: Readonly<Record<string, string>> = {
  [APP_ID]: "Runs the web app's plugins; with it off, nothing could turn them back on",
  "plugins-page": "Where plugins are turned back on; replace it with a UI file instead of turning it off",
  shell: "Draws the frame every other view shows in, settings included; replace it with a UI file instead of turning it off",
  router: "Turns the page's address into what it shows; the threads and settings follow it",
  pages: "Shows the page the address names, settings included; replace it with a UI file instead of turning it off",
};
const EMPTY: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
/** How long the first paint waits for the host's `ui` rows before starting with the defaults. */
const FIRST_ROWS_MS = 3_000;

export interface BootOptions {
  readonly host: Host;
  readonly token: string | undefined;
  /** The app's own plugins, in order; the boot adds `client` and `app`. */
  readonly bundled: readonly Plugin[];
  /** Loads the object UI files receive (see `createFileLoader`). */
  readonly api: () => Promise<unknown>;
  readonly element: HTMLElement;
  /** `?safe`: ignore `ui` rows and UI files, running the app as shipped. */
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
 * Runs the web app as a composition of UI plugins on the kernel, planned from
 * the bundled plugins, the host's `ui` rows, and UI files, and renders the
 * `root` slot. A `ui-changed` from the host (an edited config file, a file
 * added to `~/.lemma/ui`, a switch on the Plugins page) is applied in place:
 * only what changed, and what depends on it, restarts.
 */
export async function boot(options: BootOptions): Promise<void> {
  const { host, safe } = options;
  const [statuses, setStatuses] = createSignal<readonly PluginStatus[]>([]);
  const [files, setFiles] = createSignal<readonly UiFile[]>([]);
  const [problems, setProblems] = createSignal<readonly string[]>([]);
  const [slots, setSlots] = createSignal<SlotsService>();
  const [routes, setRoutes] = createSignal<readonly { readonly route: AnyRoute; readonly pluginId: string }[]>([]);
  const fileLoader = createFileLoader(options.token, options.api);
  let ui: UiComposition = EMPTY;
  let plan!: Plan;
  let loader!: Loader;
  let queue: Promise<unknown> = Promise.resolve();
  const toasted = new Set<string>();
  const faults = faultHistory();

  /** A capability of the running composition, or undefined when no plugin provides it. */
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
    setSlots(await serviceOf(Slots));
  };
  /** New problems become warnings, once each, where a Notify is running; all of them stay listed on the Plugins page. */
  const report = async (found: readonly string[]) => {
    setProblems(found);
    const fresh = found.filter((problem) => !toasted.has(problem));
    for (const problem of found) toasted.add(problem);
    if (fresh.length === 0) return;
    for (const problem of fresh) console.warn(`lemma ui: ${problem}`);
    const notify = await serviceOf(Notify);
    for (const problem of fresh) notify?.toast({ level: "warning", source: "ui", message: problem });
  };

  const client = createClientPlugin(host);
  const service: UiPluginsService = {
    list: statuses,
    files,
    routes,
    problems,
    safe,
    refresh,
    restart: async (plugin, restartOptions) => {
      await runPromise(loader.core.restart(plugin.id, restartOptions?.force ? { force: true } : undefined));
      await refresh();
    },
    setEnabled: async (plugin, enabled) => {
      // Turning on a plugin that provides what another does turns that one off, as on the host.
      const rows = withReplacements(plan.known, plan.composition, { [plugin.id]: { enabled } });
      const next = await host.ui.configure(rows, ui.enabledIn[plugin.id] === "project" ? { scope: "project" } : undefined);
      return toResult(await apply(next));
    },
    setConfig: async (plugin, values) => {
      const next = await host.ui.configure({ [plugin.id]: { values } }, ui.configIn[plugin.id] === "project" ? { scope: "project" } : undefined);
      return toResult(await apply(next));
    },
  };
  // The app provides the contracts' version, so a plugin written for another is left out rather than run.
  const app = defineUiPlugin({ id: APP_ID, provides: { plugins: UiPlugins, api: UiApi(UI_API) }, setup: () => ({ plugins: service, api: UI_API }) });
  const fixed = [client, app, ...options.bundled];

  /**
   * The composition for these rows and files (`planComposition`): what cannot
   * run is left out, with what needs it, and said so; `errors` are what keeps
   * it from running at all (a pinned plugin that cannot).
   */
  const planFor = async (next: UiComposition) => {
    const loaded = safe ? { plugins: [], problems: [] } : await fileLoader.load(next.files);
    const planned = planComposition({ bundled: fixed, local: loaded.plugins, rows: safe ? {} : next.plugins, pinned: Object.keys(PINNED) });
    const said = (diagnostic: Diagnostic) => `${diagnostic.message}${diagnostic.suggestion === undefined ? "" : `. ${diagnostic.suggestion}`}`;
    return {
      plan: planned,
      errors: planned.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map(said),
      // A plugin waiting on one that is off is what turning that one off means: the Plugins page shows it, unannounced.
      problems: [
        ...loaded.problems,
        ...planned.diagnostics.filter((diagnostic) => diagnostic.severity === "warning" && !planned.resolved.haltedBy.has(diagnostic.pluginId ?? "")).map(said),
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
   * Applies the host's rows and files; unchanged ones are a no-op. One at a
   * time, in arrival order. A change that cannot start keeps the running
   * composition (the plugins it would replace go on as they were), and says why.
   */
  const apply = (next: UiComposition): Promise<ReloadReport | undefined> => {
    const run = queue.then(async () => {
      if (safe || JSON.stringify(next) === JSON.stringify(ui)) return undefined;
      const planned = await planFor(next);
      if (planned.errors.length > 0) {
        await report([...planned.problems, ...planned.errors]);
        return undefined;
      }
      const previous = plan;
      // The source resolves ids against the plan being applied.
      plan = planned.plan;
      const exit = await Effect.runPromiseExit(loader.apply(planned.plan.resolved.composition));
      if (Exit.isSuccess(exit)) {
        adopt(planned.plan);
        ui = next;
        setFiles(next.files);
      } else plan = previous;
      await refresh();
      await report(Exit.isSuccess(exit) ? planned.problems : [...planned.problems, ...describeFailure(exit.cause)]);
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
  const initial = firstRows === undefined ? EMPTY : ((await timeout(firstRows, FIRST_ROWS_MS).catch(() => undefined)) ?? EMPTY);
  const scope = await runPromise(Scope.make());
  /** Starts `planned` with what can start: a plugin that fails is left failed, unless it is pinned or a pinned plugin needs it. */
  const start = (planned: Plan) =>
    Effect.runPromiseExit(
      Scope.provide(makeLoader({ source, composition: planned.resolved.composition, partialStart: { required: planned.required } }), scope),
    );
  let first = await planFor(initial);
  adopt(first.plan);
  let made = first.errors.length > 0 ? undefined : await start(first.plan);
  let bootProblems = [...first.problems, ...first.errors];
  if (made !== undefined && Exit.isSuccess(made)) ui = initial;
  else {
    // Rows or files that keep the app's own frame from starting still leave the app as shipped.
    if (made !== undefined) bootProblems = [...bootProblems, ...describeFailure(made.cause)];
    first = await planFor(EMPTY);
    adopt(first.plan);
    made = await start(first.plan);
    if (Exit.isFailure(made)) throw new Error(`The web app cannot start: ${describeFailure(made.cause).join("; ")}`);
  }
  loader = made.value;
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

  // Development builds: the running composition for DevTools and the UI check (`scripts/check-ui.ts`).
  if (import.meta.env.DEV) Object.assign(window, { lemma: { slots, plugins: service, faults, service: serviceOf } });
  render(() => {
    // The frame failing leaves nothing that could say so: the page says it itself, with the way back.
    const failure = () => slots()?.failures(Root)[0];
    // Parts anywhere on the page find their providers through this.
    return (
      <SlotsContext.Provider value={slots}>
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
                    <a href="?safe">Open the app as shipped</a>, without your UI files and <code>ui</code> rows, to fix it.
                  </p>
                </main>
              )}
            </Show>
          }
        />
      </SlotsContext.Provider>
    );
  }, options.element);
  await report(bootProblems);

  Effect.runFork(
    Stream.runForEach(loader.core.faults, (fault) =>
      Effect.promise(async () => {
        console.error(`lemma ui: ${fault.message}`, Cause.pretty(fault.cause));
        faults.record(fault);
        await refresh();
        const notify = await serviceOf(Notify);
        notify?.toast({ level: "error", source: fault.pluginId, message: faultMessage(fault) });
      }),
    ),
  );
  if (safe) return;
  /** Set once anything newer than the first fetch arrives, so a late first reply cannot undo it. */
  let superseded = false;
  host.onEvent((event) => {
    if (event.type !== "ui-changed") return;
    superseded = true;
    void apply(event.ui);
  });
  // A first reply slower than the first paint still applies.
  void firstRows?.then(
    (rows) => (superseded ? undefined : apply(rows)),
    () => {},
  );
  // Fetch again on every connection whose rows this page has not read: rows and files may have changed while it was down.
  host.onStatus((status) => {
    if (status.state !== "connected" || status.generation === synced) return;
    synced = status.generation;
    void host.ui.composition().then(
      (rows) => {
        superseded = true;
        return apply(rows);
      },
      () => {},
    );
  });
}
