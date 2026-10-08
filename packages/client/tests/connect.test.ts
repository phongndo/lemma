import { describe, expect, test } from "vitest";
import { Layer, Schema } from "effect";
import { Socket } from "effect/socket";
import { defineChannel, HostInfo } from "@lemma/contracts";
import { connect } from "../src/host.ts";
import type { ConnectionStatus, Host } from "../src/host.ts";

type Request = { readonly _tag: string; readonly id?: string | number; readonly tag?: string; readonly payload?: unknown };
type Answer = (request: Request, reply: (message: unknown, after?: number) => void) => void;

/** A host on the other end of the socket, answering each request the way `answer` says, in Effect RPC's JSON; one that does not `open` fails. */
class ScriptedWebSocket extends EventTarget {
  readyState = 0;
  private readonly answer: Answer;
  constructor(answer: Answer, opens = true) {
    super();
    this.answer = answer;
    setTimeout(() => {
      if (!opens) return this.fail(1006);
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }
  /** Ends the connection with `code`: as a network that fails does (1006, after an error), or as the host does, closing it. */
  fail(code: number) {
    this.readyState = 3;
    if (code === 1006) this.dispatchEvent(new Event("error"));
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
  send(data: string) {
    const reply = (message: unknown, after = 0) => setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })), after);
    for (const request of [JSON.parse(data) as Request | Request[]].flat()) {
      if (request._tag === "Ping") reply({ _tag: "Pong" });
      else this.answer(request, reply);
    }
  }
  close() {
    this.readyState = 3;
  }
}

const info = Schema.encodeSync(HostInfo)({ version: "0.0.0", cwd: "/", home: "/", composition: { id: "c", plugins: [] }, runtime: [] });

/** Resolves once `host` has a status `found` accepts. */
const statusWhere = (host: Host, found: (status: ConnectionStatus) => boolean) =>
  new Promise<void>((resolve) => {
    const stop = host.onStatus((status) => {
      if (!found(status)) return;
      queueMicrotask(stop);
      resolve();
    });
  });

/** Every status of `host` up to its first `connected`; then it is closed. */
const untilConnected = async (host: Host): Promise<ConnectionStatus[]> => {
  const statuses: ConnectionStatus[] = [];
  try {
    await new Promise<void>((resolve) => {
      const stop = host.onStatus((status) => {
        statuses.push(status);
        if (status.state === "connected") {
          stop();
          resolve();
        }
      });
    });
  } finally {
    await host.close();
  }
  return statuses;
};

describe("connect", () => {
  test("is not connected by a subscription that ended after acknowledging it", async () => {
    let subscriptions = 0;
    const webSocket = Layer.succeed(
      Socket.WebSocketConstructor,
      () =>
        new ScriptedWebSocket((request, reply) => {
          if (request._tag !== "Request") return;
          if (request.tag === "Host.Info") {
            // Answered only once the first subscription has both acknowledged and failed.
            reply({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: info } }, 20);
          } else if (request.tag === "Host.Events") {
            reply({ _tag: "Chunk", requestId: request.id, values: [{ type: "subscribed" }] });
            if (++subscriptions === 1) {
              reply({ _tag: "Exit", requestId: request.id, exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "subscription dropped" }] } });
            }
          }
        }) as unknown as globalThis.WebSocket,
    );
    const statuses = await untilConnected(await connect({ url: "http://host.invalid", backoff: () => 1, webSocket }));
    expect(statuses.map(({ state, generation, attempts }) => ({ state, generation, attempts }))).toEqual([
      { state: "connecting", generation: 0, attempts: 0 },
      { state: "connecting", generation: 0, attempts: 1 },
      { state: "connected", generation: 1, attempts: 0 },
    ]);
    expect(statuses[1]?.error).toContain("subscription dropped");
    expect(subscriptions).toBe(2);
  });

  test("is not connected by a subscription that never says it is subscribed", async () => {
    let subscriptions = 0;
    const webSocket = Layer.succeed(
      Socket.WebSocketConstructor,
      () =>
        new ScriptedWebSocket((request, reply) => {
          if (request._tag !== "Request") return;
          if (request.tag === "Host.Info") reply({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: info } });
          // The first subscription stays silent; the next says it is subscribed.
          else if (request.tag === "Host.Events" && ++subscriptions > 1) reply({ _tag: "Chunk", requestId: request.id, values: [{ type: "subscribed" }] });
        }) as unknown as globalThis.WebSocket,
    );
    const statuses = await untilConnected(await connect({ url: "http://host.invalid", backoff: () => 1, probeTimeoutMs: 50, webSocket }));
    expect(statuses.map(({ state, generation, attempts }) => ({ state, generation, attempts }))).toEqual([
      { state: "connecting", generation: 0, attempts: 0 },
      { state: "connecting", generation: 0, attempts: 1 },
      { state: "connected", generation: 1, attempts: 0 },
    ]);
    expect(statuses[1]?.error).toBe("Timed out waiting for the host's events");
  });

  test("subscribes saying whether it answers the host's questions", async () => {
    for (const answers of [undefined, false]) {
      const host = flaky(() => "drop");
      await untilConnected(
        await connect({ url: "http://host.invalid", backoff: () => 1, webSocket: host.webSocket, ...(answers === undefined ? {} : { answers }) }),
      );
      expect(host.subscriptions).toEqual([{ answers: answers ?? true }]);
    }
  });
});

/** A channel that only reads, declared so: made again on the next connection when one drops. */
const read = defineChannel({ kind: "call", id: "test.read", payload: Schema.Void, success: Schema.Number, repeatable: true });
const write = defineChannel({ kind: "call", id: "test.write", payload: Schema.Void, success: Schema.Number });

/**
 * A host that answers `Host.Info` and `Host.Events`, and the `n`th `Channel.Call` as `call` says: with a number, or
 * by closing the connection as a network that fails does ("drop", 1006) or as the host does over a message too big
 * for it ("too big", 1009). While `down`, a new connection fails.
 */
const flaky = (call: (n: number) => number | "drop" | "too big") => {
  const host = {
    down: false,
    calls: [] as unknown[],
    subscriptions: [] as unknown[],
    webSocket: Layer.succeed(Socket.WebSocketConstructor, () => {
      const socket: ScriptedWebSocket = new ScriptedWebSocket((request, reply) => {
        if (request._tag !== "Request") return;
        if (request.tag === "Host.Info") reply({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: info } });
        else if (request.tag === "Host.Events") {
          host.subscriptions.push(request.payload);
          reply({ _tag: "Chunk", requestId: request.id, values: [{ type: "subscribed" }] });
        } else if (request.tag === "Channel.Call") {
          host.calls.push(request.payload);
          const answer = call(host.calls.length);
          if (typeof answer === "number") reply({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: answer } });
          else setTimeout(() => socket.fail(answer === "drop" ? 1006 : 1009), 0);
        }
      }, !host.down);
      return socket as unknown as globalThis.WebSocket;
    }),
  };
  return host;
};

describe("a call cut off by a dropped connection", () => {
  test("is made again once the connection is back when its declaration is repeatable, with what it sent", async () => {
    const host = flaky((n) => (n === 1 ? "drop" : 42));
    const connected = await connect({ url: "http://host.invalid", backoff: () => 1, webSocket: host.webSocket });
    try {
      expect(await connected.channel.call(read, undefined)).toBe(42);
    } finally {
      await connected.close();
    }
    expect(host.calls).toEqual([
      { id: "test.read", payload: null },
      { id: "test.read", payload: null },
    ]);
  });

  test("rejects when its declaration is not repeatable, when the host closed the connection over a message too big for it, or once the connection is closed", async () => {
    const cutOff = async (channel: typeof read | typeof write, how: "drop" | "too big", closing = false) => {
      const host = flaky((n) => (n === 1 ? how : 42));
      const connected = await connect({ url: "http://host.invalid", backoff: () => 1, webSocket: host.webSocket });
      await statusWhere(connected, (status) => status.state === "connected");
      if (closing) host.down = true;
      const call = connected.channel.call(channel, undefined).catch((error: unknown) => error);
      // Closed while it waits for a connection that does not come.
      if (closing) {
        await statusWhere(connected, (status) => status.state === "reconnecting");
        await connected.close();
      }
      const error = await call;
      // Connected again, where it would have been made again had it waited for that: it is not.
      if (!closing) await statusWhere(connected, (status) => status.state === "connected" && status.generation === 2);
      await connected.close();
      return { error, calls: host.calls.length };
    };
    expect(await cutOff(write, "drop")).toMatchObject({ error: { _tag: "RpcClientError" }, calls: 1 });
    expect(await cutOff(read, "too big")).toMatchObject({ error: { _tag: "RpcClientError", reason: { code: 1009 } }, calls: 1 });
    const closed = await cutOff(read, "drop", true);
    expect(closed.calls).toBe(1);
    expect((closed.error as Error).message).toBe("The connection to the host was closed");
  });
});
