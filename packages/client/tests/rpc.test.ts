import { describe, expect, test } from "vitest";
import { Cause, Clock, Duration, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { makeHostRpc, raw, rpcUrl } from "../src/rpc.ts";
import type { HostRpcClient } from "../src/rpc.ts";

/** A socket that opens and then goes silent, as a connection does across laptop sleep or a network change. */
class SilentWebSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  constructor() {
    super();
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

/** The host's side of the late-timer tests: what it answers, and what the client's clock does. */
interface FakeHost {
  /** Whether it answers each ping at once, as a live host on the same machine does. */
  answering: boolean;
  /** Answers it holds back until the test sends them, as a live host behind a slow or reconnecting network's are; none while undefined. */
  held: (() => void)[] | undefined;
  /** How long after it was asked to each sleep ends, as a busy, throttled, or sleeping machine's timers do. */
  lateMillis: number;
  /** When each ping was written, by the test clock, from the start. */
  readonly pings: number[];
  readonly sockets: SilentWebSocket[];
}

class AnsweringWebSocket extends SilentWebSocket {
  readonly #host: FakeHost;
  readonly #now: () => number;
  constructor(host: FakeHost, now: () => number) {
    super();
    this.#host = host;
    this.#now = now;
  }
  override send(data: string) {
    super.send(data);
    if (!data.includes('"Ping"')) return;
    this.#host.pings.push(this.#now());
    const answer = () => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ _tag: "Pong" }) }));
    if (this.#host.held !== undefined) this.#host.held.push(answer);
    else if (this.#host.answering) queueMicrotask(answer);
  }
}

const tick = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));

/** Waits in real time for `done`, since the socket opens and writes on real timers; slow CI runners need more than one tick. */
const until = (done: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !(yield* done()); i++) yield* tick;
  });

/**
 * Subscribes to the host's events over a `FakeHost`, on a test clock whose
 * sleeps end `host.lateMillis` late: every sleep in scope, not only the
 * pinger's, which the tests' ping times show it reaches.
 */
const withFakeHost = <A>(body: (host: FakeHost, events: Fiber.Fiber<void, unknown>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const start = clock.currentTimeMillisUnsafe();
        const host: FakeHost = { answering: true, held: undefined, lateMillis: 20, pings: [], sockets: [] };
        const onTime = clock.sleep;
        clock.sleep = (duration) => onTime(Duration.sum(duration, Duration.millis(host.lateMillis)));
        const constructor = Layer.succeed(Socket.WebSocketConstructor, () => {
          const socket = new AnsweringWebSocket(host, () => clock.currentTimeMillisUnsafe() - start);
          host.sockets.push(socket);
          return socket as unknown as globalThis.WebSocket;
        });
        const rpc = yield* makeHostRpc("ws://host.invalid/rpc", constructor);
        const events = yield* Effect.forkChild(Stream.runDrain(raw(rpc)["Host.Events"]({ answers: true })));
        yield* until(() => Effect.sync(() => host.sockets[0]?.sent.some((line) => line.includes("Host.Events")) ?? false));
        return yield* body(host, events);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

/** Moves the test clock on, then waits in real time until the client has written `pings` pings or its subscription has ended. */
const advance = (host: FakeHost, events: Fiber.Fiber<void, unknown>, millis: number, pings: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.millis(millis));
    yield* until(() => Effect.sync(() => events.pollUnsafe() !== undefined || host.pings.length >= pings));
    yield* tick;
  });

const HOUR = 3_600_000;

/** Whether the subscription ended because the pinger declared the connection dead. */
const pingTimedOut = (exit: Exit.Exit<void, unknown> | undefined) => {
  if (exit === undefined || !Exit.isFailure(exit)) return false;
  const error = Cause.squash(exit.cause) as { readonly reason?: { readonly cause?: unknown } };
  return error.reason?.cause instanceof Error && error.reason.cause.message === "ping timeout";
};

describe("makeHostRpc", () => {
  test("a stalled connection fails the event subscription so the caller can reconnect and resync", async () => {
    const sockets: SilentWebSocket[] = [];
    const constructor = Layer.succeed(Socket.WebSocketConstructor, () => {
      const socket = new SilentWebSocket();
      sockets.push(socket);
      return socket as unknown as globalThis.WebSocket;
    });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* makeHostRpc("ws://host.invalid/rpc", constructor);
          const events = yield* Effect.forkChild(Stream.runDrain(raw(rpc)["Host.Events"]({ answers: true })));
          const subscribed = () => sockets[0]?.sent.some((line) => line.includes("Host.Events")) ?? false;
          yield* until(() => Effect.sync(subscribed));
          expect(subscribed()).toBe(true);
          // One ping goes unanswered; the next ping interval declares the connection dead.
          for (let i = 0; i < 3; i++) {
            yield* TestClock.adjust("10 seconds");
            yield* tick;
          }
          yield* until(() => Effect.sync(() => events.pollUnsafe() !== undefined));
          return events.pollUnsafe();
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
    expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
  });

  test("a live connection stays up when its ping ticks fire late", async () => {
    const result = await withFakeHost((host, events) =>
      Effect.gen(function* () {
        for (let i = 1; i <= 6; i++) yield* advance(host, events, 5020, i);
        return { pings: host.pings, sockets: host.sockets.length, ended: events.pollUnsafe() };
      }),
    );
    expect(result).toEqual({ pings: [5020, 10040, 15060, 20080, 25100, 30120], sockets: 1, ended: undefined });
  });

  test("a dead connection still fails on the next tick when its ping ticks fire late", async () => {
    const result = await withFakeHost((host, events) =>
      Effect.gen(function* () {
        host.answering = false;
        yield* advance(host, events, 5020, 1);
        yield* advance(host, events, 5020, 2);
        yield* until(() => Effect.sync(() => events.pollUnsafe() !== undefined));
        return { pings: host.pings, ended: events.pollUnsafe() };
      }),
    );
    expect(result.pings).toEqual([5020]);
    expect(pingTimedOut(result.ended)).toBe(true);
  });

  test("a live connection stays up across the machine sleeping, though its first answer on waking is slow", async () => {
    const result = await withFakeHost((host, events) =>
      Effect.gen(function* () {
        // The tick after the first ping is held back an hour, and on waking the network takes two seconds to answer.
        host.lateMillis = HOUR;
        yield* advance(host, events, 5020, 1);
        host.lateMillis = 20;
        host.held = [];
        yield* advance(host, events, HOUR + 5000, 2);
        yield* TestClock.adjust("2 seconds");
        yield* tick;
        const slow = events.pollUnsafe();
        for (const answer of host.held.splice(0)) answer();
        host.held = undefined;
        yield* tick;
        yield* advance(host, events, 3020, 3);
        yield* advance(host, events, 5020, 4);
        return { pings: host.pings, slow, sockets: host.sockets.length, ended: events.pollUnsafe() };
      }),
    );
    // Waking, it pings rather than failing a connection that may be live, waits for the answer until the next tick, and then pings as before.
    expect(result).toEqual({ pings: [5020, HOUR + 10020, HOUR + 15040, HOUR + 20060], slow: undefined, sockets: 1, ended: undefined });
  });

  test("a connection that died while the machine slept fails a tick after waking", async () => {
    const result = await withFakeHost((host, events) =>
      Effect.gen(function* () {
        // The tick after the first ping is held back an hour, and the host goes away meanwhile.
        host.lateMillis = HOUR;
        yield* advance(host, events, 5020, 1);
        host.lateMillis = 20;
        host.answering = false;
        yield* advance(host, events, HOUR + 5000, 2);
        const woke = events.pollUnsafe();
        yield* advance(host, events, 5020, 3);
        yield* until(() => Effect.sync(() => events.pollUnsafe() !== undefined));
        return { pings: host.pings, woke, ended: events.pollUnsafe() };
      }),
    );
    expect(result.pings).toEqual([5020, HOUR + 10020]);
    expect(result.woke).toBeUndefined();
    expect(pingTimedOut(result.ended)).toBe(true);
  });
});

describe("HostRpcClient", () => {
  test("leaves out the streams' RPCs, which only this package reads, so reading one raw fails to compile", () => {
    const misuse = (rpc: HostRpcClient, tag: string) => {
      // @ts-expect-error The host's events are read through `connect`'s `Host` (`onEvent`).
      void rpc["Host.Events"];
      // @ts-expect-error A channel's stream is read through `connect`'s `Host` (`channel.open`).
      const { "Channel.Open": open } = rpc;
      // @ts-expect-error Nor by a key worked out at run time.
      void rpc[tag];
      return open;
    };
    expect(misuse).toBeTypeOf("function");
  });
});

describe("rpcUrl", () => {
  test("maps http(s) origins to ws(s) with the token", () => {
    expect(rpcUrl("http://127.0.0.1:7433/app/", "a b")).toBe("ws://127.0.0.1:7433/rpc?token=a+b");
    expect(rpcUrl("https://example.com", undefined)).toBe("wss://example.com/rpc");
  });
});
