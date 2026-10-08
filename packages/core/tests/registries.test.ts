import { describe, expect, test } from "vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { Admitted, definePlugin, makeCore, makeLoader, PluginContext, PluginFault, Registries, Registry, RegistryError } from "../src/index.ts";
import type { AdmittedWork, Composition, Contribution, Plugin, PluginSource } from "../src/index.ts";
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
/** Gives other fibers `count` turns, so work that does not wait for something runs first. */
const turns = (count: number) => Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow, { discard: true });
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
        const cause = Option.getOrThrow(Cause.findErrorOption((fault as PluginFault).cause));
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
            const fiber = yield* Effect.forkChild(
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
        expect(Array.from(collected).map((items) => items.map((item) => item.item.label))).toEqual([["a"]]);
      }),
    );
  });

  test("a contribution keeps its identity while it is there, and leaves before its plugin's finalizers run", async () => {
    await run(
      Effect.gen(function* () {
        // What a reader holds, and whether it was still there each time the plugin's finalizer ran.
        let held: Contribution<Entry> | undefined;
        const there: boolean[] = [];
        const trigger = yield* Deferred.make<void>();
        const owned = definePlugin({
          id: "owned",
          config: Schema.Struct({ generation: Schema.Number, fails: Schema.optional(Schema.Boolean) }),
          layer: (config) =>
            Layer.effectDiscard(
              Effect.gen(function* () {
                const owner = yield* PluginContext;
                const registries = yield* Registries;
                yield* owner.add(Menu, { label: "owned" });
                // Released before the item's own cleanup would be, were the item still there.
                yield* Effect.addFinalizer(() => Effect.map(registries.items(Menu), (items) => void there.push(items.includes(held!))));
                if (config.fails) yield* owner.background("work", Effect.andThen(Deferred.await(trigger), Effect.fail("broken")), { required: true });
              }),
            ),
        });
        const source: PluginSource = { resolve: (id) => Effect.succeed(id === "owned" ? owned : contributor(id, [{ label: id }])) };
        const loader = yield* makeLoader({ source, composition: { plugins: { owned: { config: { generation: 1 } } } } });
        const items = loader.core.run(Effect.flatMap(Registries, (registries) => registries.items(Menu)));
        held = (yield* items).find((contribution) => contribution.pluginId === "owned");
        yield* loader.apply({ plugins: { owned: { config: { generation: 1 } }, other: {} } });
        expect((yield* items).includes(held!)).toBe(true);

        // Replaced: the replacement's item is another contribution, even with an equal value.
        yield* loader.apply({ plugins: { owned: { config: { generation: 2, fails: true } }, other: {} } });
        const replacement = (yield* items).find((contribution) => contribution.pluginId === "owned");
        expect(replacement).not.toBe(held);
        expect(replacement?.item).toEqual(held?.item);
        expect(there).toEqual([false]);

        // Failed, then removed after a restart: gone each time before its finalizers run.
        held = replacement;
        yield* Deferred.succeed(trigger, undefined);
        yield* waitFor(
          Effect.sync(() => there.length),
          (count) => count === 2,
        );
        yield* loader.core.restart("owned");
        held = (yield* items).find((contribution) => contribution.pluginId === "owned");
        yield* loader.apply({ plugins: { other: {} } });
        expect(there).toEqual([false, false, false]);
      }),
    );
  });

  test("run admits work only while its contribution is there; the contributor's finalizers wait for it, and `left` says when to stop", async () => {
    await run(
      Effect.gen(function* () {
        // What happened, in order, across the plugin's finalizers and the work run with its item.
        const log: string[] = [];
        const finish = yield* Deferred.make<void>();
        const served = definePlugin({
          id: "served",
          config: Schema.Struct({ generation: Schema.Number }),
          layer: (config) =>
            Layer.effectDiscard(
              Effect.gen(function* () {
                const owner = yield* PluginContext;
                yield* owner.add(Menu, { label: `served ${config.generation}` });
                yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`finalizer ${config.generation}`)));
              }),
            ),
        });
        const source: PluginSource = { resolve: () => Effect.succeed(served) };
        const loader = yield* makeLoader({ source, composition: { plugins: { served: { config: { generation: 1 } } } } });
        const registries = yield* loader.core.run(Registries);
        const [first] = yield* registries.items(Menu);

        // One piece of work stops when the item leaves; the other finishes what it was doing.
        // Started at once, so each is admitted before the reload.
        const watching = yield* Effect.forkChild(
          registries.run(first!, (left) =>
            Effect.andThen(
              left,
              Effect.sync(() => void log.push("watcher stopped")),
            ),
          ),
          {
            startImmediately: true,
          },
        );
        const finishing = yield* Effect.forkChild(
          registries.run(first!, () =>
            Effect.andThen(
              Deferred.await(finish),
              Effect.sync(() => void log.push("call finished")),
            ),
          ),
          { startImmediately: true },
        );
        const replacing = yield* Effect.forkChild(loader.apply({ plugins: { served: { config: { generation: 2 } } } }));
        yield* Fiber.join(watching);
        expect(log).toEqual(["watcher stopped"]);

        // While the old instance waits on the call, its item takes no new work, and the replacement's does.
        const absent = yield* Effect.exit(registries.run(first!, () => Effect.void));
        expect(failure(absent)).toMatchObject({ _tag: "RegistryError", reason: "Absent", pluginId: "served" });
        const [second] = yield* registries.items(Menu);
        expect(second?.item.label).toBe("served 2");
        expect(yield* registries.run(second!, () => Effect.succeed("answered"))).toBe("answered");
        // Its finalizers would have run by now had they not waited.
        yield* turns(50);
        expect(log).toEqual(["watcher stopped"]);

        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(finishing);
        yield* Fiber.join(replacing);
        expect(log).toEqual(["watcher stopped", "call finished", "finalizer 1"]);
      }),
    );
  });

  test("work still running at the dispose deadline is interrupted, `run` fails Expired, and the reload counts it", async () => {
    await run(
      Effect.gen(function* () {
        const log: string[] = [];
        const stubborn = definePlugin({
          id: "stubborn",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.add(Menu, { label: "stubborn" });
              yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("finalizer")));
            }),
          ),
        });
        const loader = yield* makeLoader({
          source: { resolve: () => Effect.succeed(stubborn) },
          composition: { plugins: { stubborn: {} } },
          deadlines: { dispose: Duration.millis(50) },
        });
        const registries = yield* loader.core.run(Registries);
        const [item] = yield* registries.items(Menu);
        // Ignores `left`, and never ends by itself.
        const forever = yield* Effect.forkChild(
          registries.run(item!, () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void log.push("interrupted"))))),
          { startImmediately: true },
        );
        const report = yield* loader.apply({ plugins: {} });
        expect(report.interrupted).toBe(1);
        expect(log).toEqual(["interrupted", "finalizer"]);
        expect(failure(yield* Fiber.await(forever))).toMatchObject({ _tag: "RegistryError", reason: "Expired", pluginId: "stubborn" });
      }),
    );
  });

  test("a failure and shutdown end admitted work before the finalizers too; interrupting run interrupts the work", async () => {
    const log: string[] = [];
    await run(
      Effect.gen(function* () {
        const trigger = yield* Deferred.make<void>();
        const fragile = (id: string, fails: boolean) =>
          definePlugin({
            id,
            layer: Layer.effectDiscard(
              Effect.gen(function* () {
                const owner = yield* PluginContext;
                yield* owner.add(Menu, { label: id });
                yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`finalizer ${id}`)));
                if (fails) yield* owner.background("work", Effect.andThen(Deferred.await(trigger), Effect.fail("broken")), { required: true });
              }),
            ),
          });
        const core = yield* makeCore([fragile("failing", true), fragile("lasting", false), fragile("third", false)]);
        const registries = yield* core.run(Registries);
        const items = yield* registries.items(Menu);
        const watch = (label: string) => {
          const item = items.find((contribution) => contribution.item.label === label)!;
          // Takes a few turns to stop, so a finalizer that did not wait would run first.
          const stop = Effect.andThen(
            turns(10),
            Effect.sync(() => void log.push(`stopped ${label}`)),
          );
          return Effect.forkDetach(
            registries.run(item, (left) => Effect.andThen(left, stop)),
            { startImmediately: true },
          );
        };
        yield* watch("failing");
        yield* watch("lasting");
        const cancelled = yield* Effect.forkChild(
          registries.run(
            items.find((contribution) => contribution.item.label === "third")!,
            () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void log.push("cancelled")))),
          ),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(cancelled);
        expect(log).toEqual(["cancelled"]);
        yield* Deferred.succeed(trigger, undefined);
        yield* waitFor(
          Effect.sync(() => log.length),
          (count) => count === 3,
        );
        expect(log).toEqual(["cancelled", "stopped failing", "finalizer failing"]);
      }),
    );
    // The core closed with the scope: `lasting`'s work stopped before its finalizer (`third` had none to wait for).
    expect(log.slice(3).sort()).toEqual(["finalizer lasting", "finalizer third", "stopped lasting"]);
    expect(log.indexOf("stopped lasting")).toBeLessThan(log.indexOf("finalizer lasting"));
  });

  test("admitted work finds whose items it runs with in `Admitted`, outermost first, and `ended` says when each has ended", async () => {
    await run(
      Effect.gen(function* () {
        const core = yield* makeCore([contributor("outer", [{ label: "outer" }]), contributor("inner", [{ label: "inner" }])]);
        const registries = yield* core.run(Registries);
        const [inner, outer] = yield* registries.items(Menu);
        expect(yield* Admitted).toEqual([]);
        const release = yield* Deferred.make<void>();
        const seen = yield* Deferred.make<readonly AdmittedWork[]>();
        // Work with one plugin's item that runs work with another's, and waits to be let go.
        const working = yield* Effect.forkChild(
          registries.run(outer!, () =>
            registries.run(inner!, () =>
              Effect.andThen(
                Effect.flatMap(Admitted, (admitted) => Deferred.succeed(seen, admitted)),
                Deferred.await(release),
              ),
            ),
          ),
          { startImmediately: true },
        );
        const admitted = yield* Deferred.await(seen);
        expect(admitted.map((work) => work.pluginId)).toEqual(["outer", "inner"]);
        // Whoever holds them may wait for their end, which is not yet.
        const ended = yield* Effect.forkChild(Effect.forEach(admitted, (work) => work.ended, { discard: true }));
        yield* turns(20);
        expect(ended.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(working);
        yield* Fiber.join(ended);
        // Asked after the end, it is over at once.
        yield* Effect.forEach(admitted, (work) => work.ended, { discard: true });
      }),
    );
  });

  test("settled completes at once between changes, and else once the change in progress has finished: an exclusive replacement is offered by then", async () => {
    await run(
      Effect.gen(function* () {
        const open = yield* Deferred.make<void>();
        let instances = 0;
        // Its replacement starts once the test lets it, which holds the change open.
        const exclusive = definePlugin({
          id: "exclusive",
          exclusive: true,
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              const instance = ++instances;
              if (instance > 1) yield* Deferred.await(open);
              yield* owner.add(Menu, { label: `exclusive ${instance}` });
            }),
          ),
        });
        const core = yield* makeCore([exclusive]);
        const registries = yield* core.run(Registries);
        yield* registries.settled;
        const [first] = yield* registries.items(Menu);
        // Work that ends when its item leaves, then waits for the change that removed it and looks again.
        const after = yield* Effect.forkChild(
          registries.run(first!, (left) => left).pipe(Effect.andThen(registries.settled), Effect.andThen(core.run(labels()))),
          { startImmediately: true },
        );
        const restarting = yield* Effect.forkChild(core.restart("exclusive", { force: true }));
        // The old instance is gone and its replacement not yet offered: the change is still under way.
        yield* waitFor(core.run(labels()), (now) => now.length === 0);
        yield* turns(50);
        expect(after.pollUnsafe()).toBeUndefined();
        // A wait given up leaves the change to go on.
        const abandoned = yield* Effect.forkChild(registries.settled);
        yield* Fiber.interrupt(abandoned);
        yield* Deferred.succeed(open, undefined);
        expect(yield* Fiber.join(after)).toEqual(["exclusive 2"]);
        yield* Fiber.join(restarting);
      }),
    );
  });

  test("a registry's check refuses a malformed item from the plugin adding it, before its key, and readers never see it", async () => {
    await run(
      Effect.gen(function* () {
        const Labels = Registry.make<Entry>("test/labels", {
          key: (entry) => entry.label.toUpperCase(),
          check: (value) => (typeof (value as Entry | null)?.label === "string" ? undefined : "an entry needs a string `label`"),
        });
        const refused: unknown[] = [];
        const sloppy = definePlugin({
          id: "sloppy",
          layer: Layer.effectDiscard(
            Effect.gen(function* () {
              const owner = yield* PluginContext;
              yield* owner.add(Labels, { label: "fine" });
              // An untyped plugin's item: `key` would throw on it, so the check must come first.
              refused.push(yield* Effect.flip(owner.add(Labels, { name: "no label" } as unknown as Entry)));
            }),
          ),
        });
        const core = yield* makeCore([sloppy]);
        expect(refused).toMatchObject([
          {
            _tag: "RegistryError",
            reason: "Invalid",
            registry: "test/labels",
            pluginId: "sloppy",
            message: "Invalid item for test/labels: an entry needs a string `label`",
          },
        ]);
        expect(yield* core.run(labels(Labels))).toEqual(["fine"]);
      }),
    );
  });

  test("two tokens cannot share a name, a unique registry needs a key, and order must be finite", async () => {
    await run(
      Effect.gen(function* () {
        const impostor = Registry.make<Entry>("test/menu");
        const clash = yield* Effect.exit(makeCore([contributor("one", [{ label: "x" }]), contributor("two", [{ label: "y" }], impostor)]));
        expect(Option.getOrThrow(Cause.findErrorOption((failure(clash) as PluginFault).cause))).toMatchObject({ reason: "PointConflict" });
        const keyless = Registry.make<Entry>("test/keyless", { unique: true });
        const missing = yield* Effect.exit(makeCore([contributor("one", [{ label: "x" }], keyless)]));
        expect(Option.getOrThrow(Cause.findErrorOption((failure(missing) as PluginFault).cause))).toBeInstanceOf(RegistryError);
        const infinite = yield* Effect.exit(makeCore([contributor("one", [{ label: "x", order: Number.POSITIVE_INFINITY }])]));
        expect(Option.getOrThrow(Cause.findErrorOption((failure(infinite) as PluginFault).cause))).toMatchObject({ reason: "InvalidOrder" });
      }),
    );
  });
});
