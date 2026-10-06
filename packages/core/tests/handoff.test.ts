import { describe, expect, test } from "vitest";
import { Cause, Context, Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { definePlugin, makeLoader } from "../src/index.ts";
import type { Plugin } from "../src/index.ts";
import { definePlugin as definePlainPlugin } from "../src/plain/index.ts";
import { run, waitFor } from "./support.ts";

class Count extends Context.Service<Count, { readonly add: () => number; readonly previous: unknown }>()("test/Count") {}

/** A counter that hands its count to its replacement; `config.version` changes force a replacement. */
const counter = (options: { readonly exclusive?: boolean; readonly carry?: Schema.Codec<any, any>; readonly save?: (count: number) => unknown } = {}) =>
  definePlugin({
    id: "counter",
    config: { version: 0 },
    ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
    ...(options.carry === undefined ? {} : { carry: options.carry }),
    provides: { count: Count },
    setup: function* (_, plugin) {
      let count = typeof plugin.previous === "number" ? plugin.previous : 0;
      yield* plugin.handoff(() => (options.save === undefined ? count : options.save(count)));
      return { count: { add: () => ++count, previous: plugin.previous } };
    },
  });

const loaded = (plugin: Plugin) =>
  makeLoader({ source: { resolve: () => Effect.succeed(plugin) }, composition: { plugins: { counter: { config: { version: 0 } } } } });
const version = (n: number) => ({ plugins: { counter: { config: { version: n } } } });
const add = Effect.flatMap(Count, (count) => Effect.sync(() => count.add()));
const previous = Effect.map(Count, (count) => count.previous);

describe("handing state to a replacement", () => {
  test("a reload carries what the running instance hands over; a first start has nothing", async () => {
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(counter({ carry: Schema.Number }));
        expect(yield* loader.core.run(previous)).toBeUndefined();
        yield* loader.core.run(add);
        yield* loader.core.run(add);
        yield* loader.apply(version(1));
        expect(yield* loader.core.run(previous)).toBe(2);
        expect(yield* loader.core.run(add)).toBe(3);
        yield* loader.apply(version(2));
        expect(yield* loader.core.run(add)).toBe(4);
      }),
    );
  });

  test("what no longer decodes is reported and dropped: the replacement starts fresh", async () => {
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(counter({ carry: Schema.Number, save: (count) => ({ count }) }));
        yield* loader.core.run(add);
        yield* loader.apply(version(1));
        expect(yield* loader.core.run(previous)).toBeUndefined();
        const snapshot = yield* waitFor(loader.core.inspect, (now) => now.plugins[0]?.fault?.operation === "handoff");
        expect(snapshot.plugins[0]?.state).toBe("active");
      }),
    );
  });

  test("a save that throws is the old instance's fault; the replacement starts without it", async () => {
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(
          counter({
            save: () => {
              throw new Error("cannot serialize");
            },
          }),
        );
        const heard: string[] = [];
        yield* Effect.forkScoped(Stream.runForEach(loader.core.faults, (fault) => Effect.sync(() => void heard.push(`${fault.pluginId} ${fault.operation}`))));
        yield* Effect.yieldNow;
        yield* loader.core.run(add);
        yield* loader.apply(version(1));
        expect(yield* loader.core.run(previous)).toBeUndefined();
        yield* waitFor(
          Effect.sync(() => heard),
          (now) => now.includes("counter handoff"),
        );
        expect((yield* loader.core.inspect).plugins[0]?.state).toBe("active");
      }),
    );
  });

  test("an exclusive plugin hands over just before it stops, everything it did included", async () => {
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(counter({ exclusive: true }));
        yield* loader.core.run(add);
        yield* loader.core.run(add);
        yield* loader.core.run(add);
        yield* loader.apply(version(1));
        expect(yield* loader.core.run(previous)).toBe(3);
      }),
    );
  });

  test("an exclusive plugin's work in flight when the reload starts is in what it hands over", async () => {
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(counter({ exclusive: true }));
        yield* loader.core.run(add);
        // A request held open across the reload: it starts, the reload begins draining, then it finishes.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const inflight = yield* Effect.forkChild(
          loader.core.run(
            Effect.flatMap(Count, (count) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.map(() => count.add()),
              ),
            ),
          ),
        );
        yield* Deferred.await(started);
        const applying = yield* Effect.forkChild(loader.apply(version(1)));
        yield* waitFor(loader.core.inspect, (now) => now.plugins.find((plugin) => plugin.id === "counter")?.state === "draining");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(applying);
        expect(yield* Fiber.join(inflight)).toBe(2);
        expect(yield* loader.core.run(previous)).toBe(2);
      }),
    );
  });

  test("what is handed over is a copy: a replacement that fails to start cannot change the running instance's state", async () => {
    class Items extends Context.Service<Items, { readonly items: () => readonly number[] }>()("test/Items") {}
    let failNext = false;
    const holder = definePlugin({
      id: "counter",
      config: { version: 0 },
      provides: { items: Items },
      setup: function* (_, plugin) {
        const items = Array.isArray(plugin.previous) ? (plugin.previous as number[]) : [1];
        yield* plugin.handoff(() => items);
        if (failNext) {
          items.push(2);
          return yield* Effect.fail("cannot start");
        }
        return { items: { items: () => items } };
      },
    });
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(holder);
        failNext = true;
        yield* Effect.exit(loader.apply(version(1)));
        expect(yield* loader.core.run(Effect.map(Items, (service) => service.items()))).toEqual([1]);
      }),
    );
  });

  test("state that cannot be copied is reported, and the replacement starts fresh", async () => {
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(counter({ save: () => () => "a function" }));
        const heard: string[] = [];
        yield* Effect.forkScoped(Stream.runForEach(loader.core.faults, (fault) => Effect.sync(() => void heard.push(`${fault.pluginId} ${fault.operation}`))));
        yield* Effect.yieldNow;
        yield* loader.apply(version(1));
        expect(yield* loader.core.run(previous)).toBeUndefined();
        yield* waitFor(
          Effect.sync(() => heard),
          (now) => now.includes("counter handoff"),
        );
      }),
    );
  });

  test("a restart after a failure starts fresh: a failed instance's state is not trusted", async () => {
    let fail!: () => void;
    const fragile = definePlugin({
      id: "counter",
      config: { version: 0 },
      provides: { count: Count },
      setup: function* (_, plugin) {
        let count = typeof plugin.previous === "number" ? plugin.previous : 0;
        yield* plugin.handoff(() => count);
        fail = () => void Effect.runFork(plugin.fault("crash", Cause.fail("crash"), { fatal: true }));
        return { count: { add: () => ++count, previous: plugin.previous } };
      },
    });
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(fragile);
        yield* loader.core.run(add);
        fail();
        yield* waitFor(loader.core.inspect, (now) => now.plugins[0]?.state === "failed");
        yield* loader.core.restart("counter");
        expect(yield* loader.core.run(previous)).toBeUndefined();
      }),
    );
  });

  test("a plugin written with promises hands over the same way", async () => {
    const plain = definePlainPlugin({
      id: "counter",
      config: { version: 0 },
      carry: Schema.Struct({ seen: Schema.Array(Schema.String) }),
      provides: { count: Count },
      setup: (_, { previous, handoff }) => {
        const seen = [...(previous?.seen ?? [])];
        handoff(() => ({ seen }));
        return { count: { add: () => seen.push(`#${seen.length}`), previous } };
      },
    });
    await run(
      Effect.gen(function* () {
        const loader = yield* loaded(plain);
        yield* loader.core.run(add);
        yield* loader.apply(version(1));
        expect(yield* loader.core.run(previous)).toEqual({ seen: ["#0"] });
      }),
    );
  });
});
