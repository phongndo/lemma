import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError, RpcGroup } from "effect/rpc";
import { Socket } from "effect/socket";
import { RuntimeRpcs } from "@lemma/contracts/runtime";

/** The typed Effect surface of what the host serves (`RuntimeRpcs`): `rpc["Host.Info"]()`, `rpc["Host.Events"]()`, `rpc["Channel.Call"]({ id })`, ... */
export type HostRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof RuntimeRpcs>, RpcClientError.RpcClientError>;

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
