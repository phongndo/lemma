import { Effect, Stream } from "effect";
import type { Context } from "effect";
import type { Contribution, Registries } from "@lemma/core";
import { answeredOrSettled, elementsOf, isWithdrawn, resultOf, withChannel, withdrawnFrom } from "@lemma/contracts";
import type { Channel, ChannelDeclaration, ChannelStream } from "@lemma/contracts";

/*
 * A command reaching another domain on the host as a client does, through
 * the channels it serves rather than the capability behind them: so the
 * command's plugin requires nothing, and does not restart when that domain's
 * plugin reloads, and a call or a stream goes on across the reload as a
 * client's does. A `repeatable` call is made again on the replacement
 * (`withChannel`); a stream is opened again (`followHere`).
 */

type Reader = Context.Service.Shape<typeof Registries>;

/** Calls the channel `declaration` names, with what answers for its id, as the transport serves a client's call; values are not encoded. */
export const callHere = <Payload, Success>(
  registries: Reader,
  declaration: ChannelDeclaration<"call", Payload, Success>,
  payload: Payload,
): Effect.Effect<Success, unknown> =>
  withChannel(registries, declaration.id, "call", ({ item }, left) =>
    resultOf(item, payload, { left, withdrawn: withdrawnFrom(declaration.id, "call") }),
  ) as Effect.Effect<Success, unknown>;

/**
 * Reads the stream `declaration` names until it ends, handing each element to
 * `onElement` in turn: opened again with `payload()` (read at each opening)
 * when its plugin's reload withdraws it, so it starts afresh, as a client's
 * does (a domain's stream begins with `subscribed`). It fails as the stream
 * does, and `NotFound` when nothing answers for it.
 */
export const followHere = <Payload, Success, E>(
  registries: Reader,
  declaration: ChannelDeclaration<"stream", Payload, Success>,
  payload: () => Payload,
  onElement: (element: Success) => Effect.Effect<void, E>,
): Effect.Effect<void, unknown> => {
  const id = declaration.id;
  let gone: Contribution<Channel> | undefined;
  const once: Effect.Effect<void, unknown> = withChannel(registries, id, "stream", (contribution, left) => {
    gone = contribution;
    return Effect.raceFirst(
      Stream.runForEach(elementsOf(contribution.item as ChannelStream, payload()) as Stream.Stream<Success, unknown>, onElement),
      Effect.andThen(left, Effect.fail(withdrawnFrom(id, "stream"))),
    );
  });
  const loop: Effect.Effect<void, unknown> = Effect.catchIf(
    once,
    (error) => isWithdrawn(error, id),
    () => Effect.andThen(answeredOrSettled(registries, id, gone), loop),
  );
  return loop;
};
