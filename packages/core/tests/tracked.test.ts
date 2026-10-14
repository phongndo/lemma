import { Context, Effect, Option } from "effect";
import { describe, expect, test } from "vitest";
import { TrackedServices } from "../src/internal/tracked.ts";

class Used extends Context.Service<Used, string>()("test/Used") {}
class Unused extends Context.Service<Unused, string>()("test/Unused") {}
class Added extends Context.Service<Added, string>()("test/Added") {}

/** Runs `effect` with `services` as its whole context, as `core.run` runs a task. */
const runWith = <A>(services: TrackedServices, effect: Effect.Effect<A, never, any>): A =>
  Effect.runSync(Effect.updateContext(effect, () => Context.makeUnsafe<any>(services)));

/** Resolves `Used`. */
const use = Effect.gen(function* () {
  return yield* Used;
});

/** What the task resolved of the test's services; Effect's own settings are read through the map too. */
const resolved = (services: TrackedServices) => new Set([...services.read].filter((key) => key.startsWith("test/")));

const tracked = () =>
  new TrackedServices([
    [Used.key, "used"],
    [Unused.key, "unused"],
  ]);

// The kernel learns which services a task used, and revokes them, through the map it gives Effect (`tracked.ts`).
// Effect offers no API for either: these fail when an Effect release stops resolving services through that map.
describe("tracked services", () => {
  test("a service a task resolves is read through the map, and only that one", () => {
    const services = tracked();
    expect(runWith(services, use)).toBe("used");
    expect(resolved(services)).toEqual(new Set([Used.key]));
  });

  test("a service resolved under what the task added to its context, and inside a span, is still read through the map", () => {
    const services = tracked();
    const value = runWith(services, use.pipe(Effect.provideService(Added, "added"), Effect.withSpan("inner")));
    expect(value).toBe("used");
    expect(resolved(services)).toEqual(new Set([Used.key]));
  });

  test("a key deleted while the task runs is gone for it, unless it already counted as resolving everything", () => {
    const services = tracked();
    const seen = runWith(
      services,
      Effect.gen(function* () {
        // Many lookups under an overlay: Effect may flatten the map into a copy, and must iterate it to do so.
        for (let n = 0; n < 10_000; n++) yield* use.pipe(Effect.provideService(Added, "added"));
        services.delete(Unused.key);
        return yield* Effect.serviceOption(Unused).pipe(Effect.provideService(Added, "added"));
      }),
    );
    expect(Option.isNone(seen) || services.read.has(Unused.key)).toBe(true);
    // A task that has not, sees the deletion at once.
    const fresh = tracked();
    const revoked = runWith(
      fresh,
      Effect.gen(function* () {
        yield* use;
        fresh.delete(Unused.key);
        return yield* Effect.serviceOption(Unused);
      }),
    );
    expect(Option.isNone(revoked)).toBe(true);
  });

  test("copying the whole context counts as resolving all of it", () => {
    const services = tracked();
    runWith(
      services,
      Effect.map(Effect.context<never>(), (context) => Context.merge(context, Context.make(Added, "added"))),
    );
    expect(resolved(services)).toEqual(new Set([Used.key, Unused.key]));
  });
});
