import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Layer, Schedule } from "effect";
import { HOST_API, HostApi, HostControl, Notice, Paths, PluginsChanged } from "@lemma/contracts";
import type { CompositionInfo, NoticePayload, PluginInfo, UiComposition } from "@lemma/contracts";
import { definePlugin, Diagnostic, makeLoader, PluginContext } from "@lemma/core";
import type { Composition, Loader, Plugin, PluginSource } from "@lemma/core";
import { faultHistory } from "@lemma/composition";
import { compositionInfo } from "../src/composition.ts";
import { resolvePaths } from "../src/paths.ts";
import { hostRuntime, reportFaults } from "../src/runtime.ts";
import type { HostControlHandle } from "../src/runtime.ts";

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

const until = (condition: () => boolean) =>
  Effect.repeat(Effect.sync(condition), { until: (done) => done, schedule: Schedule.spaced(Duration.millis(2)) }).pipe(Effect.timeout(Duration.seconds(5)));

/** Mirrors main.ts: the runtime is built inside makeLoader, so the handle binds to the loader through a Deferred. */
const start = (plugins: readonly Plugin[], composition: Composition) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Loader>();
    const withLoader = <A, E>(f: (loader: Loader) => Effect.Effect<A, E>) => Effect.flatMap(Deferred.await(ready), f);
    const history = faultHistory();
    const configured: Record<string, unknown>[] = [];
    let ui: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
    const handle: HostControlHandle = {
      // Each plugin with its recorded faults, as the catalog lists them.
      plugins: withLoader((loader) =>
        Effect.map(loader.core.inspect, (snapshot) =>
          snapshot.plugins.map((plugin) => ({ ...plugin, source: "bundled" as const, enabled: true, faults: history.get().get(plugin.id) ?? [] })),
        ),
      ),
      composition: withLoader((loader) =>
        Effect.zipWith(loader.composition, loader.core.inspect, (composition, snapshot) => compositionInfo(composition, snapshot.plugins)),
      ),
      restart: (id, options) => withLoader((loader) => loader.core.restart(id, options)),
      reload: withLoader((loader) => loader.apply(composition)),
      configure: (rows) =>
        withLoader((loader) => {
          configured.push(rows);
          return loader.apply(composition);
        }),
      ui: Effect.sync(() => ui),
      configureUi: (rows) =>
        Effect.sync(() => {
          ui = { ...ui, plugins: { ...ui.plugins, ...rows } };
          return ui;
        }),
    };
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const source: PluginSource = {
      resolve: (id) => {
        const plugin = byId.get(id);
        return plugin ? Effect.succeed(plugin) : Effect.fail(new Diagnostic({ severity: "error", message: `No plugin "${id}"` }));
      },
    };
    const loader = yield* makeLoader({ source, composition, provide: hostRuntime({ paths, control: handle }) });
    yield* Deferred.succeed(ready, loader);
    // A change drains in-flight core.run work before swapping, so the handle is used outside core.run, as the app does.
    const control = yield* loader.core.run(HostControl);
    return { loader, control, history, configured };
  });

describe("host runtime", () => {
  test("provides the paths, the host API version, and the keys of what it provides", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const quiet = definePlugin({ id: "quiet", layer: Layer.empty });
          const { loader, control } = yield* start([quiet], { plugins: { quiet: {} } });
          expect(yield* loader.core.run(Paths)).toEqual(paths);
          expect(yield* loader.core.run(HostApi(HOST_API))).toBe(HOST_API);
          const keys = ["lemma/Paths", "lemma/HostControl", "lemma/Interaction", `lemma/api@${HOST_API}`];
          expect(control.runtime).toEqual(keys);
          expect((yield* loader.core.inspect).provided).toEqual(keys);
          expect((yield* control.composition).plugins).toEqual([{ id: "quiet" }]);
        }),
      ),
    );
  });

  test("publishes PluginsChanged after a reload, a configure, and a restart", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const heard = recorder();
          const { control, configured } = yield* start([heard.plugin], { plugins: { recorder: {} } });
          const report = yield* control.reload;
          expect(report.unchanged).toEqual(["recorder"]);
          yield* until(() => heard.changes.length === 1);
          yield* control.configure({ flaky: { enabled: false } }, { scope: "project" });
          expect(configured).toEqual([{ flaky: { enabled: false } }]);
          yield* until(() => heard.changes.length === 2);
          // A restart that fails still publishes: it can leave dependents failed.
          expect((yield* Effect.flip(control.restart("missing")))._tag).toBe("ReloadError");
          yield* until(() => heard.changes.length === 3);
          expect(heard.changes.map((plugins) => plugins.map((plugin) => [plugin.id, plugin.state]))).toEqual([
            [["recorder", "active"]],
            [["recorder", "active"]],
            [["recorder", "active"]],
          ]);
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
          yield* start([early], { plugins: { early: {} } });
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
          const { loader, history } = yield* start([heard.plugin, flaky], { plugins: { recorder: {} } });
          // Forked as main.ts forks it, it has subscribed by the time the fork returns: flaky's first fault is heard.
          yield* Effect.forkScoped(reportFaults(loader, history), { startImmediately: true });
          // Applied directly, not through HostControl, so what is published comes from the fault.
          yield* loader.apply({ plugins: { recorder: {}, flaky: {} } });
          yield* until(() => heard.notices.length > 0);
          const [notice] = heard.notices;
          expect(notice).toMatchObject({ level: "error", source: "flaky" });
          expect(notice?.message).toContain("boom");
          yield* until(() => heard.changes.length > 0);
          // The list published after the Notice already has the fault in its history.
          expect(heard.changes[0]?.find((plugin) => plugin.id === "flaky")?.faults?.length).toBeGreaterThan(0);
          expect(history.get().get("flaky")?.length).toBeGreaterThan(0);
        }),
      ),
    );
  });
});
