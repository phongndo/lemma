import { describe, expect, test } from "vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import type { Context } from "effect";
import { HostControl, Interaction } from "@lemma/contracts";
import type { ChangeReport } from "@lemma/contracts";
import { callServed, pathsPlugin } from "@lemma/contracts/testing";
import { definePlugin, makeCore, PluginContext, Registries, Registry } from "@lemma/core";
import type { Core } from "@lemma/core";
import commands from "@lemma/plugin-commands";
import { host } from "@lemma/plugin-commands-builtin";
import { changedBetween, deferral } from "../src/deferral.ts";

const Items = Registry.make<string>("test/items");

/** A plugin that contributes one item, named after it. */
const contributor = (id: string) => definePlugin({ id, layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.add(Items, id))) });

const pending = <A, E>(fiber: Fiber.Fiber<A, E>) => Effect.map(Effect.timeoutOption(Fiber.await(fiber), "20 millis"), Option.isNone);

describe("deferral", () => {
  test("a change waits for the work of each plugin it restarts that is making it to end; any other applies at once", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([contributor("outer"), contributor("inner")]);
          const registries = yield* core.run(Registries);
          const [inner, outer] = yield* registries.items(Items);
          // Asked by no plugin's work: at once, unless it restarts the transport serving the request.
          expect(yield* deferral(new Set(["outer"]), ["transport"])).toBeUndefined();
          expect(yield* deferral(new Set(["transport"]), ["transport"])).toBeDefined();

          const releaseInner = yield* Deferred.make<void>();
          const releaseOuter = yield* Deferred.make<void>();
          const asked = yield* Deferred.make<readonly (Effect.Effect<void> | undefined)[]>();
          // Work with `outer`'s item that runs work with `inner`'s and goes on after it, asking from inside both.
          const working = yield* Effect.forkChild(
            registries.run(outer!, () =>
              Effect.andThen(
                registries.run(inner!, () =>
                  Effect.andThen(
                    Effect.flatMap(
                      Effect.all([deferral(new Set(["elsewhere"]), []), deferral(new Set(["inner"]), []), deferral(new Set(["inner", "outer"]), [])]),
                      (answers) => Deferred.succeed(asked, answers),
                    ),
                    Deferred.await(releaseInner),
                  ),
                ),
                Deferred.await(releaseOuter),
              ),
            ),
            { startImmediately: true },
          );
          const [elsewhere, onlyInner, both] = yield* Deferred.await(asked);
          expect(elsewhere).toBeUndefined();
          const forInner = yield* Effect.forkChild(onlyInner!);
          const forBoth = yield* Effect.forkChild(both!);
          expect([yield* pending(forInner), yield* pending(forBoth)]).toEqual([true, true]);
          yield* Deferred.succeed(releaseInner, undefined);
          yield* Fiber.join(forInner);
          // Restarting `outer` too waits for its work, which goes on.
          expect(yield* pending(forBoth)).toBe(true);
          yield* Deferred.succeed(releaseOuter, undefined);
          yield* Fiber.join(working);
          yield* Fiber.join(forBoth);
        }),
      ),
    ));

  test("a command that restarts the plugin that registered it, as host.reload may restart commands-host, answers, and the plugin restarts once it has ended", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const running = yield* Deferred.make<Core>();
          const restarted = yield* Deferred.make<void>();
          const restart = Effect.flatMap(Deferred.await(running), (core) =>
            Effect.andThen(Effect.orDie(core.restart("commands-host", { force: true })), Deferred.succeed(restarted, undefined)),
          );
          const report: ChangeReport = { started: [], restarted: ["commands-host"], stopped: [], unchanged: [], failed: [], interrupted: 0, faults: [] };
          // As the host's: this reload restarts commands-host, and asks whether that plugin's work is making it.
          const control = {
            reload: Effect.gen(function* () {
              const after = yield* deferral(new Set(["commands-host"]), []);
              if (after === undefined) return yield* Effect.as(restart, report);
              yield* Effect.forkIn(Effect.andThen(after, restart), scope);
              return { ...report, restarted: [], deferred: true };
            }),
          } as unknown as Context.Service.Shape<typeof HostControl>;
          const core = yield* makeCore([pathsPlugin("/lemma"), commands, host], {
            provide: {
              provides: [HostControl, Interaction],
              layer: Layer.mergeAll(Layer.succeed(HostControl, control), Layer.succeed(Interaction, {} as Context.Service.Shape<typeof Interaction>)),
            },
          });
          yield* Deferred.succeed(running, core);
          const registries = yield* core.run(Registries);
          // Applied at once, the restart would cut off the command running it, or wait on it until the dispose deadline.
          expect(yield* callServed(registries, "commands.run", { id: "host.reload" })).toEqual({
            message: "Reloading config: the host restarts the plugins it changes once this command has ended",
          });
          yield* Deferred.await(restarted);
          expect(yield* callServed(registries, "commands.list", undefined)).toContainEqual(
            expect.objectContaining({ id: "host.reload", source: "commands-host" }),
          );
        }),
      ),
    ));
});

describe("changedBetween", () => {
  test("names the plugins a composition adds, removes, or runs with another definition or config, as the loader replaces them", () => {
    const [same, edited, reconfigured, removed, added] = ["same", "edited", "reconfigured", "removed", "added"].map(contributor);
    const current = new Map([
      ["same", { plugin: same!, config: { deep: { list: [1, 2] } } }],
      ["edited", { plugin: edited! }],
      ["reconfigured", { plugin: reconfigured!, config: { level: 1 } }],
      ["removed", { plugin: removed! }],
    ]);
    const next = new Map([
      // An equal config read again is not a change.
      ["same", { plugin: same!, config: { deep: { list: [1, 2] } } }],
      ["edited", { plugin: contributor("edited") }],
      ["reconfigured", { plugin: reconfigured!, config: { level: 2 } }],
      ["added", { plugin: added! }],
    ]);
    expect(changedBetween(current, next).sort()).toEqual(["added", "edited", "reconfigured", "removed"]);
    expect(changedBetween(current, current)).toEqual([]);
  });
});
