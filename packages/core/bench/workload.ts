import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Context, Deferred, Effect, Layer, Schema, Stream } from "effect";
import { definePlugin, Hook, Hooks, makeLoader, PluginContext } from "../src/index.ts";
import { finish, record } from "./budgets.ts";

const cycles = Number(process.env.LEMMA_STRESS_CYCLES ?? 200);
if (!Number.isInteger(cycles) || cycles < 20) throw new Error("LEMMA_STRESS_CYCLES must be an integer >= 20");
const gc = () => {
  if (!globalThis.gc) throw new Error("Run Node with --expose-gc");
  globalThis.gc();
};
class Value extends Context.Service<Value, number>()("stress/Value") {}
const Point = Hook.make<number, number>("stress/operation");
const live = new Set<object>();
let crash!: Deferred.Deferred<void>;
let owner!: typeof PluginContext.Service;
const plugin = definePlugin({
  id: "resource",
  provides: [Value],
  config: Schema.Struct({ value: Schema.Number }),
  layer: ({ value }) =>
    Layer.effect(
      Value,
      Effect.gen(function* () {
        const resource = {};
        live.add(resource);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            live.delete(resource);
          }),
        );
        owner = yield* PluginContext;
        yield* owner.on(Point, (input, next) => next(input + value));
        crash = yield* Deferred.make<void>();
        yield* owner.background("connection", Deferred.await(crash).pipe(Effect.andThen(Effect.fail("lost"))), { required: true });
        return value;
      }),
    ),
});
const composition = (value: number) => ({ plugins: { resource: { config: { value } } } });
const latency: number[] = [];

async function cycle(measure: boolean) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* makeLoader({ source: { resolve: () => Effect.succeed(plugin) }, composition: composition(0) });
        // A diagnostic subscriber that never advances exercises bounded retention.
        yield* Effect.forkScoped(Stream.runForEach(loader.core.faults, () => Effect.never));
        yield* Effect.yieldNow;
        for (let n = 0; n < 300; n++) yield* owner.background("noise", Effect.fail(n));
        for (let version = 1; version <= 3; version++) {
          yield* loader.apply(composition(version));
          assert.equal(live.size, 1);
          const operation = loader.core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Point, 1, Effect.succeed)));
          const started = performance.now();
          assert.equal(yield* operation, version + 1);
          if (measure) latency.push((performance.now() - started) * 1000);
        }
        yield* Deferred.succeed(crash, undefined);
        yield* loader.core.inspect.pipe(Effect.repeat({ until: (snapshot) => snapshot.plugins[0]?.state === "failed" }), Effect.timeout("2 seconds"));
        assert.equal(live.size, 0);
        yield* loader.core.restart("resource");
        assert.equal(live.size, 1);
        const snapshot = yield* loader.core.inspect;
        assert.equal(snapshot.hooks[0]?.handlers.length, 1);
        assert.equal(yield* loader.core.run(Value), 3);
      }),
    ),
  );
  assert.equal(live.size, 0);
}

// Cold startup is a separate process importing the emitted library, including
// Effect. Five process samples, no warmup, no application setup or network.
const cold: number[] = [];
for (let sample = 0; sample < 5; sample++) {
  const start = performance.now();
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)})`]);
  cold.push(performance.now() - start);
}
cold.sort((a, b) => a - b);
record("coldStartupMs", cold[2]!);
for (let n = 0; n < 20; n++) await cycle(false);
gc();
const initial = process.memoryUsage();
const memory = [{ cycle: 0, heap: initial.heapUsed, rss: initial.rss }];
const started = performance.now();
for (let n = 1; n <= cycles; n++) {
  await cycle(true);
  if (n % 20 === 0 || n === cycles) {
    gc();
    const usage = process.memoryUsage();
    memory.push({ cycle: n, heap: usage.heapUsed, rss: usage.rss });
  }
}
const elapsed = performance.now() - started;
latency.sort((a, b) => a - b);
record("operationP95Us", latency[Math.ceil(latency.length * 0.95) - 1]!);
record("operationP99Us", latency[Math.ceil(latency.length * 0.99) - 1]!);
record("heapGrowthBytes", Math.max(0, memory.at(-1)!.heap - initial.heapUsed));
record("rssGrowthBytes", Math.max(0, memory.at(-1)!.rss - initial.rss));
record("lifecycleCyclesPerSecond", (cycles * 1000) / elapsed);
console.log(JSON.stringify({ cycles, warmupCycles: 20, faultsPerCycle: 300, reloadsPerCycle: 3, gcEveryCycles: 20, coldStartupSamplesMs: cold, memory }));
finish("workload");
