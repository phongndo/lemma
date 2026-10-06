import { expect, test } from "vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { definePlugin, makeCore, makeLoader, PluginContext } from "../src/index.ts";
import type { ReportedFault } from "../src/index.ts";
import { waitFor } from "./support.ts";

test("fault delivery is bounded, ordered, and exposes loss without slowing other subscribers", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let owner!: typeof PluginContext.Service;
        const plugin = definePlugin({
          id: "p",
          layer: Layer.effectDiscard(
            Effect.map(PluginContext, (value) => {
              owner = value;
            }),
          ),
        });
        const core = yield* makeCore([plugin]);
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const slow: ReportedFault[] = [];
        const fast: ReportedFault[] = [];
        const consumer = yield* Effect.forkScoped(
          Stream.runForEach(core.faults, (fault) =>
            Effect.gen(function* () {
              slow.push(fault);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(core.faults, (fault) =>
            Effect.sync(() => {
              fast.push(fault);
            }),
          ),
        );
        yield* Effect.yieldNow;
        yield* owner.background("first", Effect.fail(0));
        yield* Deferred.await(entered);
        for (let n = 1; n <= 300; n++) yield* owner.background("storm", Effect.fail(n));
        yield* waitFor(
          Effect.sync(() => fast.length),
          (length) => length === 301,
        );
        yield* Deferred.succeed(release, undefined);
        yield* waitFor(
          Effect.sync(() => slow.at(-1)),
          (fault) => fault === fast.at(-1),
        );
        expect(slow).toHaveLength(257);
        expect(slow.map((fault) => fault.sequence)).toEqual([1, ...Array.from({ length: 256 }, (_, i) => i + 46)]);
        expect(fast.map((fault) => fault.sequence)).toEqual(Array.from({ length: 301 }, (_, i) => i + 1));
        expect((yield* core.inspect).plugins[0]?.fault).toBe(fast.at(-1));
        const publishing = yield* Effect.forkChild(
          Effect.forEach(
            Array.from({ length: 100 }, (_, i) => i),
            (n) => owner.background("during unsubscribe", Effect.fail(n)),
            { discard: true },
          ),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(consumer);
        yield* Fiber.join(publishing);
        yield* waitFor(core.inspect, (snapshot) => snapshot.faultSequence === 401);
      }),
    ),
  );
});

test("inspection retains faults without subscribers and resets with the owning instance", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let owner!: typeof PluginContext.Service;
        const plugin = definePlugin({
          id: "p",
          config: Schema.Struct({ generation: Schema.Number }),
          layer: () =>
            Layer.effectDiscard(
              Effect.map(PluginContext, (value) => {
                owner = value;
              }),
            ),
        });
        const loader = yield* makeLoader({ source: { resolve: () => Effect.succeed(plugin) }, composition: { plugins: { p: { config: { generation: 0 } } } } });
        yield* owner.background("fail", Effect.fail("original"));
        yield* waitFor(loader.core.inspect, (snapshot) => snapshot.faultSequence === 1);
        expect((yield* loader.core.inspect).plugins[0]?.fault).toMatchObject({ phase: "background" });
        yield* loader.apply({ plugins: { p: { config: { generation: 1 } } } });
        expect((yield* loader.core.inspect).plugins[0]?.fault).toBeUndefined();
        expect((yield* loader.core.inspect).faultSequence).toBe(1);
        yield* loader.apply({ plugins: {} });
        expect((yield* loader.core.inspect).plugins).toEqual([]);
      }),
    ),
  );
});
