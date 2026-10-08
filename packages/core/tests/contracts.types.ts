// Checked by core:check, not executed. These assertions protect the public seam.
import { Context, Effect, Layer, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { definePlugin as definePlainPlugin } from "../src/plain/index.ts";
import { definePlugin, Event, Events, Hook, Hooks, makeCore, makeLoader, PluginContext } from "../src/index.ts";
import type { CompositionError, PluginFault } from "../src/index.ts";

class Value extends Context.Service<Value, string>()("types/Value") {}
class Other extends Context.Service<Other, number>()("types/Other") {}
class Prefix extends Context.Service<Prefix, string>()("types/Prefix") {}

export function contracts() {
  const provider = definePlugin({ id: "value", provides: [Value], layer: Layer.succeed(Value, "value") });
  definePlugin({
    id: "missing-input",
    // @ts-expect-error Value must be declared in requires or supplied within the Layer.
    layer: Layer.effectDiscard(Value),
  });
  definePlugin({
    id: "wrong-output",
    provides: [Value],
    // @ts-expect-error The Layer does not provide Value.
    layer: Layer.succeed(Other, 1),
  });
  definePlugin({
    id: "valid-consumer",
    requires: [Value],
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Value;
        yield* PluginContext;
        yield* Hooks;
      }),
    ),
  });

  const Settings = Schema.Struct({ greeting: Schema.String });
  definePlugin({
    id: "configured",
    config: Settings,
    provides: [Value],
    layer: (config) => Layer.succeed(Value, config.greeting),
  });
  definePlugin({
    id: "misconfigured",
    config: Settings,
    provides: [Value],
    // @ts-expect-error The decoded config has no such field.
    layer: (config) => Layer.succeed(Value, config.missing),
  });

  const Tick = Event.make<{ readonly at: number }>("types/tick");
  definePlugin({
    id: "observer",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        yield* owner.observe(Tick, (payload) => Effect.log(payload.at));
        // @ts-expect-error Payload does not match the shared event token.
        yield* owner.observe(Tick, (payload) => Effect.log(payload.missing));
        yield* owner.background(
          "ticker",
          Effect.flatMap(Events, (events) => events.publish(Tick, { at: 0 })),
        );
      }),
    ),
  });

  const point = Hook.make<string, number, "rejected">("types/length");
  const calls = Effect.gen(function* () {
    const hooks = yield* Hooks;
    yield* hooks.invoke(point, "hello", (input) => Effect.succeed(input.length));
    // @ts-expect-error Input does not match the shared hook token.
    yield* hooks.invoke(point, 42, () => Effect.succeed(1));
    // @ts-expect-error Output does not match the shared hook token.
    yield* hooks.invoke(point, "hello", () => Effect.succeed("wrong"));
    const owner = yield* PluginContext;
    // @ts-expect-error Handler failures must satisfy the hook's declared error contract.
    yield* owner.on(point, () => Effect.fail("not-declared" as const));
  });

  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([provider]);
        const value: string = yield* core.run(Value);
        // @ts-expect-error Other remains an unsatisfied caller requirement.
        Effect.runPromise(core.run(Other));
        return value;
      }),
    ),
  );
  return calls;
}

// The setup form: named services in, named services out, config typed from its defaults or Schema.
export function setups() {
  const named = definePlugin({
    id: "named",
    config: { prefix: "#", limit: 3, tags: ["a"] },
    requires: { value: Value },
    provides: { other: Other },
    setup: function* ({ value }, { config, signal }) {
      const text: string = value;
      const prefix: string = config.prefix;
      const limit: number = config.limit;
      const tags: readonly string[] = config.tags;
      const aborted: boolean = signal.aborted;
      yield* PluginContext;
      yield* Hooks;
      return { other: text.length + prefix.length + limit + tags.length + Number(aborted) };
    },
  });
  definePlugin({
    id: "wrong-export",
    provides: { other: Other },
    // @ts-expect-error Other is a number.
    setup: () => Effect.succeed({ other: "text" }),
  });
  definePlugin({
    id: "undeclared",
    // @ts-expect-error Value is not declared in requires.
    setup: function* () {
      yield* Value;
    },
  });
  definePlugin({
    id: "unknown-config",
    config: { prefix: "#" },
    setup: (_, { config }) => {
      // @ts-expect-error The defaults name no such field.
      void config.missing;
      return Effect.void;
    },
  });
  definePlugin({
    id: "schema-config",
    config: Schema.Struct({ greeting: Schema.String }),
    setup: (_, { config }) => Effect.sync(() => void config.greeting.length),
  });
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([definePlugin({ id: "value", provides: { value: Value }, setup: () => Effect.succeed({ value: "v" }) }), named]);
        const other: number = yield* core.run(Other);
        // @ts-expect-error Nothing provides Prefix.
        Effect.runPromise(core.run(Prefix));
        return other;
      }),
    ),
  );
}

// Capabilities the application provides: checked against its layer, and satisfied in the core like a plugin's.
export function applications() {
  const consumer = definePlugin({
    id: "consumer",
    requires: [Value],
    provides: [Other],
    layer: Layer.effect(
      Other,
      Effect.map(Value, (value) => value.length),
    ),
  });
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([consumer], { provide: { provides: [Value], layer: Layer.succeed(Value, "v") } });
        const value: string = yield* core.run(Value);
        const other: number = yield* core.run(Other);
        // @ts-expect-error Nothing provides Prefix.
        Effect.runPromise(core.run(Prefix));
        return value.length + other;
      }),
    ),
  );
  // Its layer may use the core's built-ins.
  makeCore([], { provide: { provides: [Value], layer: Layer.effect(Value, Effect.as(Hooks, "v")) } });
  makeCore([], {
    // @ts-expect-error The layer does not provide Value.
    provide: { provides: [Value], layer: Layer.succeed(Other, 1) },
  });
  makeCore([], {
    // @ts-expect-error The layer may use only Hooks, Events, and Registries.
    provide: { provides: [Value], layer: Layer.effect(Value, Prefix) },
  });
  makeLoader({
    source: { resolve: () => Effect.die("unused") },
    composition: { plugins: {} },
    // @ts-expect-error The layer does not provide Value.
    provide: { provides: [Value], layer: Layer.succeed(Other, 1) },
  });
  // The layer's failure is makeCore's.
  const failing = makeCore([], { provide: { provides: [Value], layer: Layer.effect(Value, Effect.fail("down" as const)) } });
  const typed: Effect.Effect<unknown, "down" | CompositionError | PluginFault, Scope.Scope> = failing;
  // @ts-expect-error It can fail with the layer's error.
  const untyped: Effect.Effect<unknown, CompositionError | PluginFault, Scope.Scope> = failing;
  return [typed, untyped];
}

// The promise-based view of services: what plain plugins see.
const Point = Hook.make<string, number>("types/plain-point");
export function plainViews() {
  interface Key<A> {
    readonly name: string;
    readonly default: A;
  }
  class Cache extends Context.Service<
    Cache,
    {
      readonly get: (key: string) => Effect.Effect<string, Error>;
      readonly typed: <A>(key: Key<A>) => Effect.Effect<A>;
      readonly size: Effect.Effect<number>;
      readonly changes: Stream.Stream<string>;
      readonly local: (key: string) => number;
      readonly settings: { readonly limit: number; readonly when: Date };
      readonly "~plain"?: { readonly typed: <A>(key: Key<A>) => Promise<A> };
    }
  >()("types/Cache") {}
  definePlainPlugin({
    id: "plain-reader",
    config: { limit: 3 },
    requires: { cache: Cache, value: Value },
    provides: { other: Other },
    setup: async ({ cache, value }, { config, on, signal }) => {
      const text: string = await cache.get("a");
      const size: number = await cache.size();
      const typed: number = await cache.typed({ name: "n", default: 1 });
      const local: number = cache.local("a");
      const limit: number = cache.settings.limit + config.limit;
      const when: Date = cache.settings.when;
      for await (const change of cache.changes()) void change.length;
      // @ts-expect-error A promise, not a string.
      const wrong: string = cache.get("a");
      on(Point, (input, next) => (input === "" ? 0 : next(input)));
      // @ts-expect-error The handler must return the hook's output.
      on(Point, () => "not a number");
      void [text, size, typed, local, limit, when, wrong, value.length, signal];
      return { other: 1 };
    },
  });
  class Reader {
    read(): Effect.Effect<string> {
      return Effect.succeed("read");
    }
  }
  class Directory extends Context.Service<
    Directory,
    {
      readonly users: { readonly list: () => Effect.Effect<readonly string[]> };
      readonly index: Map<string, number>;
      readonly reader: Reader;
      readonly steps: readonly Effect.Effect<number>[];
      readonly a: { readonly b: { readonly c: { readonly read: () => Effect.Effect<string>; readonly d: { readonly read: () => Effect.Effect<string> } } } };
    }
  >()("types/Directory") {}
  definePlainPlugin({
    id: "plain-nested",
    requires: { directory: Directory },
    setup: async ({ directory }) => {
      // Nested services are promises, as the runtime makes them, class instances too; data inside is left as it is.
      const users: readonly string[] = await directory.users.list();
      const read: string = await directory.reader.read();
      const size: number = directory.index.size;
      // @ts-expect-error A promise, not an Effect.
      void directory.users.list().pipe;
      // Arrays are left as they are, and so is what lies four levels below the service.
      const step: Effect.Effect<number> = directory.steps[0]!;
      const third: string = await directory.a.b.c.read();
      const fourth: Effect.Effect<string> = directory.a.b.c.d.read();
      void [users, read, size, step, third, fourth];
    },
  });
  definePlainPlugin({
    id: "plain-wrong-export",
    provides: { other: Other },
    // @ts-expect-error Other is a number.
    setup: () => ({ other: "text" }),
  });
}
