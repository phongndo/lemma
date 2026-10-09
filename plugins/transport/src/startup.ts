import { Deferred, Duration, Effect } from "effect";
import type { Context } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { HostError } from "@lemma/contracts";
import type { CoreClosed, PluginContext } from "@lemma/core";

/**
 * Holds each request it wraps (the channels, and the runtime RPCs that read
 * registries) until the composition is first up. The transport listens, and
 * writes transport.json, while it is still activating: the plugins after it
 * have not started, and a starting composition's contributions (channels,
 * inspectors) become visible only once it is up, all together. A client that
 * found the host then would hear `NotFound` for a channel about to be served;
 * held, its request reaches that channel. One still held after the startup
 * timeout fails `Unavailable`, naming what the request names. The gate opens
 * once and stays open; a restarted transport's opens at once.
 */
export class Startup extends RpcMiddleware.Service<Startup>()("lemma/transport/Startup", { error: HostError }) {}

/**
 * The gate, opened once `up` (`HostControl.composition`) resolves. It is
 * awaited in background work: in the transport's setup it would wait on the
 * transport's own activation.
 */
export const startupGate = (
  owner: Context.Service.Shape<typeof PluginContext>,
  up: Effect.Effect<unknown>,
  timeout: Duration.Duration,
): Effect.Effect<Context.Service.Shape<typeof Startup>, CoreClosed> =>
  Effect.gen(function* () {
    const open = yield* Deferred.make<void>();
    yield* owner.background("open the startup gate", Effect.andThen(up, Deferred.succeed(open, undefined)));
    const unavailable = (payload: unknown) => {
      const id = (payload as { readonly id?: unknown } | undefined)?.id;
      return new HostError({
        code: "Unavailable",
        message: `The host is still starting its plugins (waited ${Duration.toSeconds(timeout)}s); try again once it has started`,
        ...(typeof id === "string" ? { subject: id } : {}),
      });
    };
    return (next, { payload }) =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(open)
          ? next
          : Deferred.await(open).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(unavailable(payload)) }), Effect.andThen(next)),
      );
  });
