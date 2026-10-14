import { Context, Deferred, Effect, Fiber } from "effect";
import { RpcMiddleware, RpcSchema } from "effect/rpc";
import { Registry } from "@lemma/core";
import type { Contribution, Registries } from "@lemma/core";

/**
 * The transport's own registry, holding one item while it serves. A plugin's
 * disposal waits for the work run with its items (`Registries.run`), and that
 * work finds itself in `Admitted`: running each request with this item is how
 * the transport makes its requests such work, as any plugin could.
 */
export const Serving = Registry.make<"requests">("transport.server/serving");

/**
 * Completes once a request's reply has left the connection it was written
 * to: at once over a WebSocket, which writes it to the socket as the request
 * ends, and once the response has finished over streaming HTTP, which queues
 * it for the response body. `startServer` provides it per HTTP exchange.
 */
export const ReplySent = Context.Reference<Effect.Effect<void>>("lemma/transport/ReplySent", { defaultValue: () => Effect.void });

/**
 * Runs each request that is not a stream as the transport's work, from its
 * handler to its reply having left (`ReplySent`). So a change the request
 * asks for that restarts the transport finds the transport in `Admitted`, and
 * the host applies it once the reply has reached the client (`ChangeReport`).
 * The handler runs on a fiber of its own: once the transport is leaving, the
 * work stops holding its disposal and the request goes on unheld, cut off
 * with its connection as before, since it could be waiting on the very change
 * that is replacing the transport (a change's lock, `Registries.settled`).
 * A request that comes while no item is served (the transport starting or
 * leaving) runs unheld. A stream is never held: it would hold the transport's
 * disposal for as long as a client reads it. The item is looked up once, by
 * the first request that finds it, not on every request.
 */
export class Replies extends RpcMiddleware.Service<Replies>()("lemma/transport/Replies") {}

type Reader = Context.Service.Shape<typeof Registries>;

export const replies = (registries: Reader, pluginId: string): Context.Service.Shape<typeof Replies> => {
  let found: Contribution<"requests"> | undefined;
  const serving = Effect.suspend(() =>
    found !== undefined
      ? Effect.succeed(found)
      : Effect.map(registries.items(Serving), (items) => (found = items.find((contribution) => contribution.pluginId === pluginId))),
  );
  return (next, { rpc }) =>
    RpcSchema.isStreamSchema(rpc.successSchema)
      ? next
      : Effect.withFiber((request) => Effect.flatMap(serving, (item) => held(registries, item, request, next)));
};

const held = <A, E, R>(
  registries: Reader,
  serving: Contribution<"requests"> | undefined,
  request: Fiber.Fiber<unknown, unknown>,
  next: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (serving === undefined) return yield* next;
    const sent = yield* ReplySent;
    // Uninterruptible until the handler has started, which is at once: interrupted in between, it would run on unstopped.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const handling = yield* Deferred.make<Fiber.Fiber<A, E> | undefined>();
        yield* Effect.forkDetach(
          registries
            .run(serving, (left) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(handling, yield* Effect.forkDetach(next));
                // The request's fiber ends once it has written its reply.
                yield* Effect.raceFirst(Effect.andThen(Fiber.await(request), sent), left);
              }),
            )
            .pipe(Effect.catch(() => Deferred.succeed(handling, undefined))),
        );
        const handler = yield* Deferred.await(handling);
        if (handler === undefined) return yield* restore(next);
        return yield* restore(Fiber.join(handler)).pipe(Effect.onInterrupt(() => Fiber.interrupt(handler)));
      }),
    );
  });
