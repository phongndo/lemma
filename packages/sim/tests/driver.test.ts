import { Clock, Deferred, Duration, Effect, Exit, Fiber, Random } from "effect";
import { describe, expect, it } from "vitest";
import { Verify } from "@lemma/core";
import { Deadlock, Prng, SIM_EPOCH_MS, SimClock, Simulation, TimeLimit } from "../src/index.ts";

/*
 * The driver's own contract: simulated time passes only as the driver moves it, waits cost no wall time, timers wake in
 * the order they are due and see their own time, and a run that cannot end is told apart from one that ends late.
 */

describe("SimClock", () => {
  it("starts at the epoch, moves only when advanced, and wakes timers in order, each at its own time", async () => {
    const clock = new SimClock();
    const woke: [string, number][] = [];
    void clock.after(30).then(() => woke.push(["b", clock.currentTimeMillisUnsafe()]));
    void clock.after(10).then(() => woke.push(["a", clock.currentTimeMillisUnsafe()]));
    void clock.after(30).then(() => woke.push(["c", clock.currentTimeMillisUnsafe()]));
    expect(clock.currentTimeMillisUnsafe()).toBe(SIM_EPOCH_MS);
    expect(clock.nextDeadline()).toBe(10_000_000n);
    expect(clock.advanceTo(30_000_000n)).toBe(3);
    await Promise.resolve();
    expect(woke.map(([name]) => name)).toEqual(["a", "b", "c"]);
    expect(clock.monotonicTimeNanosUnsafe()).toBe(30_000_000n);
  });

  it("steps the wall clock back without moving monotonic time or timers", () => {
    const clock = new SimClock();
    void clock.after(5);
    clock.stepWall(-60_000);
    expect(clock.currentTimeMillisUnsafe()).toBe(SIM_EPOCH_MS - 60_000);
    expect(clock.monotonicTimeNanosUnsafe()).toBe(0n);
    expect(clock.nextDeadline()).toBe(5_000_000n);
  });
});

describe("Prng", () => {
  it("draws the same from the same seed, and a part's own source is unmoved by another's draws", () => {
    const draws = (prng: Prng) => Array.from({ length: 5 }, () => prng.next());
    expect(draws(new Prng(7))).toEqual(draws(new Prng(7)));
    const a = new Prng(7);
    const b = new Prng(7);
    b.next();
    expect(draws(a.split("model"))).toEqual(draws(b.split("model")));
  });

  it("turns a non-empty subset of kinds on in a swarm, and draws only those", () => {
    const kinds = ["prompt", "cancel", "crash", "reload"] as const;
    for (let seed = 0; seed < 50; seed++) {
      const prng = new Prng(seed);
      const weights = prng.swarm(kinds);
      const on = kinds.filter((kind) => weights[kind] > 0);
      expect(on.length).toBeGreaterThan(0);
      for (let n = 0; n < 20; n++) expect(on).toContain(prng.weighted(weights));
    }
  });
});

describe("Simulation", () => {
  it("runs a day of sleeps at once, every fiber on its clock, random source, and Verify", async () => {
    const sim = new Simulation({ seed: 1 });
    const started = performance.now();
    const seen = await sim.value(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.hours(24));
        const child = yield* Effect.forkChild(
          Effect.all([
            Clock.currentTimeMillis,
            Random.next,
            Effect.gen(function* () {
              return yield* Verify;
            }),
          ]),
        );
        return yield* Fiber.join(child);
      }),
      25 * 60 * 60 * 1000,
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(seen[0]).toBe(SIM_EPOCH_MS + 24 * 60 * 60 * 1000);
    expect(seen[1]).toBe(new Prng(1).split("effect").next());
    expect(seen[2]).toBe(true);
  });

  it("tells a deadlock (nothing to run, no timer) from a run past its time limit", async () => {
    const sim = new Simulation({ seed: 1 });
    await expect(sim.run(Effect.flatMap(Deferred.make<void>(), Deferred.await))).rejects.toBeInstanceOf(Deadlock);
    await expect(new Simulation({ seed: 1 }).run(Effect.forever(Effect.sleep(Duration.seconds(1))), 10_000)).rejects.toBeInstanceOf(TimeLimit);
  });

  it("orders concurrent fibers' work the same for a seed, shuffled or not", async () => {
    const order = async (shuffle: boolean, seed: number) => {
      const sim = new Simulation({ seed, shuffle });
      const seen: number[] = [];
      const exit = await sim.run(
        Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          (index) =>
            Effect.andThen(
              Effect.yieldNow,
              Effect.sync(() => void seen.push(index)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      return seen.join();
    };
    expect(await order(false, 3)).toBe(await order(false, 3));
    expect(await order(true, 3)).toBe(await order(true, 3));
    const shuffled = new Set(await Promise.all([1, 2, 3, 4, 5, 6].map((seed) => order(true, seed))));
    expect(shuffled.size).toBeGreaterThan(1);
  });
});
