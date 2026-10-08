import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError, RpcGroup } from "effect/rpc";
import { Socket } from "effect/socket";
import { RuntimeRpcs } from "@lemma/contracts/runtime";

/** Every RPC the host serves (`RuntimeRpcs`), as Effect's RPC client makes them: held only in this package (see `makeHostRpc`). */
export type RawHostRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof RuntimeRpcs>, RpcClientError.RpcClientError>;

/**
 * The typed Effect surface of what the host serves (`RuntimeRpcs`), as
 * clients get it: `rpc["Host.Info"]()`, `rpc["Channel.Call"]({ id })`, ...
 * Its streams' RPCs, `Host.Events` and `Channel.Open`, are left out, so a
 * client reads them only through `eventsOver` and `channelsOver` (see
 * `makeHostRpc`); reading one raw fails to compile.
 */
export type HostRpcClient = Omit<RawHostRpcClient, "Host.Events" | "Channel.Open">;

/** The whole client behind one this package made, for its own readers of the streams' RPCs. */
export const raw = (rpc: HostRpcClient): RawHostRpcClient => rpc as RawHostRpcClient;

/**
 * `ws(s)://<origin>/rpc?token=…` for a page or host base URL. `http:` maps to
 * `ws:` and `https:` to `wss:`; an explicit `ws(s):` URL is kept.
 */
export const rpcUrl = (base: string, token: string | undefined): string => {
  const url = new URL("/rpc", base);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (token !== undefined && token !== "") url.searchParams.set("token", token);
  return url.toString();
};

/**
 * Connects for the lifetime of the scope over one multiplexed WebSocket with
 * JSON serialization. The socket reconnects by itself; calls in flight when it
 * drops fail with `RpcClientError`, and calls made while it is down fail fast.
 * Transient errors are not retried silently: a ping timeout (a connection
 * that died across sleep or a network change) must fail the `Host.Events`
 * subscription, or it would wait forever on a stream the server has dropped.
 *
 * Its streams (`Host.Events`, `Channel.Open`) are read only through this
 * package, which hands each element to a callback at once: `eventsOver`, and
 * `channelsOver`'s `open`, which `connect` and `follow` use. Effect's RPC
 * client reads the socket on one fiber, which puts a stream's chunk into that
 * request's bounded queue (16 elements) and only then acknowledges it, so a
 * consumer that stops taking a stream's elements suspends that fiber, and
 * every call and stream on the socket waits behind it: a reply its consumer
 * waits for never arrives. A client that orders or paces what it reads (the
 * CLI) does so in a queue of its own, after the callback. The rule holds by
 * construction: the client this hands out has no stream RPCs
 * (`HostRpcClient`), and `scripts/check-boundaries.ts` finds a client made
 * elsewhere. The owner is reporting the reader's behavior to Effect.
 */
export const makeHostRpc = (
  url: string,
  webSocket: Layer.Layer<Socket.WebSocketConstructor> = Socket.layerWebSocketConstructorGlobal,
): Effect.Effect<HostRpcClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(Socket.layerWebSocket(url)),
      Layer.provide(webSocket),
      Layer.provide(RpcSerialization.layerJson),
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(RuntimeRpcs).pipe(Effect.provide(context));
  });

/**
 * Connects over streaming HTTP (`POST <base>/rpc/http`, NDJSON), one request
 * per call: for scripts and CLIs that make a few calls and exit. A non-2xx
 * response (a wrong token's `401`) fails the call instead of being parsed as
 * NDJSON, which would wait forever.
 */
export const makeHostRpcHttp = (base: string, token: string | undefined): Effect.Effect<HostRpcClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const authorize = token === undefined || token === "" ? (request: HttpClientRequest.HttpClientRequest) => request : HttpClientRequest.bearerToken(token);
    const url = new URL("/rpc/http", base).toString();
    // The protocol posts to `<url>/` (it joins an empty path on), which the host does not route: set the URL whole.
    const protocol = RpcClient.layerProtocolHttp({ url, transformClient: HttpClient.mapRequest(HttpClientRequest.setUrl(url)) }).pipe(
      Layer.provide(
        Layer.effect(
          HttpClient.HttpClient,
          Effect.map(HttpClient.HttpClient, (client) => client.pipe(HttpClient.mapRequest(authorize), HttpClient.filterStatusOk)),
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson),
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(RuntimeRpcs).pipe(Effect.provide(context));
  });
