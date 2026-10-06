import { cpus } from "node:os";
import { Context, Effect, Layer } from "effect";
import { finish, record } from "./budgets.ts";
import { definePlugin, Event, Events, Hook, Hooks, makeCore, makeLoader, PluginContext, Registries, Registry } from "../src/index.ts";
import type { Plugin } from "../src/index.ts";

// Warm microbenchmarks, not end-to-end latency or a comparison with another harness.
// Every reported value is a batch mean. Samples use fresh Effect runtime entry but
// dispatch cases reuse a mounted core, with one core.run per batch (not per hook).
const samples = Number(process.env.LEMMA_BENCH_SAMPLES ?? 7);
if (!Number.isInteger(samples) || samples < 1) throw new Error("LEMMA_BENCH_SAMPLES must be a positive integer");
const iterations = Number(process.env.LEMMA_BENCH_ITERATIONS ?? 10_000);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("LEMMA_BENCH_ITERATIONS must be a positive integer");
const mounts = Math.min(100, iterations);
const point = Hook.make<number, number>("bench/increment");
const tick = Event.make<number>("bench/tick");
const entries = Registry.make<number>("bench/entries");
const terminal = (value: number) => Effect.succeed(value + 1);
const plugins = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    definePlugin({
      id: `plugin-${String(index).padStart(3, "0")}`,
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(point, (value, next) => next(value));
        }),
      ),
    }),
  );
const observers = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    definePlugin({
      id: `observer-${String(index).padStart(3, "0")}`,
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.observe(tick, () => Effect.void))),
    }),
  );

function repeat<A, E, R>(operation: Effect.Effect<A, E, R>, count: number): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    for (let i = 0; i < count; i++) yield* operation;
  });
}

async function measure<E>(name: string, count: number, effect: Effect.Effect<void, E>) {
  await Effect.runPromise(effect);
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    await Effect.runPromise(effect);
    values.push(((performance.now() - start) * 1_000) / count);
  }
  values.sort((a, b) => a - b);
  record(name, values[Math.floor(samples / 2)]!);
  console.log(`${name.padEnd(33)} ${values[Math.floor(samples / 2)]!.toFixed(3).padStart(9)} µs/op  [${values[0]!.toFixed(3)}, ${values.at(-1)!.toFixed(3)}]`);
}

console.log(`Node ${process.version} · ${process.platform}/${process.arch} · ${cpus()[0]?.model}`);
console.log(`Median batch means, ${samples} samples; brackets show min/max. No external trace exporter.\n`);
await measure("Effect direct", iterations, repeat(terminal(1), iterations));
let sink = 0;
const increment = (n: number) => n + 1;
await measure(
  "Plain function",
  iterations,
  Effect.sync(() => {
    for (let n = 0; n < iterations; n++) sink = increment(sink);
  }),
);
class Increment extends Context.Service<Increment, typeof increment>()("bench/Increment") {}
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([definePlugin({ id: "increment", provides: [Increment], layer: Layer.succeed(Increment, increment) })]);
      const call = yield* core.run(Increment);
      yield* Effect.promise(() =>
        measure(
          "Captured capability",
          iterations,
          core.run(
            Effect.sync(() => {
              for (let n = 0; n < iterations; n++) sink = call(sink);
            }),
          ),
        ),
      );
    }),
  ),
);

for (const count of [0, 1, 8, 32]) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore(plugins(count));
        const hooks = yield* core.run(Hooks);
        const batch = core.run(repeat(hooks.invoke(point, 1, terminal), iterations));
        yield* Effect.promise(() => measure(`Hook / ${count} handlers / spans on`, iterations, batch));
        yield* Effect.promise(() => measure(`Hook / ${count} handlers / spans off`, iterations, batch.pipe(Effect.withTracerEnabled(false))));
      }),
    ),
  );
}

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([]);
      yield* Effect.promise(() => measure("core.run entry", iterations, repeat(core.run(Effect.void), iterations)));
    }),
  ),
);

for (const count of [0, 8, 32, 128]) {
  const composition = plugins(count);
  await measure(`Mount + dispose / ${count} plugins`, mounts, repeat(Effect.scoped(makeCore(composition)), mounts));
}

for (const count of [0, 1, 8]) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore(observers(count));
        const events = yield* core.run(Events);
        yield* Effect.promise(() => measure(`Event publish / ${count} observers`, iterations, core.run(repeat(events.publish(tick, 1), iterations))));
      }),
    ),
  );
}

// Registries: reading the items (what a view does on every render), and adding then removing one while `count` others stay.
const contributors = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    definePlugin({
      id: `contributor-${String(index).padStart(3, "0")}`,
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(entries, index, { order: index % 7 }))),
    }),
  );
for (const count of [0, 8, 128]) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore(contributors(count));
        const registries = yield* core.run(Registries);
        yield* Effect.promise(() => measure(`Registry items / ${count} items`, iterations, core.run(repeat(registries.items(entries), iterations))));
      }),
    ),
  );
}
for (const count of [8, 128]) {
  let add!: (value: number) => Effect.Effect<Effect.Effect<void>, unknown>;
  const adder = definePlugin({
    id: "adder",
    layer: Layer.effectDiscard(
      Effect.map(PluginContext, (owner) => {
        add = (value) => owner.add(entries, value);
      }),
    ),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([...contributors(count), adder]);
        yield* Effect.promise(() => measure(`Registry add + remove / ${count} items`, iterations, repeat(Effect.flatten(add(-1)), iterations)));
        void core;
      }),
    ),
  );
}

// Reload: change one plugin's config in a composition where nothing depends on it.
for (const count of [8, 32, 128]) {
  const all = plugins(count);
  const byId = new Map<string, Plugin>(all.map((plugin) => [plugin.id, plugin]));
  const source = { resolve: (id: string) => Effect.succeed(byId.get(id)!) };
  const composition = (version: number) => ({
    plugins: Object.fromEntries(all.map((plugin, index) => [plugin.id, { config: index === 0 ? { version } : {} }])),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const loader = yield* makeLoader({ source, composition: composition(0) });
        let version = 0;
        // Config is opaque to schema-less plugins but still compared, so each apply restarts exactly one plugin.
        yield* Effect.promise(() =>
          measure(
            `Reload one of ${count} plugins`,
            100,
            repeat(
              Effect.suspend(() => loader.apply(composition(++version))),
              100,
            ),
          ),
        );
      }),
    ),
  );
}
if (sink === 0) throw new Error("Unobserved capability result");
finish("microbench");
