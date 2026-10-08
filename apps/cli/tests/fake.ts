import { Cause, Deferred, Effect, Exit, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { HostError } from "@lemma/contracts";
import type { HostEvent } from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import type { Connection } from "../src/command.ts";

/**
 * A stream a test feeds as it goes: `push` elements, or `fail` it, as a
 * plugin's reload withdraws it. `sent` waits until whoever reads it has
 * taken all that was pushed (the host has sent it).
 */
export interface Fed<A> {
  readonly stream: Stream.Stream<A, HostError>;
  readonly push: (...elements: readonly A[]) => void;
  readonly fail: (error: HostError) => void;
  readonly sent: Effect.Effect<void>;
}

export const fed = <A>(...first: readonly A[]): Fed<A> => {
  const queue = Effect.runSync(Queue.unbounded<A, HostError | Cause.Done>());
  const push = (...elements: readonly A[]) => {
    for (const element of elements) Queue.offerUnsafe(queue, element);
  };
  push(...first);
  const sent: Effect.Effect<void> = Effect.suspend(() => (Queue.sizeUnsafe(queue) === 0 ? Effect.void : Effect.andThen(Effect.yieldNow, sent)));
  return { stream: Stream.fromQueue(queue), push, fail: (error) => void Queue.failCauseUnsafe(queue, Cause.fail(error)), sent };
};

const notFound = (id: string) => new HostError({ code: "NotFound", subject: id, message: `No channel "${id}"` });

/** As many of a stream's elements as the RPC client holds unread (Effect's `streamBufferSize`). */
const BUFFER = 16;

/**
 * The host over a WebSocket, as the RPC client reads one: what the host sends,
 * in the order it sent it, by one reader. A stream's elements go into a
 * buffer of `BUFFER` the command reads from, and a full one holds the reader
 * back, so what was sent after it, a call's reply among it, waits until the
 * command reads that stream.
 */
const socket = (host: HostRpcClient): Effect.Effect<HostRpcClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const wire = yield* Queue.unbounded<Effect.Effect<void>>();
    yield* Effect.forkScoped(Effect.forever(Effect.flatten(Queue.take(wire))));
    const send = (frame: Effect.Effect<unknown>) => void Queue.offerUnsafe(wire, Effect.asVoid(frame));
    const reply = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(effect);
        const answered = yield* Deferred.make<A, E>();
        send(Deferred.done(answered, exit));
        return yield* Deferred.await(answered);
      });
    const stream = <A, E>(source: Stream.Stream<A, E>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const buffer = yield* Queue.bounded<A, E | Cause.Done>(BUFFER);
          // A stream the command closed takes nothing more, as the client's does: what was sent for it is dropped.
          yield* Effect.addFinalizer(() => Queue.shutdown(buffer));
          yield* Effect.forkScoped(
            Stream.runForEach(source, (element) => Effect.sync(() => send(Queue.offer(buffer, element)))).pipe(
              Effect.exit,
              Effect.map((exit) => send(Exit.isSuccess(exit) ? Queue.end(buffer) : Queue.failCause(buffer, exit.cause))),
            ),
          );
          return Stream.fromQueue(buffer);
        }),
      );
    return new Proxy(host, {
      get: (target, name: string) => {
        const rpc = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
        if (rpc === undefined) return undefined;
        return (...args: unknown[]) => {
          const answer = rpc(...args);
          return Stream.isStream(answer) ? stream(answer as Stream.Stream<unknown, unknown>) : reply(answer as Effect.Effect<unknown, unknown>);
        };
      },
    });
  });

/**
 * A host as a command reaches it, over both of its connections: `calls`
 * answers `Channel.Call` and `streams` serves `Channel.Open`, by channel id,
 * with payloads and results as they cross the wire (JSON); `Channel.List`
 * lists both. `events` is `Host.Events` after its `subscribed`; `rpcs`, any
 * other RPC. Over HTTP (`rpc`) each call is answered as it comes; over the
 * WebSocket (`live`) what the host sends is read in order (`socket`).
 */
export const fakeHost = (host: {
  readonly calls?: Readonly<Record<string, (payload: any) => Effect.Effect<unknown, HostError>>>;
  readonly streams?: Readonly<Record<string, (payload: any) => Stream.Stream<unknown, HostError>>>;
  readonly events?: Stream.Stream<HostEvent, HostError>;
  readonly rpcs?: Readonly<Record<string, (payload: any) => unknown>>;
}): Connection => {
  const calls = host.calls ?? {};
  const streams = host.streams ?? {};
  const rpc = {
    ...host.rpcs,
    "Host.Events": () => Stream.concat(Stream.succeed<HostEvent>({ type: "subscribed" }), host.events ?? Stream.never),
    "Channel.List": () =>
      Effect.succeed([
        ...Object.keys(calls).map((id) => ({ id, kind: "call", source: "fake" })),
        ...Object.keys(streams).map((id) => ({ id, kind: "stream", source: "fake" })),
      ]),
    // No result crosses as `null`, as `Schema.Void` encodes.
    "Channel.Call": ({ id, payload }: { id: string; payload?: unknown }) =>
      calls[id]?.(payload).pipe(Effect.map((result) => result ?? null)) ??
      Effect.fail(id in streams ? new HostError({ code: "NotFound", subject: id, message: `"${id}" is a stream, not a call: open it` }) : notFound(id)),
    "Channel.Open": ({ id, payload }: { id: string; payload?: unknown }) => streams[id]?.(payload) ?? Stream.fail(notFound(id)),
  } as unknown as HostRpcClient;
  return { target: { url: "http://host.test", token: "t" } as Connection["target"], rpc, live: socket(rpc) };
};
