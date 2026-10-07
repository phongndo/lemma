import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Cause, Context, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { definePlugin as defineEffectPlugin, Hook, Hooks, PluginContext, PluginFault, PluginStopped, Registry } from "../src/index.ts";
import { awaitable, definePlugin, fail, followsAwait } from "../src/plain/index.ts";
import type { Plain } from "../src/plain/index.ts";
import { testPlugin } from "../src/testing.ts";

class NotFound extends Error {
  readonly _tag = "NotFound";
}

interface StoreShape {
  readonly get: (key: string) => Effect.Effect<string, NotFound>;
  /** Takes a while: suspends before it answers. */
  readonly slowPut: (key: string, value: string) => Effect.Effect<void>;
  readonly wait: () => Effect.Effect<never>;
  readonly local: (key: string) => string;
  readonly ticks: Stream.Stream<number>;
  readonly few: () => Stream.Stream<number>;
  readonly broken: () => Stream.Stream<number, NotFound>;
}
class Store extends Context.Service<Store, StoreShape>()("test/LifetimeStore") {}

const makeStore = () => {
  const data = new Map<string, string>([["a", "1"]]);
  const events: string[] = [];
  const store: StoreShape = {
    get: (key) => (data.has(key) ? Effect.succeed(data.get(key)!) : Effect.fail(new NotFound(key))),
    slowPut: (key, value) => Effect.promise(turn).pipe(Effect.andThen(Effect.sync(() => void data.set(key, value)))),
    wait: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void events.push("wait interrupted")))),
    local: (key) => `local ${key}`,
    ticks: Stream.iterate(0, (n) => n + 1).pipe(Stream.ensuring(Effect.sync(() => void events.push("ticks ended")))),
    few: () => Stream.make(1, 2, 3),
    broken: () => Stream.fail(new NotFound("stream")),
  };
  return { store, data, events };
};

/** The next turn of the event loop: after what is pending now (a rejection, its unhandled-rejection report) has run. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Unhandled rejections in the test's process: none may happen. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => void process.off("unhandledRejection", onUnhandled));

describe("setup", () => {
  test("a failing call setup left behind fails the activation, never as an unhandled rejection", async () => {
    const { store } = makeStore();
    const careless = definePlugin({
      id: "careless",
      requires: { store: Store },
      setup: async ({ store }) => {
        void store.get("missing");
        await turn();
      },
    });
    const error = await testPlugin(careless, { provide: [[Store, store]] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginFault);
    expect(Option.getOrUndefined(Cause.findErrorOption((error as PluginFault).cause))).toBeInstanceOf(NotFound);
    await turn();
    await turn();
    expect(unhandled).toEqual([]);
  });

  test("a throwing setup leaves no unhandled rejection behind either", async () => {
    const { store } = makeStore();
    const thrower = definePlugin({
      id: "thrower",
      requires: { store: Store },
      setup: async ({ store }) => {
        void store.get("missing");
        throw new Error("setup broke");
      },
    });
    await expect(testPlugin(thrower, { provide: [[Store, store]] })).rejects.toBeInstanceOf(PluginFault);
    await turn();
    await turn();
    expect(unhandled).toEqual([]);
  });

  test("setup does not wait for what a background task calls", async () => {
    const { store } = makeStore();
    const poller = definePlugin({
      id: "poller",
      requires: { store: Store },
      deadlines: { activate: "1 second" },
      setup: async ({ store }, { background }) => {
        background("poll", () => store.wait());
        await turn();
      },
    });
    const tested = await testPlugin(poller, { provide: [[Store, store]] });
    expect((await tested.inspect()).plugins.find((plugin) => plugin.id === "poller")?.state).toBe("active");
    await tested.close();
  });

  test("setup does not wait for calls a loop it started keeps making", async () => {
    const { store } = makeStore();
    let looping = true;
    const looper = definePlugin({
      id: "looper",
      requires: { store: Store },
      deadlines: { activate: "1 second" },
      setup: async ({ store }, { onCleanup }) => {
        const loop = async () => {
          while (looping) await store.slowPut("tick", "1");
        };
        void loop();
        onCleanup(() => void (looping = false));
      },
    });
    const tested = await testPlugin(looper, { provide: [[Store, store]] });
    expect((await tested.inspect()).plugins.find((plugin) => plugin.id === "looper")?.state).toBe("active");
    await tested.close();
  });

  test("a failed setup aborts its signal before its cleanups run, so one waiting on it ends", async () => {
    let sawAborted: boolean | undefined;
    const failing = definePlugin({
      id: "failing",
      deadlines: { dispose: "1 second" },
      setup: async (_, { signal, onCleanup }) => {
        const work = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        onCleanup(async () => {
          await work;
          sawAborted = signal.aborted;
        });
        throw new Error("no");
      },
    });
    const effectFailing = defineEffectPlugin({
      id: "effect-failing",
      setup: function* (_, plugin) {
        yield* Effect.addFinalizer(() => Effect.sync(() => void (sawAborted = sawAborted && plugin.signal.aborted)));
        return yield* Effect.fail("no");
      },
    });
    await expect(testPlugin(failing)).rejects.toBeInstanceOf(PluginFault);
    expect(sawAborted).toBe(true);
    await expect(testPlugin(effectFailing)).rejects.toBeInstanceOf(PluginFault);
    expect(sawAborted).toBe(true);
  });
});

describe("cleanup", () => {
  test("can still use services that take a while", async () => {
    const { store, data } = makeStore();
    const saver = definePlugin({
      id: "saver",
      requires: { store: Store },
      setup: ({ store }, { onCleanup }) => {
        onCleanup(() => store.slowPut("saved", "yes"));
      },
    });
    const tested = await testPlugin(saver, { provide: [[Store, store]] });
    await tested.close();
    expect(data.get("saved")).toBe("yes");
  });

  test("what a cleanup acquires lasts until every cleanup is done", async () => {
    const order: string[] = [];
    class Files extends Context.Service<Files, { readonly open: () => Effect.Effect<{ readonly write: () => boolean }, never, Scope.Scope> }>()("test/Files") {}
    const files = {
      open: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            let open = true;
            order.push("opened");
            return { handle: { write: () => open }, close: () => void (open = false) };
          }),
          (file) => Effect.sync(() => (file.close(), void order.push("closed"))),
        ).pipe(Effect.map((file) => file.handle)),
    };
    const tested = await testPlugin(
      definePlugin({
        id: "writer",
        requires: { files: Files },
        setup: ({ files }, { onCleanup }) => {
          let file: { readonly write: () => boolean } | undefined;
          // Cleanups run last first: this one writes after the other opened.
          onCleanup(() => void order.push(`write: ${file?.write()}`));
          onCleanup(async () => void (file = await files.open()));
        },
      }),
      { provide: [[Files, files]] },
    );
    await tested.close();
    expect(order).toEqual(["opened", "write: true", "closed"]);
  });
});

describe("streams", () => {
  test("end when the operation that read them is interrupted", async () => {
    const { store, events } = makeStore();
    const Read = Hook.make<string, string>("test/read-ticks");
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    const reader = definePlugin({
      id: "ticker",
      requires: { store: Store },
      setup: ({ store }, { on }) => {
        on(Read, async (input) => {
          for await (const tick of store.ticks()) if (tick === 3) started();
          return input;
        });
      },
    });
    const tested = await testPlugin(reader, { provide: [[Store, store]] });
    try {
      await tested.run(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Read, "x", Effect.succeed)));
          yield* Effect.promise(() => reading);
          yield* Fiber.interrupt(fiber);
        }),
      );
      await expect.poll(() => events).toContain("ticks ended");
    } finally {
      await tested.close();
    }
  });

  test("fail with their typed error, which stays a failure when rethrown", async () => {
    const { store } = makeStore();
    const Read = Hook.make<string, number, NotFound>("test/read-broken");
    const tested = await testPlugin(
      definePlugin({
        id: "broken-reader",
        requires: { store: Store },
        setup: ({ store }, { on }) => {
          on(Read, async () => {
            let sum = 0;
            for await (const n of store.broken()) sum += n;
            return sum;
          });
        },
      }),
      { provide: [[Store, store]] },
    );
    try {
      const exit = await tested.run(Effect.exit(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Read, "x", () => Effect.succeed(0)))));
      expect(Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(NotFound);
    } finally {
      await tested.close();
    }
  });

  test("end where they are once the plugin stops: what was buffered is not read", async () => {
    const { store } = makeStore();
    let iterator!: AsyncIterator<number>;
    const tested = await testPlugin(
      definePlugin({
        id: "buffered",
        requires: { store: Store },
        setup: async ({ store }) => {
          iterator = store.few()[Symbol.asyncIterator]();
          expect(await iterator.next()).toEqual({ done: false, value: 1 });
        },
      }),
      { provide: [[Store, store]] },
    );
    await tested.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});

describe("context", () => {
  const Origin = Context.Reference<string | undefined>("test/LifetimeOrigin", { defaultValue: () => undefined });
  class Asker extends Context.Service<Asker, { readonly ask: () => Effect.Effect<string | undefined> }>()("test/LifetimeAsker") {}
  class Who extends Context.Service<Who, { readonly who: () => Effect.Effect<string, never, PluginContext> }>()("test/Who") {}

  test("a handler that is not async keeps the operation's context in its promise chains", async () => {
    const Ask = Hook.make<string, string>("test/chain");
    const tested = await testPlugin(
      definePlugin({
        id: "chainer",
        requires: { asker: Asker },
        setup: ({ asker }, { on }) => {
          on(Ask, () => Promise.resolve().then(() => asker.ask().then((origin) => `then:${origin}`)));
        },
      }),
      { provide: [[Asker, { ask: () => Effect.service(Origin) }]] },
    );
    try {
      const asked = await tested.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Ask, "x", Effect.succeed)).pipe(Effect.provideService(Origin, "turn:9")));
      expect(asked).toBe(followsAwait ? "then:turn:9" : "then:undefined");
    } finally {
      await tested.close();
    }
  });

  test("a callback another plugin runs still calls as its own plugin, with or without a plugin context around it", async () => {
    let callback!: () => Promise<string>;
    const owner = definePlugin({
      id: "owner",
      requires: { who: Who },
      setup: ({ who }) => {
        callback = async () => who.who();
      },
    });
    const tested = await testPlugin(owner, { provide: [[Who, { who: () => Effect.map(PluginContext, (context) => context.id) }]] });
    try {
      // From a task with no plugin context at all.
      expect(await tested.run(awaitable(() => callback()))).toBe("owner");
      // From inside another plugin's context.
      const caller = { id: "caller" } as Context.Service.Shape<typeof PluginContext>;
      expect(await tested.run(awaitable(() => callback()).pipe(Effect.provideService(PluginContext, caller)))).toBe("owner");
    } finally {
      await tested.close();
    }
  });

  test("a handler registered during one operation does not keep its references for the next", async () => {
    const Ask = Hook.make<string, string | undefined>("test/lazy-ask");
    const Register = Hook.make<string, string>("test/lazy-register");
    const tested = await testPlugin(
      definePlugin({
        id: "lazy",
        requires: { asker: Asker },
        setup: ({ asker }, { on }) => {
          on(Register, (input) => {
            on(Ask, () => asker.ask());
            return input;
          });
        },
      }),
      { provide: [[Asker, { ask: () => Effect.service(Origin) }]] },
    );
    try {
      const invoke = <I, O>(hook: Hook<I, O>, input: I, origin: string) =>
        tested.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(hook, input, () => Effect.die("no terminal"))).pipe(Effect.provideService(Origin, origin)));
      await invoke(Register, "x", "first");
      await turn();
      expect(await invoke(Ask, "y", "second")).toBe("second");
    } finally {
      await tested.close();
    }
  });

  test("a call an in-place handler makes after it returned stops when its operation is interrupted", async () => {
    const { store, events } = makeStore();
    const Wait = Hook.make<string, string>("test/late-wait");
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => (started = resolve));
    const tested = await testPlugin(
      definePlugin({
        id: "late",
        requires: { store: Store },
        setup: ({ store }, { on }) => {
          on(Wait, (input, next) => {
            queueMicrotask(() => {
              void store.wait().catch(() => undefined);
              started();
            });
            return next(input);
          });
        },
      }),
      { provide: [[Store, store]] },
    );
    try {
      await tested.run(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Wait, "x", () => Effect.never)));
          yield* Effect.promise(() => waiting);
          yield* Fiber.interrupt(fiber);
        }),
      );
      await expect.poll(() => events).toContain("wait interrupted");
    } finally {
      await tested.close();
    }
  });

  test("a thrown value that is not an object, and that nobody failed with, is a defect", async () => {
    const thrown = await Effect.runPromiseExit(
      awaitable(async (): Promise<number> => {
        throw "boom";
      }),
    );
    expect(Exit.isFailure(thrown) && Cause.hasDies(thrown.cause)).toBe(true);
    const failed = await Effect.runPromiseExit(
      awaitable(async (): Promise<number> => {
        throw fail("expected");
      }),
    );
    expect(Exit.isFailure(failed) && Option.getOrUndefined(Cause.findErrorOption(failed.cause))).toBe("expected");
  });

  test("a typed failure that is not an object stays a failure through promise code", async () => {
    const Pass = Hook.make<string, string, string>("test/primitive");
    const tested = await testPlugin(definePlugin({ id: "pass", setup: (_, { on }) => on(Pass, async (input, next) => await next(input)) }));
    try {
      const exit = await tested.run(Effect.exit(Effect.flatMap(Hooks, (hooks) => hooks.invoke(Pass, "x", () => Effect.fail("typed error")))));
      expect(Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe("typed error");
    } finally {
      await tested.close();
    }
  });
});

describe("services as promises", () => {
  class Nested extends Context.Service<
    Nested,
    {
      readonly users: { readonly list: () => Effect.Effect<readonly string[]> };
      readonly index: Map<string, number>;
      readonly since: Date;
    }
  >()("test/Nested") {}
  class Counter {
    #count = 0;
    get count() {
      return this.#count;
    }
    add(): Effect.Effect<number> {
      return Effect.sync(() => ++this.#count);
    }
  }
  class Counting extends Context.Service<Counting, Counter>()("test/Counting") {}

  test("nested services are converted; data inside (a Map, a Date) is left as it is; a class keeps its getters", async () => {
    const seen: unknown[] = [];
    const tested = await testPlugin(
      definePlugin({
        id: "nested",
        requires: { nested: Nested, counting: Counting },
        setup: async ({ nested, counting }) => {
          seen.push(await nested.users.list(), nested.index instanceof Map && nested.index.size, nested.since instanceof Date && nested.since.getTime());
          seen.push(await counting.add(), counting.count);
        },
      }),
      {
        provide: [
          [Nested, { users: { list: () => Effect.succeed(["ada"]) }, index: new Map([["a", 1]]), since: new Date(5) }],
          [Counting, new Counter()],
        ],
      },
    );
    await tested.close();
    expect(seen).toEqual([["ada"], 1, 5, 1, 1]);
  });

  test("a frozen class instance is converted too", async () => {
    class Frozen {
      readonly read = () => Effect.succeed("frozen");
      constructor() {
        Object.freeze(this);
      }
    }
    class Freezer extends Context.Service<Freezer, Frozen>()("test/Freezer") {}
    let read: string | undefined;
    const tested = await testPlugin(
      definePlugin({
        id: "frozen",
        requires: { freezer: Freezer },
        setup: async ({ freezer }) => void (read = await freezer.read()),
      }),
      { provide: [[Freezer, new Frozen()]] },
    );
    await tested.close();
    expect(read).toBe("frozen");
  });

  test("nested class instances are converted; arrays and what lies four levels down are left as they are", async () => {
    class Reader {
      read(): Effect.Effect<string> {
        return Effect.succeed("read");
      }
    }
    const deep = Effect.succeed("deep");
    class Deep extends Context.Service<
      Deep,
      {
        readonly reader: Reader;
        readonly steps: readonly Effect.Effect<number>[];
        readonly a: { readonly b: { readonly c: { readonly read: () => Effect.Effect<string>; readonly d: { readonly read: () => Effect.Effect<string> } } } };
      }
    >()("test/Deep") {}
    const seen: unknown[] = [];
    const steps = [Effect.succeed(1)];
    const tested = await testPlugin(
      definePlugin({
        id: "deep",
        requires: { deep: Deep },
        setup: async ({ deep }) => {
          seen.push(
            await deep.reader.read(),
            deep.reader instanceof Reader,
            deep.steps === steps,
            await deep.a.b.c.read(),
            Effect.isEffect(deep.a.b.c.d.read()),
          );
        },
      }),
      { provide: [[Deep, { reader: new Reader(), steps, a: { b: { c: { read: () => deep, d: { read: () => deep } } } } }]] },
    );
    await tested.close();
    expect(seen).toEqual(["read", true, true, "deep", true]);
  });

  test("tokens inside a service are the tokens; an object is one view, and reads what it holds now", async () => {
    const Items = Registry.make<string>("test/items", { key: (item) => item });
    const Ping = Hook.make<string, string>("test/ping");
    const state = { count: 1, bump: () => Effect.sync(() => ++state.count) };
    class Holder extends Context.Service<
      Holder,
      {
        readonly tokens: { readonly items: typeof Items; readonly ping: typeof Ping };
        readonly state: typeof state;
        readonly same: typeof state;
        readonly current: typeof state;
      }
    >()("test/Holder") {}
    const seen: unknown[] = [];
    const tested = await testPlugin(
      definePlugin({
        id: "holder",
        requires: { holder: Holder },
        setup: async ({ holder }) => {
          seen.push(holder.tokens.items === Items, holder.tokens.ping === Ping);
          seen.push(holder.state === holder.same, holder.current === holder.current, holder.state.bump === holder.state.bump);
          await holder.state.bump();
          seen.push(holder.state.count);
        },
      }),
      {
        provide: [
          [
            Holder,
            {
              tokens: { items: Items, ping: Ping },
              state,
              same: state,
              get current() {
                return state;
              },
            },
          ],
        ],
      },
    );
    await tested.close();
    expect(seen).toEqual([true, true, true, true, true, 2]);
  });

  test("once stopped, nothing a service offers throws where leaked work would not catch it", async () => {
    const { store } = makeStore();
    let kept!: Plain<StoreShape>;
    let plugin!: { readonly publish: (event: never, payload: never) => void; readonly items: (registry: never) => unknown };
    const tested = await testPlugin(
      definePlugin({
        id: "leaky",
        requires: { store: Store },
        setup: async ({ store }, context) => {
          kept = store;
          plugin = context as never;
          await store.get("a");
          store.local("a");
        },
      }),
      { provide: [[Store, store]] },
    );
    await tested.close();
    // A method that returned promises, or one never called, rejects; one that returned values throws, as it would fail.
    await expect(kept.get("a")).rejects.toBeInstanceOf(PluginStopped);
    await expect(kept.slowPut("a", "b")).rejects.toBeInstanceOf(PluginStopped);
    expect(() => kept.local("a")).toThrow(PluginStopped);
    // A stream is still an iterable, which refuses when read.
    const read = async () => {
      for await (const n of kept.few()) void n;
    };
    await expect(read()).rejects.toBeInstanceOf(PluginStopped);
    expect(() => plugin.items({ name: "test/none" } as never)).toThrow(PluginStopped);
    expect(() => plugin.publish({ name: "test/none" } as never, undefined as never)).not.toThrow();
  });
});
