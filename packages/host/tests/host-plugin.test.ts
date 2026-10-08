import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Schedule, Stream } from "effect";
import { HostControl, Notice, Paths, PluginsChanged } from "@lemma/contracts";
import type { UiComposition } from "@lemma/contracts";
import { definePlugin, Diagnostic, Events, makeLoader, PluginContext } from "@lemma/core";
import type { Loader, Plugin, PluginSource } from "@lemma/core";
import { compositionInfo } from "../src/composition.ts";
import { hostPlugin } from "../src/host-plugin.ts";
import type { HostControlService } from "../src/host-plugin.ts";
import { resolvePaths } from "../src/paths.ts";

const paths = resolvePaths({ env: { HOME: "/home/me" }, cwd: "/work" });

// A required background task that fails produces a real PluginFault.
const flaky = definePlugin({
  id: "flaky",
  layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.background("work", Effect.fail("boom"), { required: true }))),
});

/** Mirrors main.ts: the plugin activates inside makeLoader, so the handle binds to the loader through a Deferred. */
const start = Effect.gen(function* () {
  const ready = yield* Deferred.make<Loader>();
  const configured: Record<string, unknown>[] = [];
  let ui: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
  const handle: HostControlService = {
    plugins: Effect.flatMap(Deferred.await(ready), (loader) =>
      Effect.map(loader.core.inspect, (snapshot) => snapshot.plugins.map((plugin) => ({ ...plugin, source: "bundled" as const, enabled: true }))),
    ),
    composition: Effect.flatMap(Deferred.await(ready), (loader) =>
      Effect.zipWith(loader.composition, loader.core.inspect, (composition, snapshot) => compositionInfo(composition, snapshot.plugins)),
    ),
    restart: (id, options) => Effect.flatMap(Deferred.await(ready), (loader) => loader.core.restart(id, options)),
    reload: Effect.flatMap(Deferred.await(ready), (loader) => loader.apply({ plugins: { host: { config: paths } } })),
    configure: (rows) =>
      Effect.flatMap(Deferred.await(ready), (loader) => {
        configured.push(rows);
        return loader.apply({ plugins: { host: { config: paths } } });
      }),
    ui: Effect.sync(() => ui),
    configureUi: (rows) =>
      Effect.sync(() => {
        ui = { ...ui, plugins: { ...ui.plugins, ...rows } };
        return ui;
      }),
  };
  const host = hostPlugin({ control: handle, faults: Stream.unwrap(Effect.map(Deferred.await(ready), (loader) => loader.core.faults)) });
  const bundled: Record<string, Plugin> = { host, flaky };
  const source: PluginSource = {
    resolve: (id) => (bundled[id] ? Effect.succeed(bundled[id]) : Effect.fail(new Diagnostic({ severity: "error", message: `No plugin "${id}"` }))),
  };
  const loader = yield* makeLoader({ source, composition: { plugins: { host: { config: paths } } } });
  yield* Deferred.succeed(ready, loader);
  // Reload drains in-flight core.run work before swapping, so the handle is used outside core.run, as the app does.
  const control = yield* loader.core.run(HostControl);
  const events = yield* loader.core.run(Events);
  return { loader, control, events, configured };
});

describe("host plugin", () => {
  test("provides Paths from config and publishes PluginsChanged after a reload and a configure", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { loader, control, events, configured } = yield* start;
          expect(yield* loader.core.run(Paths)).toEqual(paths);
          expect((yield* control.composition).plugins).toEqual([{ id: "host", version: "0.1.0" }]);
          const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(PluginsChanged), 2)));
          const report = yield* control.reload;
          expect(report.unchanged).toEqual(["host"]);
          yield* control.configure({ flaky: { enabled: false } }, { scope: "project" });
          expect(configured).toEqual([{ flaky: { enabled: false } }]);
          const published = [...(yield* Fiber.join(changes))];
          expect(published.map((change) => change.plugins.map((plugin) => [plugin.id, plugin.state, plugin.enabled]))).toEqual([
            [["host", "active", true]],
            [["host", "active", true]],
          ]);
        }),
      ),
    );
  });

  test("publishes PluginsChanged and a Notice when a plugin faults, and after a restart", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { loader, control, events } = yield* start;
          const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(PluginsChanged), 1)));
          const notices = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(Notice), 1)));
          // Applied directly, not through HostControl, so the only publication comes from the fault.
          yield* loader.apply({ plugins: { host: { config: paths }, flaky: {} } });
          expect([...(yield* Fiber.join(changes))]).toHaveLength(1);
          const [notice] = [...(yield* Fiber.join(notices))];
          expect(notice).toMatchObject({ level: "error", source: "flaky" });
          expect(notice?.message).toContain("boom");
          // The core fails the plugin on its supervisor fiber, shortly after reporting the fault.
          const flakyState = Effect.map(loader.core.inspect, (snapshot) => snapshot.plugins.find((plugin) => plugin.id === "flaky")?.state);
          yield* Effect.repeat(flakyState, { until: (state) => state === "failed", schedule: Schedule.spaced(Duration.millis(2)) }).pipe(
            Effect.timeout(Duration.seconds(5)),
          );

          const afterRestart = yield* Effect.forkChild(Stream.runCollect(Stream.take(events.stream(PluginsChanged), 1)));
          // Activation succeeds and the task fails again afterwards; PluginsChanged is published either way.
          yield* control.restart("flaky");
          expect([...(yield* Fiber.join(afterRestart))]).toHaveLength(1);
        }),
      ),
    );
  });
});
