import { Duration, Effect } from "effect";
import type { Clock } from "effect";
import { assert } from "@lemma/core";

const NANOS_PER_MILLI = 1_000_000n;

/** The wall clock's time when a simulated run starts: 2026-01-01, midnight UTC. */
export const SIM_EPOCH_MS = Date.UTC(2026, 0, 1);

interface Timer {
  readonly deadline: bigint;
  readonly seq: number;
  readonly wake: () => void;
}

/**
 * Effect's `Clock` for a simulation: time passes only when the driver moves it (`advanceTo`), so a five-minute timeout
 * costs nothing, and a sleep is a timer the driver can see (`nextDeadline`). Monotonic time counts from the run's
 * start; the wall clock starts at `epochMs` and can be stepped, back too, as a correction to a real one would be.
 */
export class SimClock implements Clock.Clock {
  private now = 0n;
  private wall: bigint;
  private seq = 0;
  /** In the order they are due: deadline, then the order they were set. */
  private readonly timers: Timer[] = [];

  constructor(epochMs: number = SIM_EPOCH_MS) {
    this.wall = BigInt(epochMs) * NANOS_PER_MILLI;
  }

  currentTimeMillisUnsafe(): number {
    return Number((this.wall + this.now) / NANOS_PER_MILLI);
  }
  readonly currentTimeMillis: Effect.Effect<number> = Effect.sync(() => this.currentTimeMillisUnsafe());
  currentTimeNanosUnsafe(): bigint {
    return this.wall + this.now;
  }
  readonly currentTimeNanos: Effect.Effect<bigint> = Effect.sync(() => this.currentTimeNanosUnsafe());
  monotonicTimeNanosUnsafe(): bigint {
    return this.now;
  }
  readonly monotonicTimeNanos: Effect.Effect<bigint> = Effect.sync(() => this.monotonicTimeNanosUnsafe());

  sleep(duration: Duration.Duration): Effect.Effect<void> {
    if (!Duration.isFinite(duration)) return Effect.never;
    const nanos = Duration.toNanosUnsafe(duration);
    if (nanos <= 0n) return Effect.yieldNow;
    return Effect.callback<void>((resume) => {
      const timer = this.set(this.now + nanos, () => resume(Effect.void));
      return Effect.sync(() => this.clear(timer));
    });
  }

  /** A promise that resolves after `millis` of simulated time: for the simulation's own fakes, written with promises. */
  after(millis: number): Promise<void> {
    return new Promise((resolve) => void this.set(this.now + BigInt(Math.max(0, Math.round(millis * 1e6))), resolve));
  }

  /** Simulated nanoseconds since the run started. */
  get elapsed(): bigint {
    return this.now;
  }

  /** Timers waiting. */
  get waiting(): number {
    return this.timers.length;
  }

  /** When the next timer is due, if one is set. */
  nextDeadline(): bigint | undefined {
    return this.timers[0]?.deadline;
  }

  /**
   * Moves time on to `deadline`, waking every timer due by then in the order they are due, each at its own time, so
   * the work it wakes reads the time it was due at. Returns how many it woke.
   */
  advanceTo(deadline: bigint): number {
    assert(deadline >= this.now, `time moves on, never back: ${deadline} is before ${this.now}`);
    let woken = 0;
    for (let next = this.timers[0]; next !== undefined && next.deadline <= deadline; next = this.timers[0]) {
      this.timers.shift();
      this.now = next.deadline;
      next.wake();
      woken++;
    }
    this.now = deadline;
    return woken;
  }

  /** The wall clock jumps by `millis`, back when negative, as a correction to a real one does; monotonic time and timers stay. */
  stepWall(millis: number): void {
    this.wall += BigInt(Math.round(millis)) * NANOS_PER_MILLI;
  }

  private set(deadline: bigint, wake: () => void): Timer {
    const timer: Timer = { deadline, seq: this.seq++, wake };
    let index = this.timers.length;
    while (index > 0 && this.timers[index - 1]!.deadline > deadline) index--;
    this.timers.splice(index, 0, timer);
    return timer;
  }

  private clear(timer: Timer): void {
    const index = this.timers.indexOf(timer);
    if (index >= 0) this.timers.splice(index, 1);
  }
}
