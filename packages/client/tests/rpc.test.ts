import { describe, expect, test } from "vitest";
import { Effect, Exit, Layer, Stream } from "effect";
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

const tick = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));

/** Waits in real time for `done`, since the socket opens and writes on real timers; slow CI runners need more than one tick. */
const until = (done: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !(yield* done()); i++) yield* tick;
  });

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
          const events = yield* Effect.forkChild(Stream.runDrain(raw(rpc)["Host.Events"]()));
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
});

describe("HostRpcClient", () => {
  test("leaves out the streams' RPCs, which only this package reads, so reading one raw fails to compile", () => {
    const misuse = (rpc: HostRpcClient, tag: string) => {
      // @ts-expect-error The host's events are read through `eventsOver`.
      void rpc["Host.Events"];
      // @ts-expect-error A channel's stream is read through `channelsOver`.
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
