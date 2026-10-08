import { describe, expect, test } from "vitest";
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Schedule, Stream } from "effect";
import { CoreClosed, DeadlineExceeded, definePlugin, makeCore, PluginContext } from "../src/index.ts";
import { run, waitFor } from "./support.ts";

class Db extends Context.Service<Db, { readonly name: string }>()("test/Db") {}
class Api extends Context.Service<Api, string>()("test/Api") {}

/** A provider whose background task fails when the test fires the trigger created for its current activation. */
const flaky = (options: { required: boolean; log: string[]; triggers: Deferred.Deferred<void>[] }) =>
  definePlugin({
    id: "db",
    provides: [Db],
    layer: Layer.effect(
      Db,
      Effect.gen(function* () {
        options.log.push("db+");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            options.log.push("db-");
          }),
        );
        const owner = yield* PluginContext;
        const trigger = yield* Deferred.make<void>();
        options.triggers.push(trigger);
        yield* owner.background("poll", Deferred.await(trigger).pipe(Effect.andThen(Effect.fail("connection lost"))), { required: options.required });
        return { name: "db" };
      }),
    ),
  });
const api = (log: string[]) =>
  definePlugin({
    id: "api",
    requires: [Db],
    provides: [Api],
    layer: Layer.effect(
      Api,
      Effect.gen(function* () {
        log.push("api+");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            log.push("api-");
          }),
        );
        return (yield* Db).name + "-api";
      }),
    ),
  });
const bystander = (log: string[]) =>
  definePlugin({
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

describe("supervision", () => {
  test("an optional background failure is reported and changes nothing", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const triggers: Deferred.Deferred<void>[] = [];
        const core = yield* makeCore([flaky({ required: false, log, triggers }), api(log)]);
        const fault = yield* Effect.forkChild(Stream.runHead(core.faults));
        yield* Effect.sleep(Duration.millis(5));
        yield* Deferred.succeed(triggers[0]!, undefined);
        const seen = yield* Fiber.await(fault);
        expect(Exit.isSuccess(seen) && seen.value._tag === "Some" && seen.value.value).toMatchObject({
          pluginId: "db",
          phase: "background",
          operation: "poll",
        });
        expect((yield* core.inspect).plugins.map((p) => [p.id, p.state])).toEqual([
          ["db", "active"],
          ["api", "active"],
        ]);
        expect((yield* core.inspect).plugins[0]?.fault?.phase).toBe("background");
        expect(yield* core.run(Api)).toBe("db-api");
      }),
    );
  });

  test("a required background failure stops the plugin and its dependents only, then explicit restart recovers them", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const triggers: Deferred.Deferred<void>[] = [];
        const core = yield* makeCore([api(log), flaky({ required: true, log, triggers }), bystander(log)]);
        yield* Deferred.succeed(triggers[0]!, undefined);
        yield* waitFor(core.inspect, (s) => s.plugins.find((p) => p.id === "db")?.state === "failed");
        expect(log).toEqual(["db+", "api+", "bystander+", "api-", "db-"]);
        const snapshot = yield* core.inspect;
        expect(snapshot.plugins.map((p) => [p.id, p.state])).toEqual([
          ["db", "failed"],
          ["api", "closed"],
          ["bystander", "active"],
        ]);
        expect(snapshot.plugins.find((p) => p.id === "api")?.haltedBy).toBe("db");
        expect(snapshot.plugins.find((p) => p.id === "db")?.fault).toMatchObject({ phase: "background", operation: "poll" });
        // The failed capability is gone; the rest of the composition still serves.
        expect(yield* core.run(Effect.succeed("still active"))).toBe("still active");
        // Explicit restart brings back the failed plugin and what it halted; the bystander is not touched.
        yield* core.restart("db");
        expect((yield* core.inspect).plugins.map((p) => [p.id, p.state])).toEqual([
          ["db", "active"],
          ["api", "active"],
          ["bystander", "active"],
        ]);
        expect(log).toEqual(["db+", "api+", "bystander+", "api-", "db-", "db+", "api+"]);
        expect(yield* core.run(Api)).toBe("db-api");
        // Restarting an active plugin is a no-op; an unknown one is a diagnostic.
        yield* core.restart("db");
        expect(log).toHaveLength(7);
        const unknown = yield* Effect.flip(core.restart("nope"));
        expect(unknown._tag).toBe("ReloadError");
        // Forced, it replaces the active plugin and its dependents like a reload: staged first, then the old instances close.
        yield* core.restart("db", { force: true });
        expect(log.slice(7)).toEqual(["db+", "api+", "api-", "db-"]);
        expect((yield* core.inspect).plugins.map((p) => [p.id, p.state])).toEqual([
          ["db", "active"],
          ["api", "active"],
          ["bystander", "active"],
        ]);
      }),
    );
  });

  test("a failure never revokes what the application provides, nor drains work that used only that", async () => {
    class Clock extends Context.Service<Clock, { readonly now: () => number }>()("test/Clock") {}
    const clock = { now: () => 1 };
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const triggers: Deferred.Deferred<void>[] = [];
        const timer = definePlugin({ id: "timer", requires: [Clock], layer: Layer.empty });
        const watcher = definePlugin({ id: "watcher", requires: [Clock, Db], layer: Layer.empty });
        const core = yield* makeCore([flaky({ required: true, log, triggers }), api(log), timer, watcher], {
          provide: { provides: [Clock], layer: Layer.succeed(Clock, clock) },
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const task = yield* Effect.forkChild(
          core.run(
            Effect.gen(function* () {
              const service = yield* Clock;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return service.now();
            }),
          ),
        );
        yield* Deferred.await(entered);
        yield* Deferred.succeed(triggers[0]!, undefined);
        // Failing does not wait for the task: it used none of the failed capabilities.
        const snapshot = yield* waitFor(core.inspect, (s) => s.plugins.find((p) => p.id === "db")?.state === "failed");
        expect(Object.fromEntries(snapshot.plugins.map((p) => [p.id, [p.state, p.haltedBy]]))).toEqual({
          db: ["failed", undefined],
          api: ["closed", "db"],
          timer: ["active", undefined],
          watcher: ["closed", "db"],
        });
        expect(yield* core.run(Clock)).toBe(clock);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(task)).toBe(1);
      }),
    );
  });

  test("a restart schedule retries a failed plugin and stops when exhausted", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const attempts = yield* Ref.make(0);
        const always = definePlugin({
          id: "db",
          provides: [Db],
          restart: Schedule.recurs(2),
          layer: Layer.effect(
            Db,
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
              log.push(`db+${attempt}`);
              const owner = yield* PluginContext;
              yield* owner.background("poll", Effect.fail("down"), { required: true });
              return { name: "db" };
            }),
          ),
        });
        const core = yield* makeCore([always]);
        // Two automatic restarts, then the schedule is exhausted and the plugin stays failed.
        yield* waitFor(Ref.get(attempts), (n) => n === 3);
        yield* waitFor(core.inspect, (s) => s.plugins[0]?.state === "failed");
        yield* Effect.sleep(Duration.millis(20));
        expect(log).toEqual(["db+1", "db+2", "db+3"]);
        expect((yield* core.inspect).plugins[0]?.state).toBe("failed");
        // An explicit restart resets the schedule: two more automatic attempts follow it.
        yield* core.restart("db");
        yield* waitFor(Ref.get(attempts), (n) => n === 6);
        yield* waitFor(core.inspect, (s) => s.plugins[0]?.state === "failed");
        yield* Effect.sleep(Duration.millis(20));
        expect(log).toHaveLength(6);
      }),
    );
  });

  test("background work is rejected once the plugin or core has stopped", async () => {
    let context!: Context.Service.Shape<typeof PluginContext>;
    await run(
      Effect.gen(function* () {
        const plugin = definePlugin({
          id: "p",
          layer: Layer.effectDiscard(
            Effect.map(PluginContext, (owner) => {
              context = owner;
            }),
          ),
        });
        yield* makeCore([plugin]);
      }),
    );
    const error = await Effect.runPromise(Effect.flip(context.background("late", Effect.void)));
    expect(error).toBeInstanceOf(CoreClosed);
  });

  test("a fault a plugin reports for its own work is attributed, and a fatal one stops it and its dependents only", async () => {
    let owner!: Context.Service.Shape<typeof PluginContext>;
    const reporter = definePlugin({
      id: "db",
      provides: [Db],
      layer: Layer.effect(
        Db,
        Effect.map(PluginContext, (context) => {
          owner = context;
          return { name: "db" };
        }),
      ),
    });
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const core = yield* makeCore([reporter, api(log), bystander(log)]);
        const states = Effect.map(core.inspect, (snapshot) => Object.fromEntries(snapshot.plugins.map((plugin) => [plugin.id, plugin.state])));

        yield* owner.fault("render menu", Cause.die(new Error("menu threw")));
        const reported = (yield* core.inspect).plugins.find((plugin) => plugin.id === "db")?.fault;
        expect(reported).toMatchObject({ pluginId: "db", phase: "service", operation: "render menu" });
        expect(reported?.message).toBe('Plugin "db" failed during service render menu');
        expect(yield* states).toEqual({ db: "active", api: "active", bystander: "active" });

        yield* owner.fault("effects", Cause.die(new Error("state broke")), { fatal: true });
        expect(yield* waitFor(states, (now) => now.db === "failed")).toEqual({ db: "failed", api: "closed", bystander: "active" });
        // A stopped plugin's reports change nothing.
        const sequence = (yield* core.inspect).faultSequence;
        yield* owner.fault("late", Cause.die("late"));
        expect((yield* core.inspect).faultSequence).toBe(sequence);
      }),
    );
  });

  test("a fault reported while its plugin is still staged is kept, and a fatal one fails it once it is published", async () => {
    class Breaker extends Context.Service<Breaker, { readonly breakIt: (fatal: boolean) => Effect.Effect<void> }>()("test/Breaker") {}
    const breaker = definePlugin({
      id: "breaker",
      provides: [Breaker],
      layer: Layer.effect(
        Breaker,
        Effect.map(PluginContext, (owner) => ({ breakIt: (fatal: boolean) => owner.fault("effects", Cause.die(new Error("broke")), { fatal }) })),
      ),
    });
    // Activates after `breaker`, in the same start, and breaks it before either is published.
    const trigger = (fatal: boolean) =>
      definePlugin({ id: "trigger", requires: [Breaker], layer: Layer.effectDiscard(Effect.flatMap(Breaker, (service) => service.breakIt(fatal))) });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([breaker, trigger(false)]);
        const plugins = (yield* core.inspect).plugins;
        expect(plugins.map((plugin) => [plugin.id, plugin.state])).toEqual([
          ["breaker", "active"],
          ["trigger", "active"],
        ]);
        expect(plugins[0]?.fault).toMatchObject({ phase: "service", operation: "effects" });
      }),
    );
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([breaker, trigger(true)]);
        const states = Effect.map(core.inspect, (snapshot) => Object.fromEntries(snapshot.plugins.map((plugin) => [plugin.id, plugin.state])));
        expect(yield* waitFor(states, (now) => now.breaker === "failed")).toEqual({ breaker: "failed", trigger: "closed" });
      }),
    );
  });

  test("activation and disposal deadlines produce attributed faults instead of hangs", async () => {
    const log: string[] = [];
    const stuck = definePlugin({
      id: "stuck",
      deadlines: { activate: Duration.millis(30) },
      layer: Layer.effectDiscard(Effect.never),
    });
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(makeCore([stuck]))));
    expect(error).toMatchObject({ _tag: "PluginFault", pluginId: "stuck", phase: "activate", deadline: true });
    expect(error._tag === "PluginFault" && Option.getOrUndefined(Cause.findErrorOption(error.cause))).toBeInstanceOf(DeadlineExceeded);

    const slowClose = definePlugin({
      id: "slow-close",
      deadlines: { dispose: Duration.millis(30) },
      layer: Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            log.push("closing");
          }).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    });
    const started = Date.now();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([slowClose]);
          const faults = yield* Effect.forkChild(Stream.runHead(core.faults));
          yield* Effect.yieldNow;
          return faults;
        }),
      ),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log).toEqual(["closing"]);
    // Shutdown surfaces the dispose fault to the owner instead of reporting a clean close.
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
