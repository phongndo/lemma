import { Effect, Random } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { LlmFailure } from "@lemma/llm";
import { longestWait, nextRetry, noRetries, retried } from "@lemma/agent/kit";
import type { RetryStreak } from "@lemma/agent/kit";

const settings = { retries: 3, retryDelay: 2_000, maxRetryDelay: 60_000 };

/** `nextRetry` at epoch 0, its jitter always `jitter`. */
const next = (failure: LlmFailure, streak: RetryStreak = noRetries, jitter = 0.5, using = settings) =>
  Effect.runPromise(
    nextRetry(failure, streak, using).pipe(
      Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => jitter }),
      Effect.provide(TestClock.layer()),
    ),
  );

/** The streak after `failures`, each asked again as `nextRetry` says, or `undefined` from the first it does not. */
const after = async (failures: readonly LlmFailure[]) => {
  let streak = noRetries;
  for (const failure of failures) {
    const retry = await next(failure, streak);
    if (retry === undefined) return undefined;
    streak = retried(streak, failure, retry.attempt);
  }
  return streak;
};

describe("retry policy", () => {
  it("asks a transient or rate-limit failure again up to `retries` times in a row, and a fatal one never", async () => {
    const transient: LlmFailure = { kind: "transient" };
    expect(await after([transient, transient, { kind: "rate-limit" }])).toEqual({ retries: 3, overflowed: false, shorten: false });
    expect(await after([transient, transient, transient, transient])).toBeUndefined();
    expect(await next({ kind: "fatal" })).toBeUndefined();
  });

  it("asks an overflow again once, at once, with the history shortened, besides the failures it counts", async () => {
    expect(await next({ kind: "overflow" })).toEqual({ reason: "failure", attempt: 1, at: 0 });
    expect(await after([{ kind: "overflow" }])).toEqual({ retries: 1, overflowed: true, shorten: true });
    expect(await after([{ kind: "overflow" }, { kind: "overflow" }])).toBeUndefined();
    // The overflow is not one of the `retries`.
    const transient: LlmFailure = { kind: "transient" };
    expect(await after([{ kind: "overflow" }, transient, transient, transient])).toEqual({ retries: 4, overflowed: true, shorten: false });
  });

  it("waits twice as long each time, ±20%, up to maxRetryDelay, or the delay the provider names, up to 15 minutes", async () => {
    expect((await next({ kind: "transient" }, noRetries, 0.5))?.at).toBe(2_000);
    expect((await next({ kind: "transient" }, noRetries, 0))?.at).toBe(1_600);
    expect((await next({ kind: "transient" }, { retries: 2, overflowed: false, shorten: false }, 0.5))?.at).toBe(8_000);
    expect(await next({ kind: "transient" }, { retries: 9, overflowed: false, shorten: false }, 0.99)).toBeUndefined();
    // The sixth would wait 64 seconds: it waits maxRetryDelay.
    expect((await next({ kind: "transient" }, { retries: 5, overflowed: false, shorten: false }, 0.5, { ...settings, retries: 10 }))?.at).toBe(60_000);
    expect((await next({ kind: "rate-limit", retryAfterMs: 120_000 }))?.at).toBe(120_000);
    expect((await next({ kind: "rate-limit", retryAfterMs: 3_600_000 }))?.at).toBe(15 * 60_000);
    expect(longestWait(settings)).toBe(15 * 60_000);
  });
});
