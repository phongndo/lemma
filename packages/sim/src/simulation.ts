import { Cause, Clock, Effect, Exit, Random } from "effect";
import type { Fiber } from "effect";
import { assert, Verify } from "@lemma/core";
import { SimClock } from "./clock.ts";
import { Prng } from "./random.ts";
import { SimScheduler } from "./scheduler.ts";

/** The event loop's own `setImmediate`, taken before anything could replace it: the driver's turn between batches. */
const realImmediate = globalThis.setImmediate;
/** Lets the promises settled so far run their callbacks (the microtask queue drains before a new event-loop turn). */
const drainMicrotasks = () => new Promise<void>((resolve) => realImmediate(resolve));

/** Batches run between two moves of the clock, at most: more is work that never settles. */
const MAX_BATCHES_PER_SETTLE = 1_000_000;

export interface SimulationOptions {
  readonly seed: number;
  /** Runs waiting batches of different fibers in an order drawn from the seed, not the order they became ready. */
  readonly shuffle?: boolean;
  /** The wall clock's time at the start (`SIM_EPOCH_MS` by default). */
  readonly epochMs?: number;
}

/** No work is left to run and no timer is set, yet what `run` waits for has not finished: a deadlock. */
export class Deadlock extends Error {
  override readonly name = "Deadlock";
}

/** What `run` waits for went on past its limit: a time on the simulation's clock, counted from when it began. */
export class TimeLimit extends Error {
  override readonly name = "TimeLimit";
}

/**
 * A run of Effect code in simulated time, deterministic for its seed: every fiber it starts has the simulation's
 * clock (`SimClock`), Effect's `Random` from the seed, `Verify` on, and a scheduler only the driver runs. The driver
 * runs whatever is ready until nothing is (`settle`), then moves the clock to the next timer, and again, so a run
 * takes as long as its work, not its waits. What it runs is held to the seams the README's "The driver" names; then
 * the same seed runs the same.
 */
export class Simulation {
  readonly seed: number;
  readonly random: Prng;
  readonly clock: SimClock;
  readonly scheduler: SimScheduler;
  /** Effect's `Random` for every fiber of the run: one source, so each draw moves it on, wherever it is drawn. */
  private readonly effectRandom: Random.Random;

  constructor(options: SimulationOptions) {
    this.seed = options.seed;
    this.random = new Prng(options.seed);
    this.clock = new SimClock(options.epochMs);
    const order = this.random.split("scheduler");
    this.scheduler = new SimScheduler(options.shuffle === true ? (count) => order.int(count) : undefined);
    this.effectRandom = this.random.split("effect").effect();
  }

  /** `effect` with what every fiber of the run has: the clock, Effect's `Random`, and `Verify`. */
  provide<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return effect.pipe(
      Effect.provideService(Clock.Clock, this.clock),
      Effect.provideService(Random.Random, this.effectRandom),
      Effect.provideService(Verify, true),
    );
  }

  /** Starts `effect` in the simulation; it runs as the driver runs (`settle`, `run`). */
  fork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
    return Effect.runFork(this.provide(effect), { scheduler: this.scheduler.scheduler });
  }

  /** Runs what is ready, and what that makes ready, until nothing is; the clock stays where it is. */
  async settle(): Promise<void> {
    for (let batches = 0; ; batches++) {
      assert(batches < MAX_BATCHES_PER_SETTLE, `the simulation ran ${MAX_BATCHES_PER_SETTLE} batches without settling`);
      await drainMicrotasks();
      if (!this.scheduler.runOne()) return;
    }
  }

  /**
   * Settles, then moves the clock to the next timer, until `done` says to stop: `false` once it has, as no timer
   * is set then. Fails `TimeLimit` when the next timer is past `limitMs` of simulated time since the simulation began
   * (not since this call: a simulation is one run, and its limit one time on its clock).
   */
  async drive(done: () => boolean, limitMs = 24 * 60 * 60 * 1000): Promise<boolean> {
    const limit = BigInt(limitMs) * 1_000_000n;
    for (;;) {
      await this.settle();
      if (done()) return true;
      const next = this.clock.nextDeadline();
      if (next === undefined) return false;
      if (next > limit) {
        throw new TimeLimit(`still running at ${this.clock.elapsed / 1_000_000n} ms of simulated time, its next timer past the limit of ${limitMs} ms`);
      }
      this.clock.advanceTo(next);
    }
  }

  /** Runs `effect` in the simulation to its end, moving the clock as it waits. Fails `Deadlock` if it never can end. */
  async run<A, E>(effect: Effect.Effect<A, E>, limitMs?: number): Promise<Exit.Exit<A, E>> {
    const fiber = this.fork(effect);
    const ended = await this.drive(() => fiber.pollUnsafe() !== undefined, limitMs);
    if (!ended) throw new Deadlock(`nothing left to run, and no timer set, at ${this.clock.elapsed / 1_000_000n} ms of simulated time`);
    return fiber.pollUnsafe()!;
  }

  /** As `run`, its value, or its failure thrown. */
  async value<A, E>(effect: Effect.Effect<A, E>, limitMs?: number): Promise<A> {
    const exit = await this.run(effect, limitMs);
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  }
}
