import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import { HOST_API, HostApi, HostControl, Notice, Paths, PluginsChanged, Trace } from "@lemma/contracts";
import type { CompositionInfo, NoticePayload, PluginInfo, PluginRow } from "@lemma/contracts";
import { definePlugin, Diagnostic, makeLoader, makeSpanCollector, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { compositionHistory, faultHistory, planComposition } from "@lemma/composition";
import { patchConfig } from "../src/config.ts";
import { makeHostChanges } from "../src/control.ts";
import type { ChangesOptions } from "../src/control.ts";
import { resolvePaths } from "../src/paths.ts";
import { hostRuntime, reportFaults, runtimeCapabilities } from "../src/runtime.ts";

const paths = resolvePaths({ env: { HOME: "/home/me" }, cwd: "/work" });

// A required background task that fails produces a real PluginFault, again after each restart.
const flaky = definePlugin({
  id: "flaky",
  layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.background("work", Effect.fail("boom"), { required: true }))),
});

/** Records what clients would hear, as an observer: it subscribes while activating, so no publication races it. */
function recorder() {
  const notices: NoticePayload[] = [];
  const changes: (readonly PluginInfo[])[] = [];
  const plugin = definePlugin({
    id: "recorder",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const context = yield* PluginContext;
        yield* context.observe(Notice, (notice) => Effect.sync(() => void notices.push(notice)), { overflow: "suspend" });
        yield* context.observe(PluginsChanged, ({ plugins }) => Effect.sync(() => void changes.push(plugins)), { overflow: "suspend" });
      }),
    ),
  });
  return { notices, changes, plugin };
}

/**
 * A plugin with a numbered config, recording each start's number: 13 fails to start, and 2, given `held`, says it has
 * begun and waits for `held.gate`.
 */
function numbered(id: string, held?: { readonly entered: Deferred.Deferred<void>; readonly gate: Deferred.Deferred<void> }) {
  const started: number[] = [];
  const plugin = definePlugin({
    id,
    config: Schema.Struct({ n: Schema.optional(Schema.Number) }),
    layer: ({ n }) =>
      Layer.effectDiscard(
        Effect.gen(function* () {
          if (n === 13) return yield* Effect.die("unlucky");
          if (n === 2 && held !== undefined) yield* Effect.andThen(Deferred.succeed(held.entered, undefined), Deferred.await(held.gate));
          started.push(n ?? 0);
        }),
      ),
  });
  return { plugin, started };
}

const until = (condition: () => boolean) =>
  Effect.repeat(Effect.sync(condition), { until: (done) => done, schedule: Schedule.spaced(Duration.millis(2)) }).pipe(Effect.timeout(Duration.seconds(5)));

/**
 * The host's changes over a loader, as main.ts makes them, with the user config file in memory (`disk`) and the plugins
 * given: a read plans its rows. `reading` runs before each read; `restoreFails` makes putting the file back fail.
 */
const start = (
  plugins: readonly Plugin[],
  rows: Readonly<Record<string, PluginRow>> = {},
  options: {
    readonly reading?: Effect.Effect<void>;
    readonly trace?: { readonly spans: ReturnType<typeof makeSpanCollector>; readonly changes: ReturnType<typeof compositionHistory> };
    readonly deferral?: ChangesOptions["deferral"];
  } = {},
) =>
  Effect.gen(function* () {
    const disk = new Map<string, string>([[paths.userConfig, JSON.stringify({ plugins: rows })]]);
    const said: Diagnostic[] = [];
    const io = { restoreFails: false };
    const trace = options.trace ?? { spans: makeSpanCollector(), changes: compositionHistory() };
    const faults = faultHistory();
    const host = yield* makeHostChanges({
      paths,
      read: Effect.gen(function* () {
        yield* options.reading ?? Effect.void;
        const text = disk.get(paths.userConfig);
        const fileRows: Record<string, PluginRow> = text === undefined ? {} : (parseJsonc(text)?.plugins ?? {});
        const planned = planComposition({ bundled: plugins, local: [], rows: fileRows, provided: runtimeCapabilities });
        return {
          ...planned,
          enabledIn: {},
          configIn: {},
          trusted: true,
          web: { plugins: fileRows, enabledIn: {}, configIn: {}, files: [] },
          webIds: [],
          code: [],
        };
      }),
      readConfig: (path) => Effect.sync(() => disk.get(path)),
      updateConfig: (path, change, scope) =>
        Effect.sync(() => {
          const previous = disk.get(path);
          const text = patchConfig(previous ?? "", change, scope);
          disk.set(path, text);
          return {
            text,
            previous,
            restore: Effect.suspend(() => {
              if (io.restoreFails) return Effect.fail(new Diagnostic({ severity: "error", message: `${path}: cannot put the config back` }));
              if (previous === undefined) disk.delete(path);
              else disk.set(path, previous);
              return Effect.void;
            }),
          };
        }),
      webFiles: () => Effect.succeed([]),
      pinned: {},
      safe: false,
      process: { pid: process.pid, startedAt: 0 },
      changes: trace.changes,
      faults,
      log: () => Effect.void,
      printDiagnostics: (diagnostics) => Effect.sync(() => void said.push(...diagnostics)),
      ...(options.deferral === undefined ? {} : { deferral: options.deferral }),
    });
    const loader = yield* makeLoader({
      source: host.source,
      composition: host.applied().resolved.composition,
      provide: hostRuntime({ paths, control: host.handle, trace }),
    });
    yield* host.bind(loader);
    // A change drains in-flight core.run work before swapping, so the handle is used outside core.run, as the app does.
    const control = yield* loader.core.run(HostControl);
    return { loader, control, host, disk, said, io, faults, changes: trace.changes };
  });

/** The rows of the user config file held in `disk`. */
const rowsIn = (disk: ReadonlyMap<string, string>) => parseJsonc(disk.get(paths.userConfig) ?? "{}")?.plugins;

describe("host runtime", () => {
  test("provides the paths, the host API version, and the keys of what it provides", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const quiet = definePlugin({ id: "quiet", layer: Layer.empty });
          const { loader, control } = yield* start([quiet]);
          expect(yield* loader.core.run(Paths)).toEqual(paths);
          expect(yield* loader.core.run(HostApi(HOST_API))).toBe(HOST_API);
          const keys = ["lemma/Paths", "lemma/HostControl", "lemma/Interaction", "lemma/Trace", `lemma/api@${HOST_API}`];
          expect(control.runtime).toEqual(keys);
          expect((yield* loader.core.inspect).provided).toEqual(keys);
          expect((yield* control.composition).plugins).toEqual([{ id: "quiet" }]);
        }),
      ),
    );
  });

  test("traces the host's work for a plugin to read: the spans kept, those that end from now on, and the changes", async () => {
    const trace = { spans: makeSpanCollector(), changes: compositionHistory() };
    trace.changes.applied("start", { started: ["quiet"] }, undefined, 1);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const quiet = definePlugin({ id: "quiet", layer: Layer.empty });
          const { loader } = yield* start([quiet], {}, { trace });
          const reader = yield* loader.core.run(Trace);
          // Activation ran under the collector: the host's program is traced with it.
          expect((yield* reader.spans).some((span) => span.name === "core.activate" && span.attributes["plugin.id"] === "quiet")).toBe(true);
          // Spans end until the reader, once subscribed, hears one.
          const heard = yield* Stream.runHead(Stream.flatMap(reader.ended, Stream.fromIterable)).pipe(
            Effect.raceFirst(Effect.forever(Effect.andThen(Effect.void.pipe(Effect.withSpan("later")), Effect.yieldNow))),
          );
          expect(heard).toMatchObject({ value: { name: "later" } });
          expect(yield* reader.changes).toEqual([{ at: 1, cause: "start", started: ["quiet"], stopped: [], restarted: [], failed: [] }]);
        }),
      ).pipe(Effect.withTracer(trace.spans.tracer)),
    );
  });

  test("publishes PluginsChanged after a reload, a configure, and a restart", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const heard = recorder();
          const counted = numbered("counted");
          const { control, disk } = yield* start([heard.plugin, counted.plugin]);
          const report = yield* control.reload;
          expect([...report.unchanged].sort()).toEqual(["counted", "recorder"]);
          yield* until(() => heard.changes.length === 1);
          const configured = yield* control.configure({ counted: { config: { n: 1 } } });
          expect(configured.restarted).toEqual(["counted"]);
          expect(rowsIn(disk)).toEqual({ counted: { config: { n: 1 } } });
          expect(counted.started).toEqual([0, 1]);
          yield* until(() => heard.changes.length === 2);
          // A restart that fails still publishes: it can leave dependents failed.
          expect((yield* Effect.flip(control.restart("missing")))._tag).toBe("ReloadError");
          yield* until(() => heard.changes.length === 3);
          expect(heard.changes.map((plugins) => plugins.map((plugin) => [plugin.id, plugin.state]))).toEqual(
            Array.from({ length: 3 }, () => [
              ["recorder", "active"],
              ["counted", "active"],
            ]),
          );
        }),
      ),
    );
  });

  test("a change runs to its end, and publishes, though its caller stops waiting", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const heard = recorder();
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          let reads = 0;
          // The first read is the start's; the reload's waits.
          const reading = Effect.suspend(() => (reads++ === 0 ? Effect.void : Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(gate))));
          const { control } = yield* start([heard.plugin], {}, { reading });
          // Interrupted midway, as a stream is when the reload it asked for restarts its plugin.
          const caller = yield* Effect.forkScoped(control.reload);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(caller);
          yield* Deferred.succeed(gate, undefined);
          yield* until(() => heard.changes.length === 1);
        }),
      ),
    );
  });

  test("a plugin asking for the composition while it activates has it once the loader exists", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen = yield* Deferred.make<CompositionInfo>();
          // As the agent does for a turn to resume: from work it starts while activating.
          const early = definePlugin({
            id: "early",
            requires: { control: HostControl },
            setup: function* ({ control }, owner) {
              yield* owner.background(
                "composition",
                Effect.flatMap(control.composition, (info) => Deferred.succeed(seen, info)),
              );
            },
          });
          yield* start([early]);
          expect((yield* Deferred.await(seen)).plugins).toEqual([{ id: "early" }]);
        }),
      ),
    );
  });

  test("reports a fault as a Notice from its plugin and PluginsChanged, recording it first", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const heard = recorder();
          const { loader, faults } = yield* start([heard.plugin, flaky], { flaky: { enabled: false } });
          // Forked as main.ts forks it, it has subscribed by the time the fork returns: flaky's first fault is heard.
          yield* Effect.forkScoped(reportFaults(loader, faults), { startImmediately: true });
          // Applied directly, not through HostControl, so what is published comes from the fault.
          yield* loader.apply({ plugins: { recorder: {}, flaky: {} } });
          yield* until(() => heard.notices.length > 0);
          const [notice] = heard.notices;
          expect(notice).toMatchObject({ level: "error", source: "flaky" });
          expect(notice?.message).toContain("boom");
          yield* until(() => heard.changes.length > 0);
          // The list published after the Notice already has the fault in its history.
          expect(heard.changes[0]?.find((plugin) => plugin.id === "flaky")?.faults?.length).toBeGreaterThan(0);
          expect(faults.get().get("flaky")?.length).toBeGreaterThan(0);
        }),
      ),
    );
  });
});

describe("host changes", () => {
  test("a reload that would leave out a plugin not left out already is refused; one already left out blocks nothing", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const left = numbered("left");
          const kept = numbered("kept");
          // `left`'s config does not decode, so it is left out from the start, with a warning.
          const { control, disk, host, said } = yield* start([left.plugin, kept.plugin], { left: { config: { n: "x" } } });
          expect(host.applied().problems.has("left")).toBe(true);
          expect(said.some((diagnostic) => diagnostic.pluginId === "left" && diagnostic.severity === "warning")).toBe(true);
          expect((yield* control.reload).unchanged).toEqual(["kept"]);
          // Breaking `kept` too would leave it out: refused, with why, and it keeps running.
          disk.set(paths.userConfig, JSON.stringify({ plugins: { left: { config: { n: "x" } }, kept: { config: { n: "y" } } } }));
          const refused = yield* Effect.flip(control.reload);
          expect(refused.diagnostics.map((diagnostic) => [diagnostic.pluginId, diagnostic.message.split(":")[0]])).toEqual([["kept", `"kept" cannot run`]]);
          expect(kept.started).toEqual([0]);
          expect(host.applied().problems.has("kept")).toBe(false);
        }),
      ),
    );
  });

  test("a load is the applied one only once the loader accepts it", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const held = { entered: yield* Deferred.make<void>(), gate: yield* Deferred.make<void>() };
          const slow = numbered("slow", held);
          const { control, host } = yield* start([slow.plugin]);
          // Starting with n: 2 waits on the gate: meanwhile the catalog and the web rows are still the running load's.
          const configuring = yield* Effect.forkScoped(control.configure({ slow: { config: { n: 2 } } }));
          yield* Deferred.await(held.entered);
          expect((yield* control.web).plugins).toEqual({});
          expect(host.applied().composition.plugins.slow?.config).toBeUndefined();
          yield* Deferred.succeed(held.gate, undefined);
          yield* Fiber.join(configuring);
          expect((yield* control.web).plugins).toEqual({ slow: { config: { n: 2 } } });
          // A load the loader refuses never becomes the applied one.
          const refused = yield* Effect.flip(control.configure({ slow: { config: { n: 13 } } }));
          expect(refused.diagnostics[0]?.message).toContain("unlucky");
          expect((yield* control.web).plugins).toEqual({ slow: { config: { n: 2 } } });
        }),
      ),
    );
  });

  test("the host's own write is no change on disk, its undo neither; a hand edit is", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const counted = numbered("counted");
          const { control, disk, host, changes } = yield* start([counted.plugin]);
          yield* control.configure({ counted: { config: { n: 1 } } });
          const recorded = changes.get().length;
          yield* host.configChanged;
          expect(changes.get()).toHaveLength(recorded);
          // A configure the host refuses is put back, and that is no change either.
          yield* Effect.flip(control.configure({ counted: { config: { n: 13 } } }));
          expect(rowsIn(disk)).toEqual({ counted: { config: { n: 1 } } });
          yield* host.configChanged;
          expect(changes.get()).toHaveLength(recorded + 1);
          disk.set(paths.userConfig, JSON.stringify({ plugins: { counted: { config: { n: 3 } } } }));
          yield* host.configChanged;
          expect(changes.get()[0]).toMatchObject({ cause: "reload", restarted: ["counted"] });
          expect(counted.started).toEqual([0, 1, 3]);
        }),
      ),
    );
  });

  test("a refused configure whose file cannot be put back says so, and the file is not taken for put back", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const counted = numbered("counted");
          const { control, disk, host, io, said, changes } = yield* start([counted.plugin]);
          io.restoreFails = true;
          const refused = yield* Effect.flip(control.configure({ counted: { config: { n: 13 } } }));
          expect(refused.diagnostics.map((diagnostic) => diagnostic.message)).toContainEqual(`${paths.userConfig}: cannot put the config back`);
          expect(said.some((diagnostic) => diagnostic.message.includes("cannot put the config back"))).toBe(true);
          expect(rowsIn(disk)).toEqual({ counted: { config: { n: 13 } } });
          // What the host remembers of the file is what it holds: still the change, so no reload of it is taken for new.
          const recorded = changes.get().length;
          yield* host.configChanged;
          expect(changes.get()).toHaveLength(recorded);
        }),
      ),
    );
  });

  test("a change restarting the work that asks for it is checked, answered deferred, and applied once that work ends", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const heard = recorder();
          const counted = numbered("counted");
          const over = yield* Deferred.make<void>();
          const asked: (readonly string[])[] = [];
          // As if the work asking were `counted`'s: whatever restarts it waits for `over`.
          const deferral: ChangesOptions["deferral"] = (restarts) =>
            Effect.sync(() => {
              asked.push([...restarts].sort());
              return restarts.has("counted") ? Deferred.await(over) : undefined;
            });
          const { control, disk } = yield* start([heard.plugin, counted.plugin], {}, { deferral });
          // A config the loader would refuse is refused at once, and the file put back.
          const invalid = yield* Effect.flip(control.configure({ counted: { config: { n: "x" as unknown as number } } }));
          expect(invalid.diagnostics[0]?.pluginId).toBe("counted");
          expect(rowsIn(disk)).toEqual({});
          const report = yield* control.configure({ counted: { config: { n: 1 } } });
          expect(report.deferred).toBe(true);
          // What it restarts is the loader's answer.
          expect(asked.at(-1)).toEqual(["counted"]);
          expect(rowsIn(disk)).toEqual({ counted: { config: { n: 1 } } });
          expect(counted.started).toEqual([0]);
          yield* Deferred.succeed(over, undefined);
          yield* until(() => counted.started.length === 2);
          // One that fails once applied is put back in the file, and clients hear why.
          const failing = yield* control.configure({ counted: { config: { n: 13 } } });
          expect(failing.deferred).toBe(true);
          yield* until(() => heard.notices.length === 1);
          expect(heard.notices[0]?.message).toMatch(/^The config change could not be applied: .*unlucky.*; \/home\/me\/.* was put back$/s);
          expect(rowsIn(disk)).toEqual({ counted: { config: { n: 1 } } });
        }),
      ),
    );
  });

  test("a restart does not wait for a change under way, whose lock its plugin's work may be waiting on", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const counted = numbered("counted");
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          let reads = 0;
          const reading = Effect.suspend(() => (reads++ === 0 ? Effect.void : Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(gate))));
          const { control, disk } = yield* start([counted.plugin], {}, { reading });
          // The reload, once it has read the file, restarts `counted` with 5; until then it holds the change lock.
          disk.set(paths.userConfig, JSON.stringify({ plugins: { counted: { config: { n: 5 } } } }));
          const reloading = yield* Effect.forkScoped(control.reload);
          yield* Deferred.await(entered);
          // Were `counted`'s own work waiting on that lock, a restart taking it would wait on its own disposal.
          yield* control.restart("counted", { force: true });
          expect(counted.started).toEqual([0, 0]);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(reloading);
          expect(counted.started).toEqual([0, 0, 5]);
        }),
      ),
    );
  });
});
