import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { Effect, Layer, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { RpcSerialization, RpcServer } from "effect/rpc";
import type { Rpc, RpcGroup } from "effect/rpc";
import { HOST_PROTOCOL } from "@lemma/contracts";
import type { UiComposition } from "@lemma/contracts";
import { isInside, kindOf } from "@lemma/contracts/fs";
import { ServedRpcs } from "./channels.ts";
import type { ChannelLifetime } from "./channels.ts";

type HostHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof ServedRpcs>> | ChannelLifetime>;

/** Where the server listens: the bound address as Node reports it (`0.0.0.0`, `::1`), and the port. */
interface TcpAddress {
  readonly hostname: string;
  readonly port: number;
}

interface ServerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly version: string;
  readonly staticDir?: string | undefined;
  /** The web app's UI files; `/api/ui/<source>/<name>` serves only a file listed here. */
  readonly ui?: Effect.Effect<UiComposition>;
}

const equalTokens = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Bearer header for HTTP; `?token=` for WebSocket, whose browser API cannot set headers. */
const presented = (request: HttpServerRequest.HttpServerRequest, url: URL): string | undefined => {
  const header = request.headers["authorization"];
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return url.searchParams.get("token") ?? undefined;
};

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * A built web app: existing files are served as is; other extensionless GET
 * paths fall back to `index.html` for client-side routing. Paths cannot
 * escape `root`.
 */
const serveStatic = (root: string, pathname: string) =>
  Effect.gen(function* () {
    const notFound = HttpServerResponse.text("Not found", { status: 404 });
    const decoded = yield* Effect.try(() => decodeURIComponent(pathname)).pipe(Effect.orElseSucceed(() => undefined));
    if (decoded === undefined || decoded.includes("\0")) return notFound;
    const target = resolve(root, `.${decoded}`);
    if (!isInside(root, target)) return notFound;
    const isFile = (path: string) => Effect.promise(async () => (await kindOf(path)) === "file");
    if (yield* isFile(target)) return yield* HttpServerResponse.file(target);
    const last = decoded.slice(decoded.lastIndexOf("/") + 1);
    const index = join(root, "index.html");
    if (last.includes(".") || !(yield* isFile(index))) return notFound;
    return yield* HttpServerResponse.file(index, { headers: { "cache-control": "no-cache" } });
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.text("Cannot read file", { status: 500 }))));

/**
 * Binds the address and serves until the scope closes. `/rpc` (WebSocket,
 * JSON) and `/rpc/http` (streaming HTTP, NDJSON) share one handler set;
 * `/rpc*` and `/api*` require the token, static assets do not. UI files are
 * served under `/api` because they run in the page with its token.
 */
export const startServer = (options: ServerOptions, handlers: HostHandlers): Effect.Effect<TcpAddress, HttpServerError.ServeError, Scope.Scope> =>
  Effect.gen(function* () {
    // Upgraded WebSockets are not closed by `server.close`, and the platform's
    // WebSocket server (created lazily at the first upgrade) waits in its own
    // finalizer until every client has gone. So the listener and its sockets
    // live in an inner scope, and this outer finalizer, which runs before the
    // inner scope closes, stops listening and destroys every socket first.
    const sockets = new Set<Socket>();
    const node = createServer();
    node.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const inner = yield* Scope.fork(yield* Effect.scope, "sequential");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        node.close();
        for (const socket of sockets) socket.destroy();
      }),
    );
    return yield* serve(options, handlers, node).pipe(Scope.provide(inner));
  });

const serve = (options: ServerOptions, handlers: HostHandlers, node: ReturnType<typeof createServer>) =>
  Effect.gen(function* () {
    const handlerContext = yield* Layer.build(handlers);
    const websocket = yield* RpcServer.toHttpEffectWebsocket(ServedRpcs).pipe(Effect.provide(RpcSerialization.layerJson), Effect.provide(handlerContext));
    const http = yield* RpcServer.toHttpEffect(ServedRpcs).pipe(Effect.provide(RpcSerialization.layerNdjson), Effect.provide(handlerContext));
    const platform = yield* Layer.build(NodeHttpServer.layerHttpServices);
    const root = options.staticDir === undefined ? undefined : resolve(options.staticDir);

    const app: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Scope.Scope> = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;
      if (under(path, "/rpc") || under(path, "/api")) {
        const token = presented(request, url);
        if (token === undefined || !equalTokens(token, options.token)) {
          return HttpServerResponse.jsonUnsafe({ error: "Unauthorized" }, { status: 401 });
        }
        if (path === "/rpc") return yield* websocket;
        if (path === "/rpc/http" && request.method === "POST") return yield* http;
        if (path === "/api/health") return HttpServerResponse.jsonUnsafe({ ok: true, version: options.version, protocol: HOST_PROTOCOL });
        if (under(path, "/api/ui") && options.ui !== undefined && (request.method === "GET" || request.method === "HEAD")) {
          const listed = (yield* options.ui).files.find((file) => file.url.slice(0, file.url.indexOf("?")) === path);
          if (listed === undefined) return HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });
          // The version in the URL makes an edited file a new URL, so nothing needs revalidating by date.
          return yield* HttpServerResponse.file(listed.path, { headers: { "cache-control": "no-cache" } }).pipe(
            Effect.provide(platform),
            Effect.catch(() => Effect.succeed(HttpServerResponse.text("Cannot read file", { status: 500 }))),
          );
        }
        return HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return HttpServerResponse.empty({ status: 405 });
      if (root === undefined) return HttpServerResponse.text("No web app is configured (transport config `staticDir`)", { status: 404 });
      return yield* serveStatic(root, path).pipe(Effect.provide(platform));
    });

    const server = yield* NodeHttpServer.make(() => node, { host: options.host, port: options.port });
    yield* server.serve(app);
    const address = node.address();
    if (address === null || typeof address === "string") return yield* Effect.die(new Error("Expected a TCP listener"));
    return { hostname: address.address, port: address.port } satisfies TcpAddress;
  });
