import { describe, expect, test } from "vitest";
import { Layer, Schema } from "effect";
import { Socket } from "effect/socket";
import { HostInfo } from "@lemma/contracts";
import { connect } from "../src/host.ts";
import type { ConnectionStatus, Host } from "../src/host.ts";

type Request = { readonly _tag: string; readonly id?: string | number; readonly tag?: string };
type Answer = (request: Request, reply: (message: unknown, after?: number) => void) => void;

/** A host on the other end of the socket, answering each request the way `answer` says, in Effect RPC's JSON. */
class ScriptedWebSocket extends EventTarget {
  readyState = 0;
  private readonly answer: Answer;
  constructor(answer: Answer) {
    super();
    this.answer = answer;
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 0);
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

  test("without events, is connected by Host.Info alone, never subscribes, and connects anew once its socket closes", async () => {
    const tags: string[] = [];
    const sockets: ScriptedWebSocket[] = [];
    const webSocket = Layer.succeed(Socket.WebSocketConstructor, () => {
      const socket = new ScriptedWebSocket((request, reply) => {
        if (request._tag !== "Request") return;
        tags.push(request.tag!);
        if (request.tag === "Host.Info") reply({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: info } });
      });
      sockets.push(socket);
      return socket as unknown as globalThis.WebSocket;
    });
    const host = await connect({ url: "http://host.invalid", backoff: () => 1, webSocket, events: false });
    const statuses: ConnectionStatus[] = [];
    const generation = (n: number) =>
      new Promise<void>((resolve) => {
        const stop = host.onStatus((status) => {
          if (status.state !== "connected" || status.generation !== n) return;
          queueMicrotask(stop);
          resolve();
        });
      });
    host.onStatus((status) => void statuses.push(status));
    try {
      await generation(1);
      // A network that fails: the socket closes, with nothing in flight on it.
      sockets[0]!.readyState = 3;
      sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
      await generation(2);
    } finally {
      await host.close();
    }
    expect(statuses.map(({ state, generation }) => `${state} ${generation}`)).toContain("reconnecting 1");
    expect(statuses.find((status) => status.state === "reconnecting")?.error).toBe("Connection closed");
    expect(new Set(tags)).toEqual(new Set(["Host.Info"]));
  });
});
