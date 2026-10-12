import { Cause, Context, Deferred, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { assert, AssertionError, definePlugin, makeCore, Verify } from "../src/index.ts";
import { run, waitFor } from "./support.ts";

/*
 * `assert` stays on: a broken one is a defect of the work that broke it, which the kernel reports as that plugin's
 * fault. `Verify` is a runtime setting, so a simulation that turns it on reaches every plugin's work: its activation,
 * its background tasks, and the calls made to it.
 */
class Probe extends Context.Service<Probe, { readonly verify: Effect.Effect<boolean> }>()("test/assert/Probe") {}

describe("assert", () => {
  test("passes what holds, narrowing it, and throws an AssertionError naming what broke", () => {
    const value: string | undefined = "x";
    assert(value !== undefined, "set");
    expect(value.length).toBe(1);
    expect(() => assert(false, "the queue is bounded")).toThrow(new AssertionError("the queue is bounded"));
  });

  test("broken in a plugin's background work, it is that plugin's fault", async () => {
    const plugin = definePlugin({
      id: "breaks",
      setup: (_, owner) =>
        owner.background(
          "check",
          Effect.sync(() => assert([].length > 0, "the list is empty")),
        ),
    });
    const fault = await run(
      Effect.gen(function* () {
        const core = yield* makeCore([plugin]);
        return yield* waitFor(
          Effect.map(core.inspect, (snapshot) => snapshot.plugins.find((row) => row.id === "breaks")?.fault),
          (found) => found !== undefined,
        );
      }),
    );
    expect(fault?.phase).toBe("background");
    expect(Cause.squash(fault!.cause as Cause.Cause<unknown>)).toBeInstanceOf(AssertionError);
  });
});

describe("Verify", () => {
  test("is off unless the caller turns it on, and then reaches activation, background work, and calls", async () => {
    const seen = async (verify: boolean | undefined) =>
      run(
        Effect.gen(function* () {
          const background = yield* Deferred.make<boolean>();
          let activation = false;
          const plugin = definePlugin({
            id: "probe",
            provides: { probe: Probe },
            setup: function* (_, owner) {
              activation = yield* Verify;
              yield* owner.background(
                "look",
                Effect.gen(function* () {
                  yield* Deferred.succeed(background, yield* Verify);
                }),
              );
              return {
                probe: {
                  verify: Effect.gen(function* () {
                    return yield* Verify;
                  }),
                },
              };
            },
          });
          const core = yield* makeCore([plugin]);
          const called = yield* core.run(
            Effect.gen(function* () {
              return yield* (yield* Probe).verify;
            }),
          );
          return { activation, background: yield* Deferred.await(background), called };
        }).pipe(verify === undefined ? (effect) => effect : Effect.provideService(Verify, verify)),
      );
    expect(await seen(undefined)).toEqual({ activation: false, background: false, called: false });
    expect(await seen(true)).toEqual({ activation: true, background: true, called: true });
  });

  test("an assertion's failure ends the call that broke it as a defect", async () => {
    const exit = await Effect.runPromiseExit(Effect.sync(() => assert(false, "broken")));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });
});
