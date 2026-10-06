import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Cause, Context, Effect, Exit, Fiber, Option, Stream } from "effect";
import { definePlugin as defineEffectPlugin, Hook, Hooks, PluginContext, PluginFault, PluginStopped } from "../src/index.ts";
import { awaitable, definePlugin, followsAwait } from "../src/plain/index.ts";
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

  test("once stopped, a method that returned Effects refuses with a rejection; any other throws where it is called", async () => {
    const { store } = makeStore();
    let kept!: { readonly get: (key: string) => Promise<string>; readonly local: (key: string) => string };
    let plugin!: { readonly publish: (event: never, payload: never) => void; readonly items: (registry: never) => unknown };
    const tested = await testPlugin(
      definePlugin({
        id: "leaky",
        requires: { store: Store },
        setup: async ({ store }, context) => {
          kept = store;
          plugin = context as never;
          await store.get("a");
        },
      }),
      { provide: [[Store, store]] },
    );
    await tested.close();
    await expect(kept.get("a")).rejects.toBeInstanceOf(PluginStopped);
    expect(() => kept.local("a")).toThrow(PluginStopped);
    expect(() => plugin.items({ name: "test/none" } as never)).toThrow(PluginStopped);
    expect(() => plugin.publish({ name: "test/none" } as never, undefined as never)).not.toThrow();
  });
});
