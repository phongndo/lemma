import { describe, expect, test } from "vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Result, Stream, Tracer } from "effect";
import {
  definePlugin as defineEffectPlugin,
  Event,
  Hook,
  Hooks,
  makeCore,
  makeLoader,
  PluginContext,
  PluginFault,
  PluginStopped,
  Registry,
  reportUnhandled,
} from "../src/index.ts";
import type { Plugin, Unhandled } from "../src/index.ts";
import { followsAwait } from "../src/internal/current.ts";
import { awaitable, definePlugin, fail } from "../src/plain/index.ts";
import type { PlainSetup } from "../src/plain/index.ts";
import { testPlugin } from "../src/testing.ts";
import { run } from "./support.ts";

/**
 * Resolves once a witness timer of `ms` has fired `times` times: by then a timer of that period that outlived its plugin
 * would have run too, however loaded the machine is.
 */
const outlast = async (ms: number, times = 3) => {
  let fired = 0;
  const witness = setInterval(() => fired++, ms);
  await expect.poll(() => fired).toBeGreaterThanOrEqual(times);
  clearInterval(witness);
};

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

  test("provides services to Effect plugins, with awaitable where the contract returns Effects", async () => {
    const greeter = definePlugin({
      id: "greeter",
      config: { greeting: "Hello" },
      provides: { greeter: Greeter },
      setup: (_, { config }) => ({ greeter: { greet: (name: string) => awaitable(async () => `${config.greeting}, ${name}`) } }),
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

  test("after and every run as the plugin's: cancelled when asked, gone when it stops, and a failing run its fault", async () => {
    const seen: string[] = [];
    let ticks = 0;
    let api: PlainSetup<unknown> | undefined;
    const tested = await testPlugin(
      definePlugin({
        id: "timers",
        setup: (_, plugin) => {
          api = plugin;
          plugin.after(5, () => void seen.push("after"));
          plugin.after(5, () => void seen.push("cancelled"))();
          plugin.every(
            5,
            () => {
              ticks++;
              if (ticks === 2) throw new Error("second tick");
            },
            { name: "ticker" },
          );
        },
      }),
    );
    await expect.poll(() => seen).toEqual(["after"]);
    // The failing tick is reported, and the timer goes on.
    const fault = await tested.waitForFault((candidate) => candidate.operation === "ticker");
    expect(fault.pluginId).toBe("timers");
    await expect.poll(() => ticks).toBeGreaterThan(3);
    await tested.close();
    const stopped = ticks;
    api!.after(1, () => void seen.push("late"));
    await outlast(5);
    expect([ticks, seen]).toEqual([stopped, ["after"]]);
  });

  test("an error nothing handled is the fault of the plugin whose work raised it, as async-local storage follows that work", async () => {
    expect(followsAwait).toBe(true);
    const heard: Unhandled[] = [];
    const tested = await testPlugin(
      definePlugin({
        id: "stray",
        setup: () => {
          // What a process's handlers hear from work the plugin left running: a timer's throw, a promise's rejection.
          setTimeout(() => void heard.push(reportUnhandled(new Error("stray timer"))), 1);
          void Promise.resolve().then(() => void heard.push(reportUnhandled(new Error("stray promise"))));
        },
      }),
    );
    await expect.poll(() => heard.length).toBe(2);
    expect(heard).toEqual([
      { kind: "fault", pluginId: "stray" },
      { kind: "fault", pluginId: "stray" },
    ]);
    const fault = await tested.waitForFault((candidate) => candidate.operation === "unhandled");
    expect(fault.pluginId).toBe("stray");
    await tested.close();
    // A call a stopped plugin made, refused, is no fault; an error from no plugin's work is nobody's.
    expect(reportUnhandled(new PluginStopped({ pluginId: "stray", operation: "invoke" }))).toEqual({ kind: "stopped", pluginId: "stray" });
    expect(reportUnhandled(new Error("elsewhere"))).toEqual({ kind: "unknown" });
  });

  describe("an error Effect-written work leaves behind is no plugin's, not the promise-based plugin's that called it", () => {
    const Leak = Hook.make<string, string>("test/leak");
    /** An Effect-written handler that forgets a timer, which throws: Effect code carries no async-local context. */
    const leaking = (heard: Unhandled[]) =>
      defineEffectPlugin({
        id: "leaky",
        layer: Layer.effectDiscard(
          Effect.flatMap(PluginContext, (owner) =>
            owner.on(Leak, (input, next) =>
              Effect.andThen(
                Effect.sync(() => void setTimeout(() => void heard.push(reportUnhandled(new Error("leaky's stray timer"))), 1)),
                next(input),
              ),
            ),
          ),
        ),
      });

    test("invoked from the plugin's own work", async () => {
      const heard: Unhandled[] = [];
      let api: PlainSetup<unknown> | undefined;
      const tested = await testPlugin(definePlugin({ id: "caller", setup: (_, plugin) => void (api = plugin) }), { with: [leaking(heard)] });
      // Its own work: an action, as an event handler of its would be.
      api!.action("go", () => api!.invoke(Leak, "x", (value) => value))();
      await expect.poll(() => heard.length).toBe(1);
      expect(heard).toEqual([{ kind: "unknown" }]);
      expect(tested.faults.filter((fault) => fault.pluginId === "caller")).toEqual([]);
      await tested.close();
    });

    test("as the rest of a hook's chain its handler awaits", async () => {
      const heard: Unhandled[] = [];
      const upstream = definePlugin({
        id: "upstream",
        setup: (_, { on }) => on(Leak, async (input, next) => await next(input), { order: -1 }),
      });
      const tested = await testPlugin(upstream, { with: [leaking(heard)] });
      expect(await tested.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Leak, "x", Effect.succeed)))).toBe("x");
      await expect.poll(() => heard.length).toBe(1);
      expect(heard).toEqual([{ kind: "unknown" }]);
      expect(tested.faults.filter((fault) => fault.pluginId === "upstream")).toEqual([]);
      await tested.close();
    });

    test("while the plugin's own stray work, after a call into Effect code, is still its own", async () => {
      const heard: Unhandled[] = [];
      let api: PlainSetup<unknown> | undefined;
      const tested = await testPlugin(definePlugin({ id: "caller", setup: (_, plugin) => void (api = plugin) }), { with: [leaking(heard)] });
      api!.action("go", async () => {
        await api!.invoke(Leak, "x", (value) => value);
        setTimeout(() => void heard.push(reportUnhandled(new Error("caller's stray timer"))), 1);
      })();
      await expect.poll(() => heard.length).toBe(2);
      expect(heard).toEqual(expect.arrayContaining([{ kind: "unknown" }, { kind: "fault", pluginId: "caller" }]));
      await tested.close();
    });
  });

  test("trace runs work in a span of its plugin's, under the work that called it", async () => {
    const spans: Tracer.Span[] = [];
    const Traced = Hook.make<string, string>("test/traced");
    let traced: unknown;
    await Effect.runPromise(
      Tracer.Tracer.use((base) => {
        const tracer = Tracer.make({
          ...(base.context === undefined ? {} : { context: base.context }),
          span(options) {
            const span = base.span(options);
            spans.push(span);
            return span;
          },
        });
        return Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeCore([
              definePlugin({
                id: "tracing",
                version: "2.0.0",
                setup: (_, plugin) =>
                  plugin.on(Traced, async (input, next) => {
                    traced = await plugin.trace("tracing.work", async (signal) => `${input} ${signal.aborted ? "aborted" : "ran"}`);
                    return next(input);
                  }),
              }),
            ]);
            yield* core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Traced, "x", Effect.succeed))).pipe(Effect.withSpan("request"));
          }),
        ).pipe(Effect.withTracer(tracer));
      }),
    );
    expect(traced).toBe("x ran");
    const handler = spans.find((span) => span.name === "core.hook" && span.attributes.get("plugin.id") === "tracing")!;
    const work = spans.find((span) => span.name === "tracing.work")!;
    expect(work.attributes.get("plugin.id")).toBe("tracing");
    expect(work.attributes.get("plugin.version")).toBe("2.0.0");
    expect(Option.getOrThrow(work.parent).spanId).toBe(handler.spanId);
  });

  test("listen attaches until the plugin stops, to an EventTarget or an emitter; a failing listener is its fault", async () => {
    const target = new EventTarget();
    const listeners = new Set<(value: string) => void>();
    const emitter = {
      on: (_: string, listener: (value: string) => void) => listeners.add(listener),
      off: (_: string, listener: (value: string) => void) => listeners.delete(listener),
    };
    const heard: string[] = [];
    const tested = await testPlugin(
      definePlugin({
        id: "listener",
        setup: (_, { listen }) => {
          listen(target, "ping", () => void heard.push("ping"));
          listen(target, "boom", () => Promise.reject(new Error("listener rejected")));
          const remove = listen(target, "removed", () => void heard.push("removed"));
          remove();
          listen(emitter, "data", (value: string) => void heard.push(value));
          listen(emitter, "data", (value: string) => void heard.push(`once ${value}`), { once: true });
        },
      }),
    );
    target.dispatchEvent(new globalThis.Event("ping"));
    target.dispatchEvent(new globalThis.Event("removed"));
    for (const listener of listeners) listener("emitted");
    expect(listeners.size).toBe(1);
    target.dispatchEvent(new globalThis.Event("boom"));
    const fault = await tested.waitForFault((candidate) => candidate.operation === "listen boom");
    expect(fault.pluginId).toBe("listener");
    await tested.close();
    target.dispatchEvent(new globalThis.Event("ping"));
    expect([heard, listeners.size]).toEqual([["ping", "emitted", "once emitted"], 0]);
  });

  test("task resolves with its result, or undefined when it failed (its fault) or the plugin stopped; setup does not wait", async () => {
    let results: Promise<unknown>[] = [];
    let aborted = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tested = await testPlugin(
      definePlugin({
        id: "tasks",
        setup: (_, { task }) => {
          results = [
            task("answer", async () => 42),
            task("broken", async () => {
              throw new Error("task failed");
            }),
            // Never ends on its own: setup is over without it, and stopping aborts it.
            task("held", (signal) => {
              signal.addEventListener("abort", () => void (aborted = true));
              return new Promise(() => {});
            }),
            task("after release", async () => {
              await held;
              return "released";
            }),
          ];
        },
      }),
    );
    expect(await results[0]).toBe(42);
    expect(await results[1]).toBeUndefined();
    expect((await tested.waitForFault((candidate) => candidate.operation === "broken")).pluginId).toBe("tasks");
    release();
    expect(await results[3]).toBe("released");
    await tested.close();
    expect([await results[2], aborted]).toEqual([undefined, true]);
  });

  test("action does nothing once the plugin has stopped, and its throw or rejection is the plugin's fault", async () => {
    const calls: string[] = [];
    let api: PlainSetup<unknown> | undefined;
    const tested = await testPlugin(definePlugin({ id: "actions", setup: (_, plugin) => void (api = plugin) }));
    const save = api!.action("save", (value: string) => void calls.push(value));
    const throws = api!.action("throws", () => {
      throw new Error("handler threw");
    });
    const rejects = api!.action("rejects", () => Promise.reject(new Error("handler rejected")));
    save("first");
    throws();
    rejects();
    expect((await tested.waitForFault((candidate) => candidate.operation === "throws")).pluginId).toBe("actions");
    expect((await tested.waitForFault((candidate) => candidate.operation === "rejects")).pluginId).toBe("actions");
    await tested.close();
    save("after stop");
    expect(calls).toEqual(["first"]);
  });

  test("action runs as its own plugin's work wherever it is called, and a call refused as a plugin stopped is no fault", async () => {
    const heard: Unhandled[] = [];
    let api: PlainSetup<unknown> | undefined;
    const tested = await testPlugin(definePlugin({ id: "handling", setup: (_, plugin) => void (api = plugin) }));
    const handle = api!.action("handle", () => void heard.push(reportUnhandled(new Error("in the handler"))));
    // Called from another plugin's work (its emit, say), the handler is still this plugin's.
    const caller = await testPlugin(definePlugin({ id: "caller", setup: () => handle() }));
    expect(heard).toEqual([{ kind: "fault", pluginId: "handling" }]);
    api!.action("refused", () => Promise.reject(new PluginStopped({ pluginId: "elsewhere", operation: "invoke" })))();
    api!.action("broken", () => Promise.reject(new Error("broken")))();
    await tested.waitForFault((candidate) => candidate.operation === "broken");
    expect(tested.faults.map((fault) => fault.operation)).not.toContain("refused");
    await caller.close();
    await tested.close();
  });

  test("asked as its plugin stops (a cleanup's flush), task runs then; listen, after, and action do nothing", async () => {
    const listeners = new Set<() => void>();
    const emitter = { on: (_: string, listener: () => void) => listeners.add(listener), off: (_: string, listener: () => void) => listeners.delete(listener) };
    const late: string[] = [];
    let flushed: unknown;
    const tested = await testPlugin(
      definePlugin({
        id: "flusher",
        setup: (_, { onCleanup, task, listen, after, action }) => {
          onCleanup(async () => {
            flushed = await task("flush", async () => "saved");
            // Its cleanups are running: nothing would end these.
            listen(emitter, "late", () => void late.push("listened"));
            after(1, () => void late.push("timer"));
            action("late", () => void late.push("action"))();
          });
        },
      }),
    );
    await tested.close();
    expect(flushed).toBe("saved");
    await outlast(1);
    expect([late, listeners.size]).toEqual([[], 0]);
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
        services: (services) => services,
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
