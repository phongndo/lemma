import { expect, test } from "vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { definePlugin, makeLoader, PluginContext } from "../src/index.ts";
import { waitFor } from "./support.ts";

const composition = (generation: number) => ({ plugins: { p: { config: { generation } } } });
const Config = Schema.Struct({ generation: Schema.Number });

test("shutdown interrupts staged reload and releases both generations exactly once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const live = new Set<number>();
      const disposed: number[] = [];
      const plugin = definePlugin({
        id: "p",
        config: Config,
        layer: ({ generation }) =>
          Layer.effectDiscard(
            Effect.gen(function* () {
              live.add(generation);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  live.delete(generation);
                  disposed.push(generation);
                }),
              );
              if (generation === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Effect.never;
              }
            }),
          ),
      });
      const loader = yield* Scope.provide(makeLoader({ source: { resolve: () => Effect.succeed(plugin) }, composition: composition(0) }), scope);
      const apply = yield* Effect.forkDetach(loader.apply(composition(1)));
      yield* Deferred.await(entered);
      yield* Effect.all([Scope.close(scope, Exit.void), Scope.close(scope, Exit.void)], { concurrency: "unbounded" });
      expect(Exit.isFailure(yield* Fiber.await(apply))).toBe(true);
      expect(live.size).toBe(0);
      expect(disposed).toEqual([1, 0]);
      expect((yield* loader.core.inspect).state).toBe("closed");
    }),
  );
});

test("a retired generation's late required-task failure cannot poison its replacement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const plugin = definePlugin({
          id: "p",
          config: Config,
          layer: ({ generation }) =>
            Layer.effectDiscard(
              Effect.gen(function* () {
                const owner = yield* PluginContext;
                if (generation === 0)
                  yield* owner.background("old", Effect.uninterruptible(Deferred.await(release).pipe(Effect.andThen(Effect.fail("old failure")))), {
                    required: true,
                  });
              }),
            ),
        });
        const loader = yield* makeLoader({
          source: { resolve: () => Effect.succeed(plugin) },
          composition: composition(0),
          deadlines: { dispose: "20 millis" },
        });
        const seen: string[] = [];
        yield* Effect.forkScoped(
          Stream.runForEach(loader.core.faults, (fault) =>
            Effect.sync(() => {
              seen.push(fault.phase);
            }),
          ),
        );
        yield* Effect.yieldNow;
        yield* loader.apply(composition(1));
        expect((yield* loader.core.inspect).plugins[0]?.fault).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* waitFor(
          Effect.sync(() => seen.includes("background")),
          Boolean,
        );
        expect((yield* loader.core.inspect).plugins[0]).toMatchObject({ state: "active" });
        expect((yield* loader.core.inspect).plugins[0]?.fault).toBeUndefined();
      }),
    ),
  );
});

test("failed staging reports its faults while preserving the running instance's inspection", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const reported = yield* Deferred.make<void>();
        const plugin = definePlugin({
          id: "p",
          config: Config,
          layer: ({ generation }) =>
            Layer.effectDiscard(
              Effect.gen(function* () {
                if (generation === 0) return;
                const owner = yield* PluginContext;
                yield* owner.background("staged", Effect.fail("staged background"));
                yield* Deferred.await(reported);
                return yield* Effect.fail("staged activation");
              }),
            ),
        });
        const loader = yield* makeLoader({ source: { resolve: () => Effect.succeed(plugin) }, composition: composition(0) });
        yield* Effect.forkScoped(
          Stream.runForEach(loader.core.faults, (fault) => (fault.operation === "staged" ? Deferred.succeed(reported, undefined) : Effect.void)),
        );
        yield* Effect.yieldNow;
        expect(Exit.isFailure(yield* Effect.exit(loader.apply(composition(1))))).toBe(true);
        expect((yield* loader.core.inspect).plugins[0]).toMatchObject({ state: "active" });
        expect((yield* loader.core.inspect).plugins[0]?.fault).toBeUndefined();
      }),
    ),
  );
});
