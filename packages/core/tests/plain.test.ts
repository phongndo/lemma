import { describe, expect, test } from "vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Result, Stream } from "effect";
import { definePlugin as defineEffectPlugin, Event, Hook, Hooks, makeCore, makeLoader, PluginFault, PluginStopped, Registry } from "../src/index.ts";
import type { Plugin } from "../src/index.ts";
import { asEffect, awaitable, definePlugin, fail, followsAwait } from "../src/plain/index.ts";
import type { PlainSetup } from "../src/plain/index.ts";
import { testPlugin } from "../src/testing.ts";
import { run } from "./support.ts";

class NotFound extends Error {
  readonly _tag = "NotFound";
}

interface StoreShape {
  readonly get: (key: string) => Effect.Effect<string, NotFound>;
  readonly size: Effect.Effect<number>;
  readonly keys: Stream.Stream<string>;
  readonly wait: (key: string) => Effect.Effect<never>;
  readonly local: (key: string) => string;
}
class Store extends Context.Service<Store, StoreShape>()("test/Store") {}
class Greeter extends Context.Service<Greeter, { readonly greet: (name: string) => Effect.Effect<string> }>()("test/Greeter") {}
const Shout = Hook.make<string, string, NotFound>("test/shout");
const Saved = Event.make<string>("test/saved");
const Names = Registry.make<string>("test/names", { key: (name) => name, unique: true });

/** A store whose `wait` never ends, recording when it is interrupted. */
const makeStore = (data: Record<string, string>) => {
  const interrupted: string[] = [];
  const store: StoreShape = {
    get: (key) => (key in data ? Effect.succeed(data[key]!) : Effect.fail(new NotFound(key))),
    size: Effect.sync(() => Object.keys(data).length),
    keys: Stream.fromIterable(Object.keys(data)),
    wait: (key) => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted.push(key)))),
    local: (key) => `local ${key}`,
  };
  return { store, interrupted };
};

const shout = (input: string) => Effect.flatMap(Hooks, (hooks) => hooks.invoke(Shout, input, (value) => Effect.succeed(value)));

describe("a plugin written with promises", () => {
  test("uses Effect services as promises, iterables, and plain calls", async () => {
    const { store } = makeStore({ a: "1", b: "2" });
    const seen: unknown[] = [];
    const reader = definePlugin({
      id: "reader",
      requires: { store: Store },
      setup: async ({ store }) => {
        seen.push(await store.get("a"), await store.size(), store.local("x"));
        for await (const key of store.keys()) seen.push(key);
        const error = await store.get("missing").catch((caught: unknown) => caught);
        seen.push(error instanceof NotFound);
      },
    });
    const tested = await testPlugin(reader, { provide: [[Store, store]] });
    await tested.close();
    expect(seen).toEqual(["1", 2, "local x", "a", "b", true]);
  });

  test("provides services to Effect plugins, with asEffect where the contract returns Effects", async () => {
    const greeter = definePlugin({
      id: "greeter",
      config: { greeting: "Hello" },
      provides: { greeter: Greeter },
      setup: (_, { config }) => ({ greeter: { greet: asEffect(async (name: string) => `${config.greeting}, ${name}`) } }),
    });
    const tested = await testPlugin(greeter, { config: { greeting: "Hi" } });
    try {
      expect(await tested.run(Effect.flatMap(Greeter, (service) => service.greet("Ada")))).toBe("Hi, Ada");
    } finally {
      await tested.close();
    }
  });

  describe("hook handlers", () => {
    const withHandler = (handler: (services: {}, plugin: PlainSetup<void>) => void) => testPlugin(definePlugin({ id: "handler", setup: handler }));

    test("return a value, pass through in place, or await next", async () => {
      const tested = await testPlugin(
        definePlugin({
          id: "handlers",
          setup: (_, { on }) => {
            on(Shout, (input, next) => (input === "skip" ? "skipped" : next(input)), { order: 1 });
            on(Shout, async (input, next) => `${(await next(input)).toUpperCase()}!`, { order: 2 });
          },
        }),
      );
      try {
        expect(await tested.run(shout("skip"))).toBe("skipped");
        expect(await tested.run(shout("hi"))).toBe("HI!");
      } finally {
        await tested.close();
      }
    });

    test("a throw is a defect that fails the operation; a marked one, or a failure passed on, fails it typed", async () => {
      const tested = await withHandler((_, { on }) => {
        on(Shout, async (input, next) => {
          if (input === "defect") throw new Error("broken");
          if (input === "typed") throw fail(new NotFound("typed"));
          return next(input);
        });
      });
      try {
        const defect = await tested.run(Effect.exit(shout("defect")));
        expect(Exit.isFailure(defect) && Result.isSuccess(Cause.findDefect(defect.cause))).toBe(true);
        expect(Exit.isFailure(defect) && Option.isNone(Cause.findErrorOption(defect.cause))).toBe(true);
        const typed = await tested.run(Effect.exit(shout("typed")));
        expect(Exit.isFailure(typed) && Option.getOrUndefined(Cause.findErrorOption(typed.cause))).toBeInstanceOf(NotFound);
      } finally {
        await tested.close();
      }
    });

    test("a failure from next, rethrown, stays the same typed failure", async () => {
      const original = new NotFound("from the terminal");
      const caught: unknown[] = [];
      const tested = await withHandler((_, { on }) => {
        on(Shout, async (input, next) => {
          try {
            return await next(input);
          } catch (error) {
            caught.push(error);
            throw error;
          }
        });
      });
      try {
        const exit = await tested.run(Effect.exit(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Shout, "x", () => Effect.fail(original)))));
        expect(caught).toEqual([original]);
        expect(Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(original);
      } finally {
        await tested.close();
      }
    });

    test("an interrupted operation aborts the handler's signal and stops the calls it made", async () => {
      const { store, interrupted } = makeStore({});
      let signal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const tested = await testPlugin(
        definePlugin({
          id: "waiting",
          requires: { store: Store },
          setup: ({ store }, { on }) => {
            on(Shout, async (input, _next, handlerSignal) => {
              signal = handlerSignal;
              markStarted();
              await store.wait(input);
              return input;
            });
          },
        }),
        { provide: [[Store, store]] },
      );
      try {
        await tested.run(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(shout("pending"));
            yield* Effect.promise(() => started);
            yield* Fiber.interrupt(fiber);
          }),
        );
        expect(signal?.aborted).toBe(true);
        await expect.poll(() => interrupted).toEqual(["pending"]);
      } finally {
        await tested.close();
      }
    });
  });

  test("calls from a callback an Effect runs keep that Effect's context: who is asking reaches the service", async () => {
    const Origin = Context.Reference<string | undefined>("test/Origin", { defaultValue: () => undefined });
    class Asker extends Context.Service<Asker, { readonly ask: () => Effect.Effect<string | undefined> }>()("test/Asker") {}
    let callback: (() => Promise<string | undefined>) | undefined;
    const tested = await testPlugin(
      definePlugin({
        id: "callback-maker",
        requires: { asker: Asker },
        setup: ({ asker }) => {
          callback = async () => {
            await Promise.resolve();
            // After an await too: the context follows promise code where the runtime can carry it.
            return asker.ask();
          };
        },
      }),
      { provide: [[Asker, { ask: () => Effect.service(Origin) }]] },
    );
    try {
      const asked = await tested.run(awaitable(() => callback!()).pipe(Effect.provideService(Origin, "session:abc")));
      expect(asked).toBe(followsAwait ? "session:abc" : undefined);
    } finally {
      await tested.close();
    }
  });

  test("a hook handler's calls keep the operation's context: an async one's after awaits, a plain one's as it runs", async () => {
    const Origin = Context.Reference<string | undefined>("test/HandlerOrigin", { defaultValue: () => undefined });
    class Asker extends Context.Service<Asker, { readonly ask: () => Effect.Effect<string | undefined> }>()("test/HandlerAsker") {}
    const Ask = Hook.make<string, string>("test/ask");
    const tested = await testPlugin(
      definePlugin({
        id: "askers",
        requires: { asker: Asker },
        setup: ({ asker }, { on }) => {
          on(
            Ask,
            async (input, next) => {
              await Promise.resolve();
              return `${await next(input)} async:${await asker.ask()}`;
            },
            { order: 1 },
          );
          on(Ask, (input, next) => (input === "sync" ? asker.ask().then((origin) => `sync:${origin}`) : next(input)), { order: 0 });
        },
      }),
      { provide: [[Asker, { ask: () => Effect.service(Origin) }]] },
    );
    try {
      const ask = (input: string) =>
        Effect.flatMap(Hooks, (hooks) => hooks.invoke(Ask, input, (value) => Effect.succeed(value))).pipe(Effect.provideService(Origin, "turn:7"));
      expect(await tested.run(ask("sync"))).toBe("sync:turn:7");
      expect(await tested.run(ask("x"))).toBe(followsAwait ? "x async:turn:7" : "x async:undefined");
    } finally {
      await tested.close();
    }
  });

  test("its services refuse calls once it has stopped", async () => {
    const { store } = makeStore({ a: "1" });
    let kept: { readonly get: (key: string) => Promise<string> } | undefined;
    const tested = await testPlugin(
      definePlugin({
        id: "leaky",
        requires: { store: Store },
        setup: ({ store }) => {
          kept = store;
        },
      }),
      { provide: [[Store, store]] },
    );
    expect(await kept!.get("a")).toBe("1");
    await tested.close();
    await expect(kept!.get("a")).rejects.toBeInstanceOf(PluginStopped);
  });

  test("a view of what the application provides is the plugin's own: it refuses once that plugin stops, and others' still work", async () => {
    const { store } = makeStore({ a: "1" });
    const kept = new Map<string, { readonly get: (key: string) => Promise<string> }>();
    const keeper = (id: string) => definePlugin({ id, requires: { store: Store }, setup: ({ store }) => void kept.set(id, store) });
    const plugins: Record<string, Plugin> = { first: keeper("first"), second: keeper("second") };
    await run(
      Effect.gen(function* () {
        const loader = yield* makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins[id]!) },
          composition: { plugins: { first: {}, second: {} } },
          provide: { provides: [Store], layer: Layer.succeed(Store, store) },
        });
        yield* loader.apply({ plugins: { second: {} } });
        yield* Effect.promise(async () => {
          await expect(kept.get("first")!.get("a")).rejects.toBeInstanceOf(PluginStopped);
          expect(await kept.get("second")!.get("a")).toBe("1");
        });
        expect(yield* loader.core.run(Effect.flatMap(Store, (service) => service.get("a")))).toBe("1");
      }),
    );
  });

  test("a failed call nobody awaited is reported as its fault, not an unhandled rejection", async () => {
    const { store } = makeStore({});
    const tested = await testPlugin(
      definePlugin({
        id: "careless",
        requires: { store: Store },
        setup: ({ store }, { background }) => {
          background("lookup", () => {
            void store.get("missing");
          });
        },
      }),
      { provide: [[Store, store]] },
    );
    try {
      const fault = await tested.waitForFault((candidate) => candidate.operation === "unawaited store.get");
      expect(fault.pluginId).toBe("careless");
      expect(Option.getOrUndefined(Cause.findErrorOption(fault.cause))).toBeInstanceOf(NotFound);
    } finally {
      await tested.close();
    }
  });

  test("setup is over when the calls it made have settled: a failed one fails activation", async () => {
    const first = definePlugin({ id: "first", setup: (_, { add }) => void add(Names, "ada") });
    const second = definePlugin({ id: "second", setup: (_, { add }) => void add(Names, "ada") });
    const error = await testPlugin(second, { with: [first] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginFault);
    expect((error as PluginFault).pluginId).toBe("second");
    expect((error as PluginFault).phase).toBe("activate");
  });

  test("a throwing setup fails activation, a marked throw as a typed failure", async () => {
    const defect = await testPlugin(definePlugin({ id: "defect", setup: async () => Promise.reject(new Error("nope")) })).catch((caught: unknown) => caught);
    expect((defect as PluginFault).phase).toBe("activate");
    expect(Option.isNone(Cause.findErrorOption((defect as PluginFault).cause))).toBe(true);
    const typed = await testPlugin(
      definePlugin({
        id: "typed",
        setup: async () => {
          throw fail(new NotFound("config"));
        },
      }),
    ).catch((caught: unknown) => caught);
    expect(Option.getOrUndefined(Cause.findErrorOption((typed as PluginFault).cause))).toBeInstanceOf(NotFound);
  });

  test("cleanups run after its signal aborts, last first, with its services still working; a failing one is reported", async () => {
    const { store } = makeStore({ a: "1" });
    const order: string[] = [];
    const tested = await testPlugin(
      definePlugin({
        id: "tidy",
        requires: { store: Store },
        setup: ({ store }, { onCleanup, signal }) => {
          onCleanup(async () => void order.push(`first: ${await store.get("a")}, aborted ${signal.aborted}`));
          onCleanup(() => {
            throw new Error("second cleanup failed");
          });
          onCleanup(() => void order.push("third"));
        },
      }),
      { provide: [[Store, store]] },
    );
    // Shutdown surfaces a cleanup's failure, as a disposal fault, after every cleanup has run.
    await expect(tested.close()).rejects.toThrow("second cleanup failed");
    expect(order).toEqual(["third", "first: 1, aborted true"]);
    expect((await tested.inspect()).state).toBe("closed");
  });

  test("observes and publishes events, an observer's failure its own fault", async () => {
    const heard: string[] = [];
    const tested = await testPlugin(
      definePlugin({
        id: "events",
        setup: (_, { observe, publish, background }) => {
          observe(Saved, (name) => {
            if (name === "bad") throw new Error("observer broke");
            heard.push(name);
          });
          background("announce", () => {
            publish(Saved, "bad");
            publish(Saved, "good");
          });
        },
      }),
    );
    try {
      const fault = await tested.waitForFault((candidate) => candidate.phase === "observe");
      expect(fault.operation).toBe("test/saved");
      await expect.poll(() => heard).toEqual(["good"]);
    } finally {
      await tested.close();
    }
  });

  test("runs background work with a signal that aborts when it stops", async () => {
    let signal: AbortSignal | undefined;
    const tested = await testPlugin(
      definePlugin({
        id: "worker",
        setup: (_, { background }) => {
          background("loop", (taskSignal) => {
            signal = taskSignal;
            return new Promise<void>((resolve) => taskSignal.addEventListener("abort", () => resolve()));
          });
        },
      }),
    );
    await expect.poll(() => signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await tested.close();
    expect(signal!.aborted).toBe(true);
  });

  test("owns an operation others intercept, and reads registries", async () => {
    const results: unknown[] = [];
    const owner = definePlugin({
      id: "owner",
      setup: (_, { invoke, items, add, background }) => {
        add(Names, "self");
        background("use", async () => {
          results.push(await invoke(Shout, "hi", async (value) => `${value} from the terminal`));
          results.push(items(Names).map((item) => `${item.item} by ${item.pluginId}`));
        });
      },
    });
    const effectful = defineEffectPlugin({
      id: "effectful",
      setup: (_, plugin) => plugin.on(Shout, (input, next) => Effect.map(next(input), (output) => output.toUpperCase())),
    });
    const tested = await testPlugin(owner, { with: [effectful] });
    try {
      await expect.poll(() => results.length).toBe(2);
      expect(results).toEqual(["HI FROM THE TERMINAL", ["self by owner"]]);
    } finally {
      await tested.close();
    }
  });

  test("an embedder chooses how setup receives its services and what it runs inside", async () => {
    const { store } = makeStore({ a: "1" });
    const log: string[] = [];
    const raw = definePlugin(
      {
        id: "raw",
        requires: { store: Store },
        setup: ({ store }) => {
          log.push(Effect.isEffect((store as unknown as StoreShape).get("a")) ? "raw store" : "plain store");
        },
      },
      {
        services: "raw",
        run: (setup, plugin) => {
          log.push(`entering ${plugin.id}`);
          const result = setup();
          log.push(`left ${plugin.id}`);
          return result;
        },
      },
    );
    await run(
      Effect.gen(function* () {
        yield* makeCore([defineEffectPlugin({ id: "store", provides: { store: Store }, setup: () => Effect.succeed({ store }) }), raw]);
      }),
    );
    expect(log).toEqual(["entering raw", "raw store", "left raw"]);
  });
});
