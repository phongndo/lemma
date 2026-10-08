import { Cause, Effect, Queue, Stream } from "effect";
import { HostError } from "@lemma/contracts";
import type { HostEvent } from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import type { Connection } from "../src/command.ts";

/** A stream a test feeds as it goes: `push` elements, or `fail` it, as a plugin's reload withdraws it. */
export interface Fed<A> {
  readonly stream: Stream.Stream<A, HostError>;
  readonly push: (...elements: readonly A[]) => void;
  readonly fail: (error: HostError) => void;
}

export const fed = <A>(...first: readonly A[]): Fed<A> => {
  const queue = Effect.runSync(Queue.unbounded<A, HostError | Cause.Done>());
  const push = (...elements: readonly A[]) => {
    for (const element of elements) Queue.offerUnsafe(queue, element);
  };
  push(...first);
  return { stream: Stream.fromQueue(queue), push, fail: (error) => void Queue.failCauseUnsafe(queue, Cause.fail(error)) };
};

const notFound = (id: string) => new HostError({ code: "NotFound", subject: id, message: `No channel "${id}"` });

/**
 * A host as a command reaches it, over both of its connections: `calls`
 * answers `Channel.Call` and `streams` serves `Channel.Open`, by channel id,
 * with payloads and results as they cross the wire (JSON); `Channel.List`
 * lists both. `events` is `Host.Events` after its `subscribed`; `rpcs`, any
 * other RPC.
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
      calls[id]?.(payload).pipe(Effect.map((result) => result ?? null)) ?? Effect.fail(notFound(id)),
    "Channel.Open": ({ id, payload }: { id: string; payload?: unknown }) => streams[id]?.(payload) ?? Stream.fail(notFound(id)),
  } as unknown as HostRpcClient;
  return { target: { url: "http://host.test", token: "t" } as Connection["target"], rpc, live: Effect.succeed(rpc) };
};
