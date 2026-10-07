import { Effect, Exit, Fiber } from "effect";
import type { Context } from "effect";
import { current, within } from "./internal/current.ts";

/**
 * What a callback handed to a contract may return: a value, a promise of one,
 * or an Effect. A contract that takes callbacks types them so, and its
 * provider runs each with `awaitable`, so plugins written with promises and
 * plugins written with Effects can both supply them.
 */
export type Awaitable<A, E = never, R = never> = A | PromiseLike<A> | Effect.Effect<A, E, R>;

/** Errors that fail an Effect, rather than being defects, when thrown or rejected from promise-based code. */
const failures = new WeakSet<object>();

const isObject = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * Marks `error` as an expected failure: thrown or rejected from a callback
 * run by `awaitable`, it fails the Effect with `error` (its typed error
 * channel) instead of being a defect. Returns it, so `throw fail(new
 * NotFound())` reads as it runs. Failures of Effects run for promise-based
 * code are marked already, so rethrowing one keeps it a failure. A value that
 * is not an object (a string, a number) is marked for the invocation it is
 * marked in: rethrown there it is that failure, and elsewhere, like any value
 * nobody marked, a defect.
 */
export const fail = <E>(error: E): E => {
  if (isObject(error)) failures.add(error);
  else current()?.invocation?.markFailure(error);
  return error;
};

/** Whether `error` is marked as an expected failure (see `fail`), in `invocation` when it is not an object. */
export const isExpectedFailure = (error: unknown, invocation?: Invocation): boolean =>
  isObject(error) ? failures.has(error) : invocation?.failed(error) === true;

/**
 * Something a callback returns that stands for an Effect, run in place when
 * returned rather than awaited (a promise-based hook handler's `next`).
 */
export const EffectOf: unique symbol = Symbol("@lemma/core/EffectOf");
interface StandsForEffect {
  readonly [EffectOf]: Effect.Effect<unknown, unknown, unknown>;
}
const standsForEffect = (value: unknown): value is StandsForEffect => isObject(value) && EffectOf in value;

const isThenable = (value: unknown): value is PromiseLike<unknown> => isObject(value) && typeof (value as { then?: unknown }).then === "function";

/**
 * A thrown or rejected value as an Effect's outcome: the abort of its
 * invocation's signal interrupts; a marked failure fails; anything else (an
 * `Error`, or a value, nobody marked) is a defect, so an Effect typed as
 * unable to fail never fails with a value its type does not admit.
 */
export const fromThrown = (error: unknown, invocation?: Invocation): Effect.Effect<never, any> =>
  invocation?.controller?.signal.aborted === true && error === invocation.controller.signal.reason
    ? Effect.interrupt
    : isExpectedFailure(error, invocation)
      ? Effect.fail(error)
      : Effect.die(error);

/**
 * What a callback runs inside: the signal it may be handed, created on first
 * use, and aborted when the Effect running it is interrupted. Promise-based
 * code started inside reaches it through `enter` (see `@lemma/core/plain`).
 */
export interface Invocation {
  readonly signal: () => AbortSignal;
  /** The Effect running the callback was interrupted: its signal is aborted, now or when created. */
  interrupted: boolean;
  controller: AbortController | undefined;
  /**
   * The fiber running what the callback returned, set once it has returned.
   * A call made after (from a microtask or a timer it queued) follows it
   * (`follow`), as one made before follows what it returned.
   */
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  /**
   * Aborts the signal if `fiber` is interrupted, until the returned release
   * is called (when the call that asked ends). Costs nothing before it is
   * set, or once interrupted.
   */
  readonly follow: () => () => void;
  /** Marks a value that is not an object as an expected failure within this invocation (see `fail`). */
  readonly markFailure: (value: unknown) => void;
  readonly failed: (value: unknown) => boolean;
}

/** A class, so an invocation costs one small object and no closure: most are never asked for their signal. */
class InvocationImpl implements Invocation {
  interrupted = false;
  controller: AbortController | undefined = undefined;
  fiber: Fiber.Fiber<unknown, unknown> | undefined = undefined;
  private failures: Set<unknown> | undefined = undefined;
  /** One observer of `fiber` while calls follow it, removed when the last of them ends. */
  private following: { readonly stop: () => void; count: number } | undefined = undefined;
  signal(): AbortSignal {
    if (this.controller === undefined) {
      this.controller = new AbortController();
      if (this.interrupted) this.controller.abort();
    }
    return this.controller.signal;
  }
  abort(): void {
    this.interrupted = true;
    this.controller?.abort();
  }
  follow(): () => void {
    if (this.fiber === undefined || this.interrupted) return noop;
    if (this.following === undefined) {
      const stop = this.fiber.addObserver((exit) => {
        if (Exit.hasInterrupts(exit)) this.abort();
      });
      if (this.interrupted) return noop;
      this.following = { stop, count: 0 };
    }
    const following = this.following;
    following.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--following.count > 0) return;
      following.stop();
      if (this.following === following) this.following = undefined;
    };
  }
  markFailure(value: unknown): void {
    (this.failures ??= new Set()).add(value);
  }
  failed(value: unknown): boolean {
    return this.failures?.has(value) === true;
  }
}

export const makeInvocation = (): Invocation => new InvocationImpl();

const noop = () => {};

/** Aborts what `invocation` started, now or when its signal is first asked for. */
const interrupt = (invocation: InvocationImpl) => Effect.sync(() => invocation.abort());

/**
 * Runs `callback` and makes what it returns an Effect: a value succeeds at
 * once, with no promise or extra turn; a promise is awaited; an Effect runs in
 * place. `enter` wraps the call (to make the invocation current while it
 * runs). The invocation's signal aborts if the Effect is interrupted while
 * the work is pending: a promise, or an Effect returned after the callback
 * started calls of its own. Calls it makes once it has returned follow the
 * fiber running it (`Invocation.follow`), which costs a call that makes none
 * nothing.
 */
export const settle = <A, E, R>(
  callback: (invocation: Invocation) => Awaitable<A, E, R>,
  enter?: <T>(invocation: Invocation, run: () => T) => T,
): Effect.Effect<A, E, R> => {
  const invocation = new InvocationImpl();
  let value: Awaitable<A, E, R>;
  try {
    value = enter === undefined ? callback(invocation) : enter(invocation, () => callback(invocation));
  } catch (error) {
    return fromThrown(error, invocation);
  }
  // From now on, a call it makes (from a microtask or timer it queued) follows the fiber running this.
  invocation.fiber = Fiber.getCurrent();
  const effect = Effect.isEffect(value) ? value : standsForEffect(value) ? (value[EffectOf] as Effect.Effect<A, E, R>) : undefined;
  // Calls it made already stop if what it returned is interrupted; one that made none costs nothing.
  if (effect !== undefined) return invocation.controller === undefined ? effect : effect.pipe(Effect.onInterrupt(() => interrupt(invocation)));
  if (isThenable(value)) {
    return Effect.callback<A, E, R>((resume) => {
      value.then(
        (success) => resume(Effect.succeed(success as A)),
        (error) => resume(fromThrown(error, invocation)),
      );
      return interrupt(invocation);
    });
  }
  return Effect.succeed(value as A);
};

/**
 * Runs promise-based `callback` inside the invocation of the Effect running
 * it: calls it makes through a plugin's promise-based services
 * (`@lemma/core/plain`) run in that Effect's context, so they keep its
 * references (who is asking, which trace) and stop when it is interrupted.
 */
export const inContext = <A, E, R>(callback: (invocation: Invocation) => Awaitable<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) =>
    settle(callback, (invocation, run) => within({ context: fiber.context as Context.Context<never>, invocation }, run)),
  ) as Effect.Effect<A, E, R>;

/**
 * Runs a callback that may return a value, a promise, or an Effect (see
 * `Awaitable`) as an Effect. A value succeeds at once, without a promise; a
 * promise is awaited, its rejection a defect unless the error was marked with
 * `fail`; an Effect runs in place. A callback that declares a parameter
 * receives an `AbortSignal`, aborted if the Effect is interrupted (one that
 * declares none costs no signal). Promise-based code it runs calls services
 * in this Effect's context, and is stopped with it.
 *
 *   const decision = yield* awaitable(() => guard(call));
 */
export function awaitable<A, E = never, R = never>(callback: (signal: AbortSignal) => Awaitable<A, E, R>): Effect.Effect<A, E, R> {
  return inContext((invocation) => (callback.length === 0 ? (callback as () => Awaitable<A, E, R>)() : callback(invocation.signal())));
}
