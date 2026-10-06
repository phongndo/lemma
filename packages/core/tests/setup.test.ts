import { describe, expect, test } from "vitest";
import { Cause, Context, Effect, Exit, Option, Schema } from "effect";
import { CapabilityMismatch, CompositionError, configSchema, definePlugin, Hook, Hooks, makeCore, PluginFault } from "../src/index.ts";
import { failure, run } from "./support.ts";

class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}
class Greeter extends Context.Service<Greeter, { readonly greet: (name: string) => string }>()("test/Greeter") {}
const Shout = Hook.make<string, string>("test/shout");

const greeting = definePlugin({
  id: "greeting",
  config: { text: "Hello" },
  provides: { greeting: Greeting },
  setup: (_, { config }) => Effect.succeed({ greeting: config.text }),
});

const greeter = definePlugin({
  id: "greeter",
  requires: { greeting: Greeting },
  provides: { greeter: Greeter },
  setup: ({ greeting }) => Effect.succeed({ greeter: { greet: (name: string) => `${greeting}, ${name}` } }),
});

describe("a plugin written as a setup", () => {
  test("receives what it requires by name and provides what it returns by name", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([greeter, greeting]);
        expect(yield* core.run(Effect.map(Greeter, (service) => service.greet("Ada")))).toBe("Hello, Ada");
        const snapshot = yield* core.inspect;
        expect(snapshot.plugins.map((plugin) => [plugin.id, plugin.requires, plugin.provides])).toEqual([
          ["greeting", [], ["test/Greeting"]],
          ["greeter", ["test/Greeting"], ["test/Greeter"]],
        ]);
      }),
    );
  });

  test("its config is decoded from defaults: absent fields take them, given ones are checked", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([greeter, greeting], { configs: { greeting: { text: "Hi" } } });
        expect(yield* core.run(Effect.map(Greeter, (service) => service.greet("Ada")))).toBe("Hi, Ada");
      }),
    );
    const exit = await Effect.runPromiseExit(Effect.scoped(makeCore([greeting], { configs: { greeting: { text: 3 } } })));
    const error = failure(exit);
    expect(error).toBeInstanceOf(CompositionError);
    expect((error as CompositionError).reason).toBe("InvalidConfig");
    expect((error as CompositionError).path).toEqual(["text"]);
  });

  test("registers through the plugin context and the built-ins, released when it stops", async () => {
    let core!: Effect.Success<ReturnType<typeof makeCore>>;
    const loud = definePlugin({
      id: "loud",
      setup: function* (_, plugin) {
        yield* plugin.on(Shout, (input, next) => Effect.map(next(input), (output) => output.toUpperCase()));
        const hooks = yield* Hooks;
        expect(yield* hooks.invoke(Shout, "staged", Effect.succeed)).toBe("staged");
      },
    });
    const shout = Effect.flatMap(Hooks, (hooks) => hooks.invoke(Shout, "hi", Effect.succeed));
    await run(
      Effect.gen(function* () {
        core = yield* makeCore([loud]);
        expect(yield* core.run(shout)).toBe("HI");
      }),
    );
    await run(
      Effect.gen(function* () {
        const empty = yield* makeCore([]);
        expect(yield* empty.run(shout)).toBe("hi");
      }),
    );
  });

  test("its signal aborts when it stops, before its own finalizers run", async () => {
    const seen: string[] = [];
    let signal!: AbortSignal;
    const worker = definePlugin({
      id: "worker",
      setup: function* (_, plugin) {
        signal = plugin.signal;
        signal.addEventListener("abort", () => seen.push("aborted"));
        yield* Effect.addFinalizer(() => Effect.sync(() => seen.push(`finalizer saw aborted=${signal.aborted}`)));
      },
    });
    await run(
      Effect.gen(function* () {
        yield* makeCore([worker]);
        expect(signal.aborted).toBe(false);
      }),
    );
    expect(seen).toEqual(["aborted", "finalizer saw aborted=true"]);
  });

  test("a failing setup fails its activation, attributed, with its signal aborted", async () => {
    let signal!: AbortSignal;
    const broken = definePlugin({
      id: "broken",
      setup: function* (_, plugin) {
        signal = plugin.signal;
        return yield* Effect.fail("no database");
      },
    });
    const error = failure(await Effect.runPromiseExit(Effect.scoped(makeCore([broken]))));
    expect(error).toBeInstanceOf(PluginFault);
    expect((error as PluginFault).pluginId).toBe("broken");
    expect((error as PluginFault).phase).toBe("activate");
    expect(signal.aborted).toBe(true);
  });

  test("a provided name it does not return is a capability mismatch", async () => {
    const forgetful = definePlugin({ id: "forgetful", provides: { greeting: Greeting }, setup: () => Effect.succeed({}) as never });
    const exit = await Effect.runPromiseExit(Effect.scoped(makeCore([forgetful])));
    expect(Exit.isFailure(exit)).toBe(true);
    const fault = failure(exit) as PluginFault;
    const mismatch = Option.getOrThrow(Cause.findErrorOption(fault.cause));
    expect(mismatch).toBeInstanceOf(CapabilityMismatch);
    expect((mismatch as CapabilityMismatch).missing).toEqual(["test/Greeting"]);
  });

  test("a definition with both a layer and a setup, or a setup naming a list, is refused where it is written", () => {
    expect(() => definePlugin({ id: "both", setup: () => Effect.void, layer: undefined as never } as never)).not.toThrow();
    expect(() => definePlugin({ id: "both", setup: () => Effect.void, layer: Effect.void } as never)).toThrow(/either a layer or a setup/);
    expect(() => definePlugin({ id: "list", requires: [Greeting], setup: () => Effect.void } as never)).toThrow(/names its requires/);
    expect(() => definePlugin({ id: "neither" } as never)).toThrow(/either a layer or a setup/);
  });

  test("still takes a Schema for its config", async () => {
    const schematic = definePlugin({
      id: "schematic",
      config: Schema.Struct({ text: Schema.String }),
      provides: { greeting: Greeting },
      setup: (_, { config }) => Effect.succeed({ greeting: config.text }),
    });
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([schematic], { configs: { schematic: { text: "Hey" } } });
        expect(yield* core.run(Greeting)).toBe("Hey");
      }),
    );
  });
});

describe("configSchema", () => {
  const decode = (schema: Schema.Codec<any, any>, value: unknown) => Schema.decodeUnknownSync(schema)(value);

  test("fills absent fields, nested ones one by one, and copies each default", () => {
    const schema = configSchema({ ask: ["shell"], limit: 3, on: true, nested: { depth: 2, name: "x" }, none: null });
    const first = decode(schema, {});
    expect(first).toEqual({ ask: ["shell"], limit: 3, on: true, nested: { depth: 2, name: "x" }, none: null });
    first.ask.push("changed");
    expect(decode(schema, {}).ask).toEqual(["shell"]);
    expect(decode(schema, { nested: { depth: 5 } }).nested).toEqual({ depth: 5, name: "x" });
    expect(decode(schema, { ask: ["a", "b"] }).ask).toEqual(["a", "b"]);
  });

  test("checks given values against the defaults' types", () => {
    const schema = configSchema({ ask: ["shell"], limit: 3, mixed: [1, "a"], empty: [] });
    expect(() => decode(schema, { ask: [1] })).toThrow();
    expect(() => decode(schema, { limit: "3" })).toThrow();
    expect(() => decode(schema, { limit: Number.POSITIVE_INFINITY })).toThrow();
    // A mixed list takes what its default holds, as its type (number | string) says, and nothing else.
    expect(decode(schema, { mixed: ["b", 2], empty: [{ any: "thing" }] })).toMatchObject({ mixed: ["b", 2], empty: [{ any: "thing" }] });
    expect(() => decode(schema, { mixed: [true] })).toThrow();
  });

  test("encodes back for a settings form", () => {
    const schema = configSchema({ limit: 3 });
    expect(Schema.encodeUnknownSync(schema)({ limit: 4 })).toEqual({ limit: 4 });
  });

  test("refuses a default that is not JSON", () => {
    expect(() => configSchema({ when: new Date() as never })).toThrow(/not a JSON value/);
    expect(() => configSchema([] as never)).toThrow(/plain object/);
  });
});
