import { expect, test } from "vitest";
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule, Schema, Scope, Stream } from "effect";
import { definePlugin, Event, Events, makeCore, makeLoader, PluginContext } from "../src/index.ts";
import type { Loader } from "../src/index.ts";
import { run, waitFor } from "./support.ts";

class Value extends Context.Tag("regression/Value")<Value, number>() {}
const value = definePlugin({ id: "value", provides: [Value], config: Schema.Struct({ n: Schema.Number }), layer: ({ n }) => Layer.succeed(Value, n) });
const composition = (n: number, transport = false) => ({ plugins: { value: { config: { n } }, ...(transport ? { transport: {} } : {}) } });

test("reload initiated inside core.run completes and releases the lifecycle lock", async () => {
  await run(
    Effect.gen(function* () {
      const loader = yield* makeLoader({
        source: { resolve: () => Effect.succeed(value) },
        composition: composition(1),
        deadlines: { dispose: Duration.millis(20) },
      });
      yield* Effect.exit(loader.core.run(loader.apply(composition(2))));
      yield* waitFor(loader.composition, (c) => (c.plugins.value?.config as { n: number } | undefined)?.n === 2);
      yield* loader.apply(composition(3));
      expect(yield* loader.core.run(Value)).toBe(3);
    }),
  );
}, 1500);

test("a reload survives disposing the exclusive plugin that requested it", async () => {
  await run(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<Loader>();
      let starts = 0;
      const transport = definePlugin({
        id: "transport",
        requires: [Value],
        exclusive: true,
        layer: Layer.scopedDiscard(
          Effect.gen(function* () {
            starts++;
            const owner = yield* PluginContext;
            if (starts === 1)
              yield* owner.background(
                "reload",
                Effect.flatMap(Deferred.await(ready), (loader) => loader.apply(composition(2, true))),
              );
          }),
        ),
      });
      const loader = yield* makeLoader({
        source: { resolve: (id) => Effect.succeed(id === "value" ? value : transport) },
        composition: composition(1, true),
        deadlines: { dispose: Duration.millis(20) },
      });
      yield* Deferred.succeed(ready, loader);
      yield* waitFor(loader.core.inspect, (s) => starts === 2 && s.plugins.every((p) => p.state === "active"));
      expect(yield* loader.core.run(Value)).toBe(2);
      expect((yield* loader.composition).plugins.value?.config).toEqual({ n: 2 });
    }),
  );
});

test("a throwing layer factory is an attributed typed activation fault", async () => {
  const broken = definePlugin({
    id: "broken",
    layer: () => {
      throw new Error("factory failed");
    },
  });
  const error = await run(Effect.flip(makeCore([broken])));
  expect(error).toMatchObject({ _tag: "PluginFault", pluginId: "broken", phase: "activate" });
});

test("activation deadlines work inside an uninterruptible caller", async () => {
  const stuck = definePlugin({ id: "stuck", layer: Layer.effectDiscard(Effect.never), deadlines: { activate: Duration.millis(20) } });
  const error = await run(Effect.flip(Effect.uninterruptible(makeCore([stuck]))));
  expect(error).toMatchObject({ _tag: "PluginFault", deadline: true });
}, 1500);

test("core close ends event streams owned by an external scope", async () => {
  await run(
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      const core = yield* Scope.extend(makeCore([]), owner);
      const events = yield* core.run(Events);
      const subscribed = yield* Deferred.make<void>();
      const tick = Event.make<number>("regression/close");
      const consumer = yield* Effect.fork(Stream.runDrain(events.stream(tick).pipe(Stream.tap(() => Deferred.succeed(subscribed, undefined)))));
      const publisher = yield* Effect.fork(Effect.repeat(events.publish(tick, 1), Schedule.spaced("1 millis")));
      yield* Deferred.await(subscribed);
      yield* Fiber.interrupt(publisher);
      yield* Scope.close(owner, Exit.void);
      yield* Fiber.join(consumer).pipe(Effect.timeout("200 millis"));
    }),
  );
});

test("explicit restart invalidates the pending automatic restart", async () => {
  await run(
    Effect.gen(function* () {
      let starts = 0;
      const trigger = yield* Deferred.make<void>();
      const plugin = definePlugin({
        id: "scheduled",
        restart: Schedule.spaced("100 millis"),
        layer: Layer.scopedDiscard(
          Effect.gen(function* () {
            starts++;
            const owner = yield* PluginContext;
            if (starts === 1) yield* owner.background("fail", Deferred.await(trigger).pipe(Effect.zipRight(Effect.fail("down"))), { required: true });
          }),
        ),
      });
      const core = yield* makeCore([plugin]);
      yield* Deferred.succeed(trigger, undefined);
      yield* waitFor(core.inspect, (s) => s.plugins[0]?.state === "failed");
      yield* core.restart("scheduled");
      yield* Effect.sleep("150 millis");
      expect(starts).toBe(2);
    }),
  );
});

test("a failed plugin does not interrupt work using only an unrelated capability", async () => {
  await run(
    Effect.gen(function* () {
      const crash = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const broken = definePlugin({
        id: "broken",
        layer: Layer.scopedDiscard(
          Effect.flatMap(PluginContext, (owner) =>
            owner.background("crash", Deferred.await(crash).pipe(Effect.zipRight(Effect.fail("down"))), { required: true }),
          ),
        ),
      });
      const core = yield* makeCore([value, broken], { configs: { value: { n: 7 } }, deadlines: { dispose: Duration.millis(20) } });
      const work = yield* Effect.fork(
        core.run(
          Effect.gen(function* () {
            const n = yield* Value;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return n;
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* Deferred.succeed(crash, undefined);
      yield* waitFor(core.inspect, (s) => s.plugins.find((p) => p.id === "broken")?.state === "failed");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(work)).toBe(7);
    }),
  );
});

test("failure interrupts resolved capabilities and revokes them from waiting tasks", async () => {
  await run(
    Effect.gen(function* () {
      const crash = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const broken = definePlugin({
        id: "broken",
        provides: [Value],
        layer: Layer.scoped(
          Value,
          Effect.gen(function* () {
            const owner = yield* PluginContext;
            yield* owner.background("crash", Deferred.await(crash).pipe(Effect.zipRight(Effect.fail("down"))), { required: true });
            return 7;
          }),
        ),
      });
      const core = yield* makeCore([broken], { deadlines: { dispose: Duration.millis(20) } });
      const affected = yield* Effect.fork(
        core.run(
          Effect.gen(function* () {
            yield* Value;
            yield* Deferred.succeed(entered, undefined);
            yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(entered);
      const late = yield* Effect.fork(core.run(Deferred.await(release).pipe(Effect.zipRight(Value))));
      yield* Deferred.succeed(crash, undefined);
      yield* waitFor(core.inspect, (s) => s.plugins[0]?.state === "failed");
      expect(Exit.isFailure(yield* Fiber.await(affected))).toBe(true);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.await(late);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(String(result.cause)).toContain("Service not found");
    }),
  );
});
