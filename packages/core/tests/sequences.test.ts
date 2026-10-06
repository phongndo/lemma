import { describe, expect, test } from "vitest";
import { Context, Deferred, Duration, Effect, Layer, Result, Schema, Stream } from "effect";
import fc from "fast-check";
import { Diagnostic, Event, Hook, makeLoader, PluginContext } from "../src/index.ts";
import type { Composition, CoreSnapshot, Loader, Plugin, PluginFault } from "../src/index.ts";
import { waitFor } from "./support.ts";

/**
 * Model: four plugins (b needs a, c needs b, d is independent). Each activation
 * acquires one resource, registers one hook handler and one observer, and runs
 * one required background task the test can fail on demand. Fault switches make
 * activation or disposal fail. Random command sequences must keep the invariants
 * in `check` true after every step; fast-check shrinks any counterexample.
 */
class A extends Context.Service<A, string>()("seq/A") {}
class B extends Context.Service<B, string>()("seq/B") {}
const Ping = Hook.make<number, number>("seq/ping");
const Tick = Event.make<number>("seq/tick");
const ids = ["a", "b", "c", "d"] as const;
type Id = (typeof ids)[number];
const requires: Record<Id, Id | undefined> = { a: undefined, b: "a", c: "b", d: undefined };

interface World {
  readonly live: Set<string>;
  readonly faults: { activate: Set<Id>; dispose: Set<Id> };
  /** Background-failure trigger per instance key. */
  readonly triggers: Map<string, Deferred.Deferred<void>>;
  generation: number;
}

const Config = Schema.Struct({ version: Schema.Number });

function fixtures(world: World): Record<Id, Plugin> {
  // Raw manifests model the untyped package seam; the runtime validates exports and inputs.
  const make = (id: Id, provides: readonly Context.Key<any, string>[], needs: readonly Context.Key<any, string>[]): Plugin => ({
    id,
    provides,
    requires: needs,
    config: Config,
    exclusive: false,
    layer: (raw) =>
      Layer.effectContext(
        Effect.gen(function* () {
          const config = raw as typeof Config.Type;
          const key = `${id}#${++world.generation}`;
          if (world.faults.activate.has(id)) return yield* Effect.fail(`${id} cannot activate`);
          world.live.add(key);
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              world.live.delete(key);
              return world.faults.dispose.has(id) ? Effect.die(`${id} cannot dispose`) : Effect.void;
            }),
          );
          const owner = yield* PluginContext;
          yield* owner.on(Ping, (n, next) => next(n + 1));
          yield* owner.observe(Tick, () => Effect.void);
          const trigger = yield* Deferred.make<void>();
          world.triggers.set(key, trigger);
          yield* owner.background("poll", Deferred.await(trigger).pipe(Effect.andThen(Effect.fail(`${id} lost connection`))), { required: true });
          for (const tag of needs) yield* tag;
          const value = `${key}@${config.version}`;
          return provides.length ? Context.make(provides[0]!, value) : Context.empty();
        }),
      ) as Layer.Layer<never, unknown, unknown>,
  });
  return { a: make("a", [A], []), b: make("b", [B], [A]), c: make("c", [], [B]), d: make("d", [], []) };
}

type Command =
  | { readonly kind: "apply"; readonly subset: readonly Id[]; readonly version: number }
  | { readonly kind: "failBackground"; readonly id: Id }
  | { readonly kind: "restart"; readonly id: Id }
  | { readonly kind: "fault"; readonly phase: "activate" | "dispose"; readonly id: Id; readonly on: boolean }
  | { readonly kind: "work" };

const idArb = fc.constantFrom(...ids);
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("apply" as const), subset: fc.uniqueArray(idArb), version: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("failBackground" as const), id: idArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("restart" as const), id: idArb }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("fault" as const), phase: fc.constantFrom("activate" as const, "dispose" as const), id: idArb, on: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "work" as const }) },
);

/** A subset is loadable only with its dependencies; the model closes over them. */
function closure(subset: readonly Id[]): Id[] {
  const result = new Set<Id>();
  for (const id of subset) {
    let current: Id | undefined = id;
    while (current) {
      result.add(current);
      current = requires[current];
    }
  }
  return ids.filter((id) => result.has(id));
}

function composition(subset: readonly Id[], version: number): Composition {
  return { plugins: Object.fromEntries(subset.map((id) => [id, { config: { version } }])) };
}

function check(world: World, snapshot: CoreSnapshot, faults: readonly PluginFault[]) {
  const active = snapshot.plugins.filter((p) => p.state === "active").map((p) => p.id as Id);
  // Every state is settled: no plugin is mid-transition between commands.
  expect(snapshot.plugins.every((p) => ["active", "failed", "closed"].includes(p.state))).toBe(true);
  // One live resource per active plugin, none for anything else.
  expect([...world.live].map((key) => key.split("#")[0]).sort()).toEqual([...active].sort());
  // Registrations belong only to active plugins, one each.
  expect(snapshot.hooks.flatMap((h) => h.handlers.map((r) => r.pluginId)).sort()).toEqual([...active].sort());
  expect(snapshot.events.flatMap((e) => e.observers).sort()).toEqual([...active].sort());
  // No active plugin depends on an inactive one.
  for (const id of active) expect(requires[id] === undefined || active.includes(requires[id])).toBe(true);
  // A halted plugin names an inactive root.
  for (const p of snapshot.plugins) if (p.haltedBy) expect(active.includes(p.haltedBy as Id)).toBe(false);
  // Every fault is attributed to a known plugin.
  for (const fault of faults) expect(ids.includes(fault.pluginId as Id)).toBe(true);
}

const settle = (loader: Loader) => waitFor(loader.core.inspect, (s) => s.plugins.every((p) => ["active", "failed", "closed"].includes(p.state)));

describe("command sequences", () => {
  test("random load/reload/fail/restart sequences preserve ownership, registration, and dependency invariants", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 12 }), async (commands) => {
        const world: World = { live: new Set(), faults: { activate: new Set(), dispose: new Set() }, triggers: new Map(), generation: 0 };
        const all = fixtures(world);
        const source = {
          resolve: (id: string) =>
            all[id as Id] ? Effect.succeed(all[id as Id]) : Effect.fail(new Diagnostic({ severity: "error", message: `unknown ${id}` })),
        };
        const faults: PluginFault[] = [];
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              // Short deadlines turn a stuck drain or dispose into a reported fault the shrinker can reproduce.
              const loader = yield* makeLoader({
                source,
                composition: composition(["a", "b"], 1),
                deadlines: { activate: Duration.seconds(1), dispose: Duration.millis(200) },
              });
              let applied = new Map<Id, number>([
                ["a", 1],
                ["b", 1],
              ]);
              yield* Effect.forkScoped(
                Stream.runForEach(loader.core.faults, (fault) =>
                  Effect.sync(() => {
                    faults.push(fault);
                  }),
                ),
              );
              check(world, yield* loader.core.inspect, faults);
              for (const [index, command] of commands.entries()) {
                const before = yield* loader.core.inspect;
                const step = Effect.gen(function* () {
                  switch (command.kind) {
                    case "apply": {
                      const subset = closure(command.subset);
                      // Changed: new to the composition, different config, or depending on a changed plugin.
                      const changed = new Set<Id>();
                      for (const id of subset) {
                        const dependency = requires[id];
                        if (applied.get(id) !== command.version || (dependency !== undefined && changed.has(dependency))) changed.add(id);
                      }
                      const result = yield* Effect.result(loader.apply(composition(subset, command.version)));
                      const after = yield* loader.core.inspect;
                      if (Result.isSuccess(result)) {
                        // A successful change activates every changed plugin; unchanged ones keep their state (no automatic restarts).
                        const expectedActive = subset.filter((id) => changed.has(id) || before.plugins.find((p) => p.id === id)?.state === "active");
                        expect(after.plugins.filter((p) => p.state === "active").map((p) => p.id)).toEqual(expectedActive);
                        expect([...result.success.started, ...result.success.restarted].sort()).toEqual([...changed].sort());
                        expect([...result.success.unchanged].sort()).toEqual(subset.filter((id) => !changed.has(id)).sort());
                        for (const fault of result.success.faults) expect(fault.phase).toBe("dispose");
                        applied = new Map(subset.map((id) => [id, command.version]));
                      } else {
                        // A failed change reports the injected fault and leaves the running composition as it was.
                        expect(result.failure.diagnostics.length).toBeGreaterThan(0);
                        expect(after.plugins.map((p) => [p.id, p.state])).toEqual(before.plugins.map((p) => [p.id, p.state]));
                      }
                      break;
                    }
                    case "failBackground": {
                      const key = [...world.live].find((candidate) => candidate.startsWith(`${command.id}#`));
                      const trigger = key === undefined ? undefined : world.triggers.get(key);
                      const wasActive = before.plugins.find((p) => p.id === command.id)?.state === "active";
                      if (!trigger || !wasActive) break;
                      yield* Deferred.succeed(trigger, undefined);
                      yield* waitFor(loader.core.inspect, (s) => s.plugins.find((p) => p.id === command.id)?.state === "failed");
                      const after = yield* loader.core.inspect;
                      // Only the plugin and its dependents changed.
                      for (const p of after.plugins) {
                        const prior = before.plugins.find((q) => q.id === p.id)!;
                        const dependsOnFailed = closure([p.id as Id]).includes(command.id) && p.id !== command.id;
                        if (p.id === command.id) expect(p.state).toBe("failed");
                        else if (dependsOnFailed && prior.state === "active") expect([p.state, p.haltedBy]).toEqual(["closed", command.id]);
                        else expect(p.state).toBe(prior.state);
                      }
                      break;
                    }
                    case "restart": {
                      const target = before.plugins.find((p) => p.id === command.id);
                      const result = yield* Effect.result(loader.core.restart(command.id));
                      const after = yield* loader.core.inspect;
                      if (!target) {
                        expect(Result.isFailure(result)).toBe(true);
                        break;
                      }
                      if (target.state === "active") {
                        expect(after.plugins).toEqual(before.plugins);
                        break;
                      }
                      const dependency = requires[command.id];
                      const dependencyActive = dependency === undefined || before.plugins.find((p) => p.id === dependency)?.state === "active";
                      if (!dependencyActive || world.faults.activate.has(command.id)) {
                        // The forced plugin itself cannot come back: nothing changes.
                        expect(Result.isFailure(result)).toBe(true);
                        expect(after.plugins.map((p) => [p.id, p.state])).toEqual(before.plugins.map((p) => [p.id, p.state]));
                        break;
                      }
                      // The forced plugin is active; each dependent is retried and is active, failed, or halted on its own account.
                      const expected = new Map<Id, string>();
                      for (const p of after.plugins) {
                        const id = p.id as Id;
                        const provider = requires[id];
                        if (id === command.id) expected.set(id, "active");
                        else if (closure([id]).includes(command.id))
                          expected.set(id, expected.get(provider!) !== "active" ? "closed" : world.faults.activate.has(id) ? "failed" : "active");
                        else expected.set(id, before.plugins.find((q) => q.id === id)!.state);
                      }
                      expect(after.plugins.map((p) => [p.id, p.state])).toEqual([...expected].map(([id, state]) => [id, state]));
                      break;
                    }
                    case "fault":
                      world.faults[command.phase][command.on ? "add" : "delete"](command.id);
                      break;
                    case "work": {
                      const value = yield* loader.core.run(Effect.serviceOption(A));
                      const active = before.plugins.find((p) => p.id === "a")?.state === "active";
                      expect(value._tag).toBe(active ? "Some" : "None");
                      break;
                    }
                  }
                });
                yield* step.pipe(
                  Effect.timeoutOrElse({ duration: Duration.seconds(3), orElse: () => Effect.fail(new Error(`command ${index} (${command.kind}) hung`)) }),
                  Effect.orDie,
                );
                yield* settle(loader);
                check(world, yield* loader.core.inspect, faults);
              }
            }),
          ).pipe(
            Effect.catchDefect((defect) =>
              Effect.sync(() => {
                // Shutdown surfaces injected dispose faults as defects; the resource ledger must still be empty.
                expect(String(defect)).toContain("cannot dispose");
              }),
            ),
          ),
        );
        expect(world.live.size).toBe(0);
      }),
      {
        numRuns: Number(process.env.LEMMA_SEQUENCE_RUNS ?? 60),
        ...(process.env.LEMMA_SEQUENCE_SEED === undefined ? {} : { seed: Number(process.env.LEMMA_SEQUENCE_SEED) }),
        ...(process.env.LEMMA_SEQUENCE_PATH === undefined ? {} : { path: process.env.LEMMA_SEQUENCE_PATH }),
      },
    );
  }, 60_000);
});
