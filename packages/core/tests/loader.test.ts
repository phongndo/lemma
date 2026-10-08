import { describe, expect, test } from "vitest";
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { checkComposition, definePlugin, Diagnostic, Hook, Hooks, makeLoader, PluginContext } from "../src/index.ts";
import type { Composition, LoaderOptions, Plugin, PluginSource } from "../src/index.ts";
import { run, waitFor } from "./support.ts";

class Db extends Context.Service<Db, { readonly name: string; readonly generation: number }>()("test/Db") {}
class Api extends Context.Service<Api, () => string>()("test/Api") {}
const Greet = Hook.make<string, string>("test/greet");

function fixtures(log: string[]) {
  let generation = 0;
  const db = definePlugin({
    id: "db",
    provides: [Db],
    config: Schema.Struct({ name: Schema.String }),
    layer: (config) =>
      Layer.effect(
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
    layer: Layer.effect(
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
    layer: Layer.effectDiscard(
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
        const slow = yield* Effect.forkChild(
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
        const reload = yield* Effect.forkChild(loader.apply(composition({ db: { config: { name: "next" } }, api: {} })));
        // The swap happens for new callers while the old work is still running.
        yield* waitFor(loader.core.run(Effect.map(Api, (api) => api())), (value) => value === "next#2");
        expect(log).toEqual(["db+1", "api+1", "db+2", "api+2"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.await(slow).pipe(Effect.map((exit) => Exit.isSuccess(exit) && exit.value))).toBe("main#1");
        const report = yield* Fiber.await(reload).pipe(Effect.flatten);
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
        const stuck = yield* Effect.forkChild(
          loader.core.run(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
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
        expect(Exit.hasInterrupts(yield* Fiber.await(stuck))).toBe(true);
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
            Layer.effect(
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
    class Registry extends Context.Service<
      Registry,
      {
        readonly entries: ReadonlyMap<string, string>;
        readonly register: (name: string, value: string) => Effect.Effect<void, Error, Scope.Scope>;
      }
    >()("test/Registry") {}
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
      layer: ({ value }) => Layer.effectDiscard(Effect.flatMap(Registry, (registry) => registry.register("shared-name", value))),
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
      Effect.flip(Scope.provide(makeLoader({ source, composition: composition({ db: { config: { name: "main" } }, broken: {} }) }), scope)),
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
    // What the application provides is present for every plugin, and provided by none.
    expect(checkComposition([all.api!], {}, { provided: [Db] })).toEqual([]);
    expect(checkComposition([all.db!, all.api!], { db: { name: "main" } }, { provided: [Db] })).toMatchObject([
      { reason: "ReservedCapability", plugins: ["db"], capability: Db.key },
    ]);
    expect(checkComposition([], {}, { provided: [Hooks] })).toMatchObject([{ reason: "ReservedCapability", plugins: [], capability: Hooks.key }]);
    expect(log).toEqual([]);
  });

  test("an application whose services fail to build, or name a runtime capability, fails the loader with a diagnostic", async () => {
    const { source } = fixtures([]);
    const start = (provide: NonNullable<LoaderOptions["provide"]>) =>
      Effect.runPromise(Effect.flip(Effect.scoped(makeLoader({ source, composition: composition({ api: {} }), provide }))));
    const failed = await start({ provides: [Db], layer: Layer.effect(Db, Effect.fail("db is down")) });
    expect(failed.diagnostics).toHaveLength(1);
    expect(failed.diagnostics[0]?.pluginId).toBeUndefined();
    expect(failed.diagnostics[0]?.message).toMatch(/^The application's services failed to build:\n[^]*db is down/);
    const reserved = await start({ provides: [Hooks], layer: Layer.succeed(Hooks, { invoke: (_hook, value, end) => end(value) }) });
    expect(reserved.diagnostics.map((diagnostic) => [diagnostic.pluginId, diagnostic.message])).toEqual([
      [undefined, `The application cannot provide runtime capability "${Hooks.key}"`],
    ]);
  });

  test("a plugin that requires only the application's capabilities is untouched by changes to plugins", async () => {
    class Clock extends Context.Service<Clock, { readonly now: () => number }>()("test/Clock") {}
    const clock = { now: () => 1 };
    const provide = { provides: [Clock], layer: Layer.succeed(Clock, clock) };
    const seen: unknown[] = [];
    const timer = definePlugin({ id: "timer", requires: [Clock], layer: Layer.effectDiscard(Effect.map(Clock, (service) => void seen.push(service))) });
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const { all } = fixtures(log);
        let generation = 0;
        const port = definePlugin({
          id: "port",
          requires: [Clock],
          provides: [Db],
          exclusive: true,
          config: Schema.Struct({ name: Schema.String }),
          layer: (config) =>
            Layer.effect(
              Db,
              Effect.gen(function* () {
                yield* Clock;
                const self = { name: config.name, generation: ++generation };
                log.push(`port+${self.generation}`);
                yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`port-${self.generation}`)));
                return self;
              }),
            ),
        });
        const plugins: Record<string, Plugin> = { ...all, port, timer };
        const source: PluginSource = { resolve: (id) => Effect.succeed(plugins[id]!) };
        const loader = yield* makeLoader({ source, composition: composition({ port: { config: { name: "a" } }, api: {}, timer: {} }), provide });
        // An exclusive plugin's gap stops the plugins that depend on it, not those that share an application capability with it.
        const report = yield* loader.apply(composition({ port: { config: { name: "b" } }, api: {}, timer: {} }));
        expect(report).toMatchObject({ restarted: ["port", "api"], unchanged: ["timer"] });
        expect(log).toEqual(["port+1", "api+1", "api-1", "port-1", "port+2", "api+2"]);
        yield* loader.core.restart("port", { force: true });
        yield* loader.core.restart("timer");
        expect(seen).toEqual([clock]);
        // Forced, it restarts on its own, with the very same service.
        yield* loader.core.restart("timer", { force: true });
        expect(seen).toHaveLength(2);
        expect(seen[1]).toBe(clock);
        expect(yield* loader.core.run(Clock)).toBe(clock);
      }),
    );
    // Required, it needs no plugin: one that cannot start beside it is left failed.
    await run(
      Effect.gen(function* () {
        const { all } = fixtures([]);
        const plugins: Record<string, Plugin> = { ...all, timer };
        const loader = yield* makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins[id]!) },
          composition: composition({ db: { config: { name: "main" } }, broken: {}, timer: {} }),
          partialStart: { required: ["timer"] },
          provide,
        });
        const states = (yield* loader.core.inspect).plugins.map((plugin) => [plugin.id, plugin.state]);
        expect(states).toEqual([
          ["db", "active"],
          ["broken", "failed"],
          ["timer", "active"],
        ]);
      }),
    );
  });

  test("a partial start leaves a plugin that cannot start failed, halts its dependents, and runs the rest", async () => {
    class Flaky extends Context.Service<Flaky, string>()("test/Flaky") {}
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
      const failingDb = definePlugin({ ...all.db!, id: "db", layer: () => Layer.effectDiscard(Effect.fail("db is down")) as never });
      const plugins: Record<string, Plugin> = { ...all, db: required === "api" ? failingDb : all.db! };
      const scope = await Effect.runPromise(Scope.make());
      const error = await Effect.runPromise(
        Effect.flip(
          Scope.provide(
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
