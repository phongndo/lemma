import { describe, expect, test } from "vitest";
import { Cause, Chunk, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { definePlugin, makeCore, makeLoader, PluginContext, PluginFault, Registries, Registry, RegistryError } from "../src/index.ts";
import type { Composition, Plugin, PluginSource } from "../src/index.ts";
import { failure, run, waitFor } from "./support.ts";

interface Entry {
  readonly label: string;
}
const Menu = Registry.make<Entry>("test/menu");
const Commands = Registry.make<Entry>("test/commands", { key: (entry) => entry.label, unique: true });

const contributor = (id: string, entries: readonly (Entry & { readonly order?: number })[], registry = Menu) =>
  definePlugin({
    id,
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        Effect.forEach(entries, ({ order, ...entry }) => owner.add(registry, entry, order === undefined ? {} : { order }), { discard: true }),
      ),
    ),
  });
const labels = (registry = Menu) =>
  Effect.flatMap(Registries, (registries) => registries.items(registry)).pipe(Effect.map((items) => items.map((item) => item.item.label)));

describe("registries", () => {
  test("items come in order, then by plugin id and contribution order, attributed to their plugin", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([
          contributor("b", [{ label: "b1" }, { label: "b2" }]),
          contributor("a", [{ label: "a1" }]),
          contributor("z", [{ label: "first", order: -1 }]),
        ]);
        expect(yield* core.run(labels())).toEqual(["first", "a1", "b1", "b2"]);
        const items = yield* core.run(Effect.flatMap(Registries, (registries) => registries.items(Menu)));
        expect(items.map((item) => [item.pluginId, item.order])).toEqual([
          ["z", -1],
          ["a", 0],
          ["b", 0],
          ["b", 0],
        ]);
        const snapshot = (yield* core.inspect).registries;
        expect(snapshot).toEqual([{ name: "test/menu", items: items.map((item) => ({ pluginId: item.pluginId, order: item.order })) }]);
      }),
    );
  });

  test("an item leaves with its plugin, or sooner through the effect `add` returns", async () => {
    await run(
      Effect.gen(function* () {
        let remove: Effect.Effect<void> | undefined;
        const early = definePlugin({
          id: "early",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.add(Menu, { label: "kept" });
              remove = yield* owner.add(Menu, { label: "removed" });
            }),
          ),
        });
        const source: PluginSource = { resolve: (id) => Effect.succeed(id === "early" ? early : contributor(id, [{ label: id }])) };
        const composition = (ids: readonly string[]): Composition => ({ plugins: Object.fromEntries(ids.map((id) => [id, {}])) });
        const loader = yield* makeLoader({ source, composition: composition(["early", "other"]) });
        expect(yield* loader.core.run(labels())).toEqual(["kept", "removed", "other"]);
        yield* remove!;
        yield* remove!;
        expect(yield* loader.core.run(labels())).toEqual(["kept", "other"]);
        yield* loader.apply(composition(["early"]));
        expect(yield* loader.core.run(labels())).toEqual(["kept"]);
      }),
    );
  });

  test("a replacement's items replace its predecessor's at the swap; a unique key may pass to the plugin's own replacement", async () => {
    await run(
      Effect.gen(function* () {
        const versioned = definePlugin({
          id: "versioned",
          config: Schema.Struct({ label: Schema.String }),
          layer: (config) => Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(Commands, { label: config.label }))),
        });
        const same = definePlugin({
          id: "same-key",
          config: Schema.Struct({ generation: Schema.Number }),
          layer: () => Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(Commands, { label: "shared" }))),
        });
        const source: PluginSource = { resolve: (id) => Effect.succeed((id === "versioned" ? versioned : same) as Plugin) };
        const loader = yield* makeLoader({
          source,
          composition: { plugins: { versioned: { config: { label: "one" } }, "same-key": { config: { generation: 1 } } } },
        });
        expect(yield* loader.core.run(labels(Commands))).toEqual(["shared", "one"]);
        const report = yield* loader.apply({ plugins: { versioned: { config: { label: "two" } }, "same-key": { config: { generation: 2 } } } });
        expect([...report.restarted].sort()).toEqual(["same-key", "versioned"]);
        expect(yield* loader.core.run(labels(Commands))).toEqual(["shared", "two"]);
      }),
    );
  });

  test("a unique key held by another plugin fails the second contributor's activation", async () => {
    await run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(makeCore([contributor("first", [{ label: "run" }], Commands), contributor("second", [{ label: "run" }], Commands)]));
        const fault = failure(exit);
        expect(fault).toBeInstanceOf(PluginFault);
        const cause = Option.getOrThrow(Cause.failureOption((fault as PluginFault).cause));
        expect(cause).toMatchObject({ _tag: "RegistryError", reason: "Conflict", registry: "test/commands", pluginId: "second" });
      }),
    );
  });

  test("a failed activation leaves no items behind", async () => {
    await run(
      Effect.gen(function* () {
        const broken = definePlugin({
          id: "broken",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.add(Menu, { label: "never seen" });
              return yield* Effect.fail("boom");
            }),
          ),
        });
        const good = contributor("good", [{ label: "good" }]);
        const source: PluginSource = { resolve: (id) => Effect.succeed(id === "broken" ? broken : good) };
        const loader = yield* makeLoader({ source, composition: { plugins: { good: {} } } });
        const failed = yield* Effect.exit(loader.apply({ plugins: { good: {}, broken: {} } }));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* loader.core.run(labels())).toEqual(["good"]);
      }),
    );
  });

  test("changes emits the items now and after each change, latest first for a slow reader", async () => {
    await run(
      Effect.gen(function* () {
        let remove: Effect.Effect<void> | undefined;
        const plugin = definePlugin({
          id: "dynamic",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.add(Menu, { label: "a" });
              remove = yield* owner.add(Menu, { label: "b" });
            }),
          ),
        });
        const core = yield* makeCore([plugin]);
        const seen: string[][] = [];
        yield* core.run(
          Effect.gen(function* () {
            const registries = yield* Registries;
            const fiber = yield* Effect.fork(
              Stream.runForEach(Stream.take(registries.changes(Menu), 2), (items) =>
                Effect.sync(() => {
                  seen.push(items.map((item) => item.item.label));
                }),
              ),
            );
            yield* waitFor(
              Effect.sync(() => seen.length),
              (count) => count === 1,
            );
            yield* remove!;
            yield* Fiber.join(fiber);
          }),
        );
        expect(seen).toEqual([["a", "b"], ["a"]]);
        const collected = yield* core.run(Effect.flatMap(Registries, (registries) => Stream.runCollect(Stream.take(registries.changes(Menu), 1))));
        expect(Chunk.toArray(collected).map((items) => items.map((item) => item.item.label))).toEqual([["a"]]);
      }),
    );
  });

  test("two tokens cannot share a name, a unique registry needs a key, and order must be finite", async () => {
    await run(
      Effect.gen(function* () {
        const impostor = Registry.make<Entry>("test/menu");
        const clash = yield* Effect.exit(makeCore([contributor("one", [{ label: "x" }]), contributor("two", [{ label: "y" }], impostor)]));
        expect(Option.getOrThrow(Cause.failureOption((failure(clash) as PluginFault).cause))).toMatchObject({ reason: "PointConflict" });
        const keyless = Registry.make<Entry>("test/keyless", { unique: true });
        const missing = yield* Effect.exit(makeCore([contributor("one", [{ label: "x" }], keyless)]));
        expect(Option.getOrThrow(Cause.failureOption((failure(missing) as PluginFault).cause))).toBeInstanceOf(RegistryError);
        const infinite = yield* Effect.exit(makeCore([contributor("one", [{ label: "x", order: Number.POSITIVE_INFINITY }])]));
        expect(Option.getOrThrow(Cause.failureOption((failure(infinite) as PluginFault).cause))).toMatchObject({ reason: "InvalidOrder" });
      }),
    );
  });
});
