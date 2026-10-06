import { Cause, Duration, Effect, Exit, Option } from "effect";
import type { Scope } from "effect";

/** Poll until the predicate holds; dies after five seconds so a wrong expectation fails fast. */
export function waitFor<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean): Effect.Effect<A, E, R> {
  const poll: Effect.Effect<A, E, R> = Effect.flatMap(effect, (value) =>
    predicate(value) ? Effect.succeed(value) : Effect.sleep(Duration.millis(2)).pipe(Effect.zipRight(poll)),
  );
  return poll.pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
}

/** Runs `effect` in a scope that closes when it ends. */
export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> => Effect.runPromise(Effect.scoped(effect));

/** The error `exit` failed with; throws, failing the test, when it succeeded or ended otherwise. */
export function failure<E>(exit: Exit.Exit<unknown, E>): E {
  if (Exit.isSuccess(exit)) throw new Error("Expected a failure, but it succeeded");
  const error = Cause.failureOption(exit.cause);
  if (Option.isNone(error)) throw new Error(`Expected a failure, but: ${Cause.pretty(exit.cause)}`);
  return error.value;
}
