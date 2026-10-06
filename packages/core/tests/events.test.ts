import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Schedule, Scope, Stream } from "effect";
import { definePlugin, Event, Events, makeCore, PluginContext } from "../src/index.ts";
import { waitFor } from "./support.ts";

const Tick = Event.make<number>("test/tick");
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

describe("events", () => {
  test("publishing reaches every observer, never fails, and isolates observer failures", async () => {
    await run(
      Effect.gen(function* () {
        const seen = yield* Ref.make<string[]>([]);
        const good = definePlugin({
          id: "good",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.observe(Tick, (n) => Ref.update(seen, (list) => [...list, `good:${n}`]));
            }),
          ),
        });
        const broken = definePlugin({
          id: "broken",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.observe(Tick, (n) => (n === 2 ? Effect.die(new Error("observer crashed")) : Effect.void));
            }),
          ),
        });
        const core = yield* makeCore([good, broken]);
        const faults = yield* Effect.fork(Stream.runHead(core.faults));
        yield* Effect.sleep(Duration.millis(5));
        yield* core.run(
          Effect.gen(function* () {
            const events = yield* Events;
            for (const n of [1, 2, 3]) yield* events.publish(Tick, n);
          }),
        );
        yield* waitFor(Ref.get(seen), (list) => list.length === 3);
        expect(yield* Ref.get(seen)).toEqual(["good:1", "good:2", "good:3"]);
        const fault = yield* faults.await;
        expect(Exit.isSuccess(fault) && fault.value._tag === "Some" && fault.value.value).toMatchObject({
          pluginId: "broken",
          phase: "observe",
          operation: "test/tick",
        });
        const inspected = (yield* core.inspect).plugins.find((plugin) => plugin.id === "broken")?.fault;
        expect(inspected).toBe(Exit.isSuccess(fault) && fault.value._tag === "Some" ? fault.value.value : undefined);
        // The failed observer's plugin is untouched: observers are not a failure domain.
        expect((yield* core.inspect).plugins.map((p) => p.state)).toEqual(["active", "active"]);
        expect((yield* core.inspect).events).toEqual([{ name: "test/tick", observers: ["broken", "good"] }]);
      }),
    );
  });

  test("an observer asking for no buffer fails with InvalidBuffer, which its plugin can handle", async () => {
    await run(
      Effect.gen(function* () {
        const refused = yield* Deferred.make<string>();
        const careful = definePlugin({
          id: "careful",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              const error = yield* Effect.flip(owner.observe(Tick, () => Effect.void, { buffer: 0 }));
              yield* Deferred.succeed(refused, error._tag === "EventError" ? error.reason : error._tag);
            }),
          ),
        });
        const core = yield* makeCore([careful]);
        expect(yield* Deferred.await(refused)).toBe("InvalidBuffer");
        expect((yield* core.inspect).plugins.map((p) => p.state)).toEqual(["active"]);
      }),
    );
  });

  test("a slow observer sees a bounded, stale view and never stalls the publisher", async () => {
    await run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const received: number[] = [];
        const slow = definePlugin({
          id: "slow",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.observe(
                Tick,
                (n) =>
                  Effect.gen(function* () {
                    yield* Deferred.await(gate);
                    received.push(n);
                  }),
                { buffer: 2 },
              );
            }),
          ),
        });
        const core = yield* makeCore([slow]);
        yield* core.run(
          Effect.gen(function* () {
            const events = yield* Events;
            for (let n = 0; n < 10; n++) yield* events.publish(Tick, n);
          }),
        );
        yield* Deferred.succeed(gate, undefined);
        yield* waitFor(
          Effect.sync(() => received.length),
          (length) => length === 3,
        );
        yield* Effect.sleep(Duration.millis(5));
        // One payload was taken by the consumer before the gate; the buffer kept the two newest.
        expect(received).toEqual([0, 8, 9]);
      }),
    );
  });

  test("suspend applies backpressure and a closed subscriber releases the publisher", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([]);
        const events = yield* core.run(Events);
        const publish = (n: number) => events.publish(Tick, n);
        const consumed = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(Tick, { buffer: 1, overflow: "suspend" }), 1)));
        yield* Effect.sleep(Duration.millis(5));
        yield* publish(1);
        const first = yield* consumed.await;
        expect(Exit.isSuccess(first) && Array.from(first.value)).toEqual([1]);

        // A subscriber that never consumes: the second publish fills the buffer, the third suspends until it goes away.
        const stalled = yield* Effect.fork(Stream.runDrain(events.stream(Tick, { buffer: 1, overflow: "suspend" }).pipe(Stream.tap(() => Effect.never))));
        yield* Effect.sleep(Duration.millis(5));
        const second = yield* Effect.fork(publish(2).pipe(Effect.zipRight(publish(3)), Effect.zipRight(publish(4))));
        yield* Effect.sleep(Duration.millis(20));
        expect((yield* second.poll)._tag).toBe("None");
        yield* Fiber.interrupt(stalled);
        yield* second.await;
      }),
    );
  });

  test("streams end when their consumer stops and event registrations clear on disposal", async () => {
    const core = await run(
      Effect.gen(function* () {
        const observer = definePlugin({
          id: "observer",
          layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.observe(Tick, () => Effect.void))),
        });
        const core = yield* makeCore([observer]);
        const events = yield* core.run(Events);
        const collected = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(Tick), 2)));
        // Keep publishing until the subscription has taken two values.
        const publisher = yield* Effect.fork(Effect.repeat(events.publish(Tick, 7), Schedule.spaced(Duration.millis(1))));
        const result = yield* collected.await;
        yield* Fiber.interrupt(publisher);
        expect(Exit.isSuccess(result) && Array.from(result.value)).toEqual([7, 7]);
        expect((yield* core.inspect).events).toEqual([{ name: "test/tick", observers: ["observer"] }]);
        return core;
      }),
    );
    expect((await Effect.runPromise(core.inspect)).events).toEqual([]);
  });
});
