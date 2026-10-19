import { Clock, Effect, Random } from "effect";
import type { LlmFailure } from "@lemma/llm";

/** How a turn asks a failed model call again (`agent.loop`'s config, in milliseconds). */
export interface RetrySettings {
  /** Failed model calls asked again in a row before the turn ends in error (an overflow is asked again once even at 0). */
  readonly retries: number;
  /** Milliseconds before the first retry; each later one waits twice as long, up to `maxRetryDelay`. */
  readonly retryDelay: number;
  readonly maxRetryDelay: number;
}

/** The failed calls a turn asked again since the model last answered. */
export interface RetryStreak {
  /** How many, in a row. */
  readonly retries: number;
  /** One of them was an overflow (asked again once only). */
  readonly overflowed: boolean;
  /** The last of them failed as too long: the next request asks handlers to shorten the history. */
  readonly shorten: boolean;
}

/** No failed call asked again: the model answered last. */
export const noRetries: RetryStreak = { retries: 0, overflowed: false, shorten: false };

/** The streak once a call that failed with `failure` is asked again as `attempt`. */
export const retried = (streak: RetryStreak, failure: LlmFailure, attempt: number): RetryStreak => {
  const shorten = failure.kind === "overflow";
  return { retries: attempt, overflowed: streak.overflowed || shorten, shorten };
};

/** The longest wait a provider may ask for before a retry; a longer one is cut to this. */
const MAX_REQUESTED_DELAY_MS = 15 * 60_000;

/** The longest a retry waits: the longest delay a provider may ask for, or the backoff's longest with its jitter. */
export const longestWait = (settings: Pick<RetrySettings, "maxRetryDelay">): number =>
  Math.max(MAX_REQUESTED_DELAY_MS, Math.round(settings.maxRetryDelay * 1.2));

/**
 * Milliseconds before retry `attempt` (from 1): the provider's delay when it named one, else doubling backoff with
 * ±20% jitter. `jitter` is a draw from [0, 1), from Effect's `Random` so a test can seed it.
 */
const retryDelay = (settings: Pick<RetrySettings, "retryDelay" | "maxRetryDelay">, attempt: number, requested: number | undefined, jitter: number): number =>
  requested !== undefined
    ? Math.min(requested, MAX_REQUESTED_DELAY_MS)
    : Math.round(Math.min(settings.maxRetryDelay, settings.retryDelay * 2 ** (attempt - 1)) * (0.8 + jitter * 0.4));

/**
 * Whether a call that failed with `failure` is asked again, and when (epoch ms, from Effect's `Clock`): a transient or
 * rate-limit failure up to `retries` times in a row, and besides those, an overflow once (with a shortened history)
 * until the model answers. Draws from Effect's `Random` only for a backoff's jitter.
 */
export const nextRetry = (
  failure: LlmFailure,
  streak: RetryStreak,
  settings: RetrySettings,
): Effect.Effect<{ readonly reason: "failure"; readonly attempt: number; readonly at: number } | undefined> =>
  Effect.gen(function* () {
    const attempt = streak.retries + 1;
    const now = yield* Clock.currentTimeMillis;
    if (failure.kind === "overflow") return streak.overflowed ? undefined : { reason: "failure" as const, attempt, at: now };
    if (failure.kind === "fatal" || attempt - (streak.overflowed ? 1 : 0) > settings.retries) return undefined;
    return { reason: "failure" as const, attempt, at: now + retryDelay(settings, attempt, failure.retryAfterMs, yield* Random.next) };
  });
