import { Cause, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import type { Fiber } from "effect";
import { Rpc } from "effect/rpc";
import { Socket } from "effect/socket";
import { HostError } from "@lemma/contracts";
import type { InteractionRequest, RuntimeEvent } from "@lemma/contracts";
import { RuntimeRpcs } from "@lemma/contracts/runtime";
import type { HostRpcClient } from "@lemma/client";
import { openHost } from "../src/channels.ts";
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

/** What `Host.Info` answers: `connect` asks it of every connection. */
export const info = { version: "0.0.0", cwd: "/", home: "/", composition: { id: "fake", plugins: [] }, runtime: [] };

/** A message of Effect RPC's JSON protocol, one to a frame. */
interface Frame {
  readonly _tag: string;
  readonly id?: string | number;
  readonly tag?: string;
  readonly payload?: any;
  readonly requestId?: string | number;
}

/** How the host's answer to an RPC goes on the wire: its schemas' JSON codecs, as the transport encodes it. */
const exitOf = (tag: string, exit: Exit.Exit<unknown, unknown>): unknown =>
  Schema.encodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(RuntimeRpcs.requests.get(tag) as Rpc.Any)) as unknown as Schema.Codec<unknown, unknown>)(exit);

/** The client's end of a connection, as `globalThis.WebSocket` has it; the fake host answers what it sends. */
class Wire extends EventTarget {
  readyState = 0;
  /** What runs for each request, by its id: stopped when the client stops it or the connection drops. */
  readonly running = new Map<string | number, Fiber.Fiber<unknown, unknown>>();
  private readonly onFrame: (wire: Wire, frame: Frame) => void;
  private readonly onClose: (wire: Wire) => void;
  constructor(onFrame: (wire: Wire, frame: Frame) => void, onClose: (wire: Wire) => void) {
    super();
    this.onFrame = onFrame;
    this.onClose = onClose;
  }
  send(data: string) {
    for (const frame of [JSON.parse(data) as Frame | Frame[]].flat()) this.onFrame(this, frame);
  }
  close() {
    this.readyState = 3;
    this.onClose(this);
  }
  /** Sends a message, after what was sent before it; one the connection dropped first is lost. */
  deliver(message: unknown) {
    setTimeout(() => {
      if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }, 0);
  }
  /** Ends it with `code`: as a network that fails does (1006, after an error), or as the host does, closing it. */
  fail(code = 1006) {
    this.readyState = 3;
    if (code === 1006) this.dispatchEvent(new Event("error"));
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
}

/** A connection the test can drop: `drop` cuts it, and every new one fails until `restore`. */
export interface FakeHost extends Connection {
  readonly drop: () => void;
  readonly restore: () => void;
  /** Closes the connection as the host does over a message too big for it (1009); the next one is let in. */
  readonly refuseTooLarge: () => void;
  /** What each `Host.Events` subscription said it does: whether it answers questions. */
  readonly subscriptions: () => readonly boolean[];
  /** Resolves once the client has passed on `count` of the host's events to its listeners (`ConnectOptions.onEvent`). */
  readonly heard: (count: number) => Effect.Effect<void>;
}

/**
 * A host as a command reaches it, over both of its connections: `calls`
 * answers `Channel.Call` and `streams` serves `Channel.Open`, by channel id,
 * with payloads and results as they cross the wire (JSON); `Channel.List`
 * lists both. `events` is `Host.Events` after its `subscribed` and the
 * questions still open, sent to whoever is subscribed when an event comes
 * (none while the connection is down); `rpcs`, any other RPC
 * (`Interaction.List` among them). Over HTTP (`rpc`) each call is answered as it
 * comes. The `Host` (`host`) is `@lemma/client`'s, over a WebSocket that
 * speaks Effect RPC's JSON protocol, so what the command reads is what the
 * client reads from a host: `drop` cuts that connection. `backoff` is the
 * client's delay between attempts to reconnect (milliseconds): the socket
 * itself dials again half a second after it drops.
 */
export const fakeHost = (host: {
  readonly calls?: Readonly<Record<string, (payload: any) => Effect.Effect<unknown, HostError>>>;
  readonly streams?: Readonly<Record<string, (payload: any) => Stream.Stream<unknown, HostError>>>;
  readonly events?: Stream.Stream<RuntimeEvent, HostError>;
  readonly rpcs?: Readonly<Record<string, (payload: any) => unknown>>;
  readonly backoff?: number;
}): FakeHost => {
  const calls = host.calls ?? {};
  const streams = host.streams ?? {};
  const listing = () =>
    Effect.succeed([
      ...Object.keys(calls).map((id) => ({ id, kind: "call", source: "fake" })),
      ...Object.keys(streams).map((id) => ({ id, kind: "stream", source: "fake" })),
    ]);
  // No result crosses as `null`, as `Schema.Void` encodes.
  const call = ({ id, payload }: { id: string; payload?: unknown }) =>
    calls[id]?.(payload).pipe(Effect.map((result) => result ?? null)) ??
    Effect.fail(id in streams ? new HostError({ code: "NotFound", subject: id, message: `"${id}" is a stream, not a call: open it` }) : notFound(id));
  const rpcs: Readonly<Record<string, (payload: any) => unknown>> = {
    "Host.Info": () => Effect.succeed(info),
    "Interaction.List": () => Effect.succeed([]),
    "Interaction.Answer": () => Effect.void,
    "Interaction.Dismiss": () => Effect.void,
    "Channel.List": listing,
    "Channel.Call": call,
    ...host.rpcs,
  };
  const answer = (tag: string, payload: unknown): Effect.Effect<unknown, unknown> => {
    const handler = rpcs[tag];
    if (handler === undefined) return Effect.die(new Error(`The fake host does not answer ${tag}`));
    const answered = handler(payload);
    return Effect.isEffect(answered) ? (answered as Effect.Effect<unknown, unknown>) : Effect.succeed(answered);
  };
  const rpc = new Proxy({} as HostRpcClient, { get: (_, tag: string) => (payload: unknown) => answer(tag, payload) });

  /**
   * Who is subscribed to `Host.Events` now: each event goes to them as it comes, from the first subscription on. As
   * the transport does, a subscription says `subscribed`, then the questions still open (`Interaction.List`).
   */
  const subscribers = new Set<(event: RuntimeEvent) => void>();
  let publishing = false;
  const subscriptions: boolean[] = [];
  const subscribe = (answers: boolean) =>
    Stream.unwrap(
      Effect.gen(function* () {
        subscriptions.push(answers);
        const queue = yield* Queue.unbounded<RuntimeEvent>();
        const listener = (event: RuntimeEvent) => void Queue.offerUnsafe(queue, event);
        subscribers.add(listener);
        yield* Effect.addFinalizer(() => Effect.sync(() => subscribers.delete(listener)));
        const open = (yield* Effect.orDie(answer("Interaction.List", undefined))) as readonly InteractionRequest[];
        if (!publishing) {
          publishing = true;
          Effect.runFork(
            Stream.runForEach(host.events ?? Stream.never, (event) =>
              Effect.sync(() => {
                for (const each of subscribers) each(event);
              }),
            ),
          );
        }
        return Stream.concat(
          Stream.fromIterable<RuntimeEvent | { readonly type: "subscribed" }>([
            { type: "subscribed" },
            ...open.map((request): RuntimeEvent => ({ type: "interaction", request })),
          ]),
          Stream.fromQueue(queue),
        );
      }),
    );

  let up = true;
  /** How many of the host's events the client has passed on, and what waits for a count of them. */
  let told = 0;
  const awaited: { readonly count: number; readonly reached: Deferred.Deferred<void> }[] = [];
  const wires = new Set<Wire>();
  const hangUp = (wire: Wire) => {
    wires.delete(wire);
    for (const fiber of wire.running.values()) fiber.interruptUnsafe();
  };
  const serve = (wire: Wire, id: string | number, tag: string, payload: any) => {
    const stream =
      tag === "Host.Events"
        ? subscribe(payload.answers)
        : tag === "Channel.Open"
          ? (streams[payload.id]?.(payload.payload) ?? Stream.fail(notFound(payload.id)))
          : undefined;
    const work =
      stream === undefined
        ? answer(tag, payload)
        : Stream.runForEach(stream as Stream.Stream<unknown, unknown>, (element) =>
            Effect.sync(() => wire.deliver({ _tag: "Chunk", requestId: id, values: [element] })),
          );
    const fiber = Effect.runFork(Effect.exit(work).pipe(Effect.map((exit) => wire.deliver({ _tag: "Exit", requestId: id, exit: exitOf(tag, exit) }))));
    wire.running.set(id, fiber);
    fiber.addObserver(() => wire.running.delete(id));
  };
  const receive = (wire: Wire, frame: Frame) => {
    if (frame._tag === "Ping") wire.deliver({ _tag: "Pong" });
    else if (frame._tag === "Interrupt") wire.running.get(frame.requestId!)?.interruptUnsafe();
    else if (frame._tag === "Request") serve(wire, frame.id!, frame.tag!, frame.payload);
  };
  const dial = () => {
    const wire = new Wire(receive, hangUp);
    setTimeout(() => {
      if (wire.readyState !== 0) return;
      if (!up) return wire.fail();
      wire.readyState = 1;
      wires.add(wire);
      wire.dispatchEvent(new Event("open"));
    }, 0);
    return wire as unknown as globalThis.WebSocket;
  };
  return {
    target: { url: "http://host.test", token: "t" } as Connection["target"],
    rpc,
    host: (options) =>
      openHost(
        {
          url: "http://host.test",
          backoff: () => host.backoff ?? 100,
          webSocket: Layer.succeed(Socket.WebSocketConstructor, dial),
          ...options,
          // Counted for `heard`, whether or not the command listens.
          onEvent: (event) => {
            told++;
            for (const { count, reached } of awaited) if (told >= count) Deferred.doneUnsafe(reached, Effect.void);
            options.onEvent?.(event);
          },
        },
        rpc,
      ),
    subscriptions: () => [...subscriptions],
    heard: (count) =>
      Effect.suspend(() => {
        if (told >= count) return Effect.void;
        const reached = Deferred.makeUnsafe<void>();
        awaited.push({ count, reached });
        return Deferred.await(reached);
      }),
    drop: () => {
      up = false;
      for (const wire of wires) {
        hangUp(wire);
        wire.fail();
      }
    },
    refuseTooLarge: () => {
      for (const wire of wires) {
        hangUp(wire);
        wire.fail(1009);
      }
    },
    restore: () => {
      up = true;
    },
  };
};
