import { describe, expect, test } from "vitest";
import { Context, Deferred, Duration, Effect, Exit, Layer, Schema, Scope } from "effect";
import { checkComposition, definePlugin, Diagnostic, Hook, Hooks, makeLoader, PluginContext } from "../src/index.ts";
import type { Composition, Plugin, PluginSource } from "../src/index.ts";
import { run, waitFor } from "./support.ts";

class Db extends Context.Tag("test/Db")<Db, { readonly name: string; readonly generation: number }>() {}
class Api extends Context.Tag("test/Api")<Api, () => string>() {}
const Greet = Hook.make<string, string>("test/greet");

function fixtures(log: string[]) {
  let generation = 0;
  const db = definePlugin({
    id: "db",
    provides: [Db],
    config: Schema.Struct({ name: Schema.String }),
    layer: (config) =>
      Layer.scoped(
        Db,
        Effect.gen(function* () {
          const self = { name: config.name, generation: ++generation };
          log.push(`db+${self.generation}`);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              log.push(`db-${self.generation}`);
            }),
          );
          return self;
        }),
      ),
  });
  const api = definePlugin({
    id: "api",
    requires: [Db],
    provides: [Api],
    layer: Layer.scoped(
      Api,
      Effect.gen(function* () {
        const db = yield* Db;
        log.push(`api+${db.generation}`);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            log.push(`api-${db.generation}`);
          }),
        );
        return () => `${db.name}#${db.generation}`;
      }),
    ),
  });
  const greeter = definePlugin({
    id: "greeter",
    config: Schema.Struct({ suffix: Schema.String }),
    layer: (config) =>
      Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(Greet, (input, next) => Effect.map(next(input), (out) => out + config.suffix)))),
  });
  const bystander = definePlugin({
    id: "bystander",
    layer: Layer.scopedDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push("bystander+");
        }),
        () =>
          Effect.sync(() => {
            log.push("bystander-");
          }),
      ),
    ),
  });
  const broken = definePlugin({ id: "broken", requires: [Db], layer: Layer.effectDiscard(Effect.fail("cannot start")) });
  const all: Record<string, Plugin> = { db, api, greeter, bystander, broken };
  const source: PluginSource = {
    resolve: (id) =>
      all[id]
        ? Effect.succeed(all[id])
        : Effect.fail(new Diagnostic({ severity: "error", message: `Unknown plugin "${id}"`, suggestion: "Install it or remove it from the composition" })),
  };
  return { source, all };
}

const composition = (plugins: Composition["plugins"]): Composition => ({ plugins });

describe("loader", () => {
  test("applies only the affected subgraph and reports the change", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { source } = fixtures(log);
        const loader = yield* makeLoader({ source, composition: composition({ db: { config: { name: "main" } }, api: {}, bystander: {} }) });
        expect(log).toEqual(["db+1", "api+1", "bystander+"]);
        expect(yield* loader.core.run(Effect.map(Api, (api) => api()))).toBe("main#1");

        // Config change restarts db and its dependent api; the bystander is untouched.
        const report = yield* loader.apply(composition({ db: { config: { name: "replica" } }, api: {}, bystander: {} }));
        expect(report).toMatchObject({ restarted: ["db", "api"], started: [], stopped: [], unchanged: ["bystander"], interrupted: 0, faults: [] });
        expect(log).toEqual(["db+1", "api+1", "bystander+", "db+2", "api+2", "api-1", "db-1"]);
        expect(yield* loader.core.run(Effect.map(Api, (api) => api()))).toBe("replica#2");
        expect((yield* loader.composition).plugins.db?.config).toEqual({ name: "replica" });

        // Identical composition: nothing happens.
        const noop = yield* loader.apply(composition({ db: { config: { name: "replica" } }, api: {}, bystander: {} }));
        expect(noop).toMatchObject({ restarted: [], started: [], stopped: [], unchanged: ["db", "api", "bystander"] });
        expect(log).toHaveLength(7);

        // Add and remove.
        const changed = yield* loader.apply(composition({ db: { config: { name: "replica" } }, api: {}, greeter: { config: { suffix: "!" } } }));
        expect(changed).toMatchObject({ started: ["greeter"], stopped: ["bystander"], restarted: [] });
        expect(log.slice(7)).toEqual(["bystander-"]);
        expect(yield* loader.core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Greet, "hi", Effect.succeed)))).toBe("hi!");
        // Disabled rows are not loaded.
        const disabled = yield* loader.apply(
          composition({ db: { config: { name: "replica" } }, api: {}, greeter: { enabled: false, config: { suffix: "!" } } }),
        );
        expect(disabled.stopped).toEqual(["greeter"]);
        expect(yield* loader.core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Greet, "hi", Effect.succeed)))).toBe("hi");
      }),
    );
  });

  test("reports every planning problem at once and leaves the running composition untouched", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { source } = fixtures(log);
        const loader = yield* makeLoader({ source, composition: composition({ db: { config: { name: "main" } }, api: {} }) });
        const error = yield* Effect.flip(loader.apply(composition({ db: { config: { name: 5 } }, api: {}, missing: {}, broken: {} })));
        expect(error.diagnostics.map((d) => [d.pluginId, d.severity])).toEqual([["missing", "error"]]);
        // Source problems are reported before planning; planning then reports all of its own.
        const planning = yield* Effect.flip(loader.apply(composition({ db: { config: { name: 5 } }, api: {}, greeter: {} })));
        expect(planning.diagnostics.map((d) => d.pluginId).sort()).toEqual(["db", "greeter"]);
        expect(planning.diagnostics.find((d) => d.pluginId === "db")?.path).toEqual(["name"]);
        expect(planning.diagnostics.every((d) => d.suggestion)).toBe(true);
        expect(log).toEqual(["db+1", "api+1"]);
        expect(yield* loader.core.run(Effect.map(Api, (api) => api()))).toBe("main#1");
      }),
    );
  });

  test("a replacement that fails to start is rolled back and the old instances keep serving", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { source } = fixtures(log);
        const loader = yield* makeLoader({ source, composition: composition({ db: { config: { name: "main" } }, api: {} }) });
        const error = yield* Effect.flip(loader.apply(composition({ db: { config: { name: "next" } }, api: {}, broken: {} })));
        expect(error.diagnostics).toHaveLength(1);
        expect(error.diagnostics[0]).toMatchObject({ pluginId: "broken" });
        expect(error.diagnostics[0]?.message).toContain("cannot start");
        // db#2 was staged and then discarded; db#1 and api#1 never stopped.
        expect(log).toEqual(["db+1", "api+1", "db+2", "api+2", "api-2", "db-2"]);
        expect(yield* loader.core.run(Effect.map(Api, (api) => api()))).toBe("main#1");
        expect((yield* loader.core.inspect).plugins.map((p) => [p.id, p.state])).toEqual([
          ["db", "active"],
          ["api", "active"],
        ]);
      }),
    );
  });

  test("in-flight work finishes on the composition it entered, then the old instances close", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { source } = fixtures(log);
        const loader = yield* makeLoader({ source, composition: composition({ db: { config: { name: "main" } }, api: {} }) });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const slow = yield* Effect.fork(
          loader.core.run(
            Effect.gen(function* () {
              const api = yield* Api;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return api();
            }),
          ),
        );
        yield* Deferred.await(entered);
        const reload = yield* Effect.fork(loader.apply(composition({ db: { config: { name: "next" } }, api: {} })));
        // The swap happens for new callers while the old work is still running.
        yield* waitFor(loader.core.run(Effect.map(Api, (api) => api())), (value) => value === "next#2");
        expect(log).toEqual(["db+1", "api+1", "db+2", "api+2"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* slow.await.pipe(Effect.map((exit) => Exit.isSuccess(exit) && exit.value))).toBe("main#1");
        const report = yield* reload.await.pipe(Effect.flatten);
        expect(report.interrupted).toBe(0);
        expect(log).toEqual(["db+1", "api+1", "db+2", "api+2", "api-1", "db-1"]);
      }),
    );
  });

  test("stale work that outlives the drain deadline is interrupted and counted", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { source } = fixtures(log);
        const loader = yield* makeLoader({
          source,
          composition: composition({ db: { config: { name: "main" } }, api: {} }),
          deadlines: { dispose: Duration.millis(30) },
        });
        const entered = yield* Deferred.make<void>();
        let interrupted = false;
        const stuck = yield* Effect.fork(
          loader.core.run(
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
          ),
        );
        yield* Deferred.await(entered);
        const report = yield* loader.apply(composition({ db: { config: { name: "next" } }, api: {} }));
        expect(report.interrupted).toBe(1);
        expect(interrupted).toBe(true);
        expect(Exit.isInterrupted(yield* stuck.await)).toBe(true);
      }),
    );
  });

  test("exclusive plugins stop before their replacement starts", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        let generation = 0;
        const port = definePlugin({
          id: "port",
          provides: [Db],
          exclusive: true,
          config: Schema.Struct({ name: Schema.String }),
          layer: (config) =>
            Layer.scoped(
              Db,
              Effect.gen(function* () {
                const self = { name: config.name, generation: ++generation };
                log.push(`port+${self.generation}`);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    log.push(`port-${self.generation}`);
                  }),
                );
                return self;
              }),
            ),
        });
        const { all } = fixtures(log);
        const source: PluginSource = { resolve: (id) => Effect.succeed(id === "port" ? port : all[id]!) };
        const loader = yield* makeLoader({ source, composition: composition({ port: { config: { name: "a" } }, api: {} }) });
        yield* loader.apply(composition({ port: { config: { name: "b" } }, api: {} }));
        expect(log).toEqual(["port+1", "api+1", "api-1", "port-1", "port+2", "api+2"]);
      }),
    );
  });

  test("exclusive contributors replace unique registrations in a retained registry", async () => {
    class Registry extends Context.Tag("test/Registry")<
      Registry,
      {
        readonly entries: ReadonlyMap<string, string>;
        readonly register: (name: string, value: string) => Effect.Effect<void, Error, Scope.Scope>;
      }
    >() {}
    const entries = new Map<string, string>();
    const registrations: string[] = [];
    let activations = 0;
    const registry = definePlugin({
      id: "registry",
      provides: [Registry],
      layer: Layer.sync(Registry, () => {
        activations++;
        return {
          entries,
          register: (name, value) =>
            Effect.acquireRelease(
              Effect.try(() => {
                if (entries.has(name)) throw new Error(`Duplicate registration: ${name}`);
                entries.set(name, value);
                registrations.push(`+${value}`);
              }),
              () =>
                Effect.sync(() => {
                  entries.delete(name);
                  registrations.push(`-${value}`);
                }),
            ),
        };
      }),
    });
    const contributor = definePlugin({
      id: "contributor",
      requires: [Registry],
      exclusive: true,
      config: Schema.Struct({ value: Schema.String }),
      layer: ({ value }) => Layer.scopedDiscard(Effect.flatMap(Registry, (registry) => registry.register("shared-name", value))),
    });
    await run(
      Effect.gen(function* () {
        const next = (value: string) => composition({ registry: {}, contributor: { config: { value } } });
        const loader = yield* makeLoader({
          source: { resolve: (id) => Effect.succeed(id === "registry" ? registry : contributor) },
          composition: next("first"),
        });
        const original = yield* loader.core.run(Registry);
        expect([...original.entries]).toEqual([["shared-name", "first"]]);
        const report = yield* loader.apply(next("second"));
        expect(report).toMatchObject({ restarted: ["contributor"], unchanged: ["registry"], faults: [] });
        expect(yield* loader.core.run(Registry)).toBe(original);
        expect([...original.entries]).toEqual([["shared-name", "second"]]);
        expect(activations).toBe(1);
        expect(registrations).toEqual(["+first", "-first", "+second"]);
      }),
    );
    expect(entries.size).toBe(0);
    expect(registrations).toEqual(["+first", "-first", "+second", "-second"]);
  });

  test("an initial composition that cannot start leaves nothing behind", async () => {
    const log: string[] = [];
    const { source } = fixtures(log);
    const scope = await Effect.runPromise(Scope.make());
    const error = await Effect.runPromise(
      Effect.flip(Scope.extend(makeLoader({ source, composition: composition({ db: { config: { name: "main" } }, broken: {} }) }), scope)),
    );
    expect(error.diagnostics[0]?.pluginId).toBe("broken");
    expect(log).toEqual(["db+1", "db-1"]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  test("checkComposition finds what planning would refuse, without running anything", () => {
    const log: string[] = [];
    const { all } = fixtures(log);
    expect(checkComposition([all.db!, all.api!], { db: { name: "main" } })).toEqual([]);
    const errors = checkComposition([all.db!, all.api!, all.broken!, all.greeter!], { db: { name: 5 } });
    expect(errors.map((error) => [error.reason, error.plugins[0]])).toEqual([
      ["InvalidConfig", "db"],
      ["InvalidConfig", "greeter"],
    ]);
    expect(checkComposition([all.api!]).map((error) => error.reason)).toEqual(["MissingCapability"]);
    expect(log).toEqual([]);
  });

  test("a partial start leaves a plugin that cannot start failed, halts its dependents, and runs the rest", async () => {
    class Flaky extends Context.Tag("test/Flaky")<Flaky, string>() {}
    let attempts = 0;
    const flaky = definePlugin({
      id: "flaky",
      provides: [Flaky],
      layer: Layer.effect(
        Flaky,
        Effect.suspend(() => (++attempts === 1 ? Effect.fail("not yet") : Effect.succeed("ready"))),
      ),
    });
    const user = definePlugin({ id: "user", requires: [Flaky], layer: Layer.empty });
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { all } = fixtures(log);
        const plugins: Record<string, Plugin> = { ...all, flaky, user };
        const loader = yield* makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins[id]!) },
          composition: composition({ db: { config: { name: "main" } }, api: {}, flaky: {}, user: {} }),
          partialStart: { required: ["api"] },
        });
        const states = Object.fromEntries((yield* loader.core.inspect).plugins.map((plugin) => [plugin.id, [plugin.state, plugin.haltedBy]]));
        expect(states).toEqual({ db: ["active", undefined], api: ["active", undefined], flaky: ["failed", undefined], user: ["closed", "flaky"] });
        expect((yield* loader.core.inspect).plugins.find((plugin) => plugin.id === "flaky")?.fault?.phase).toBe("activate");
        expect(yield* loader.core.run(Effect.map(Api, (api) => api()))).toBe("main#1");
        // A plugin left failed at start restarts like any failed plugin, with the dependents it halted.
        yield* loader.core.restart("flaky");
        expect((yield* loader.core.inspect).plugins.map((plugin) => plugin.state)).toEqual(["active", "active", "active", "active"]);
      }),
    );
  });

  test("a partial start still fails when a required plugin, or one it needs, cannot start", async () => {
    for (const required of ["broken", "api"]) {
      const log: string[] = [];
      const { all } = fixtures(log);
      const failingDb = definePlugin({ ...all.db!, id: "db", layer: () => Layer.fail("db is down") as never });
      const plugins: Record<string, Plugin> = { ...all, db: required === "api" ? failingDb : all.db! };
      const scope = await Effect.runPromise(Scope.make());
      const error = await Effect.runPromise(
        Effect.flip(
          Scope.extend(
            makeLoader({
              source: { resolve: (id) => Effect.succeed(plugins[id]!) },
              composition: composition({ db: { config: { name: "main" } }, api: {}, broken: {}, bystander: {} }),
              partialStart: { required: [required] },
            }),
            scope,
          ),
        ),
      );
      expect(error.diagnostics[0]?.pluginId).toBe(required === "api" ? "db" : "broken");
      // Nothing is left running.
      const started = log.filter((entry) => entry.includes("+")).map((entry) => entry.replace("+", ""));
      expect(log.filter((entry) => entry.includes("-")).map((entry) => entry.replace("-", ""))).toEqual(started.reverse());
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
