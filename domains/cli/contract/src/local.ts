import { Effect, Stream } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { answering, Channels, elementsOf, HostError, withChannel, withdrawnFrom } from "@lemma/contracts";
import type { ChannelDeclaration, ChannelStream } from "@lemma/contracts";

/*
 * A command reaching another domain on the host as a client does, through
 * the channels it serves rather than the capability behind them: so the
 * command's plugin requires nothing, and does not restart when that domain's
 * plugin reloads, and a call or a stream goes on across the reload as a
 * client's does. A call is the runtime's `callHere`, made again on the
 * replacement when `repeatable`; a stream is opened again (`followHere`).
 */

export { callHere } from "@lemma/contracts";

type Reader = Context.Service.Shape<typeof Registries>;

const isWithdrawn = (error: unknown, id: string) => error instanceof HostError && error.code === "Withdrawn" && error.subject === id;

/** Once one answers for `id` that is not `gone`, or no change is under way. */
const replaced = (registries: Reader, id: string, gone: unknown) =>
  Effect.raceFirst(
    registries.changes(Channels).pipe(
      Stream.filter((items) => {
        const now = answering(items, id);
        return now !== undefined && now !== gone;
      }),
      Stream.runHead,
      Effect.asVoid,
    ),
    registries.settled,
  );

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
  let gone: unknown;
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
    () => Effect.andThen(replaced(registries, id, gone), loop),
  );
  return loop;
};
