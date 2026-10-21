import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, relative, resolve } from "node:path";
import { Deferred, Effect, Layer, Scope } from "effect";
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http";
// The modules, not the package's index: it loads every platform module, Redis's client among them (~600 modules).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { RpcSerialization, RpcServer } from "effect/rpc";
import type { Rpc, RpcGroup } from "effect/rpc";
import { HOST_PROTOCOL, WEB_IMPORTABLE } from "@lemma/contracts";
import type { WebComposition, WebFile } from "@lemma/contracts";
import { isInside } from "@lemma/contracts/fs";
import { serveStatic } from "./assets.ts";
import { ServedRpcs } from "./channels.ts";
import type { ChannelLifetime } from "./channels.ts";
import { ReplySent } from "./replies.ts";
import type { Replies } from "./replies.ts";
import type { Startup } from "./startup.ts";

type HostHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof ServedRpcs>> | ChannelLifetime | Startup | Replies>;

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
  /** Whether WebSocket messages and `/rpc/http` replies of 1 KiB or more go compressed to a client that accepts it (`COMPRESSION`). */
  readonly compression: boolean;
  /**
   * The files the web app loads from the plugin directories, which `/api/web/<source>@<version>/<name>` serves, with
   * the modules and stylesheets of a listed package's folder its web half may import (`webFileFor`).
   */
  readonly web?: Effect.Effect<WebComposition>;
}

const equalTokens = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * A web file's address may carry the token in its path (`/api/web/t/<token>/…`), as the web app writes it, so a module
 * a web half imports by a relative path, which keeps the path but not the query, carries it too.
 */
const WEB_TOKEN = /^\/api\/web\/t\/([^/]+)(\/.*)$/;

/** Bearer header for HTTP; `?token=` for WebSocket, whose browser API cannot set headers; or the web file's path. */
const presented = (request: HttpServerRequest.HttpServerRequest, url: URL): string | undefined => {
  const header = request.headers["authorization"];
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const inPath = WEB_TOKEN.exec(url.pathname)?.[1];
  return url.searchParams.get("token") ?? (inPath === undefined ? undefined : decodeURIComponent(inPath));
};

/**
 * The file `path` (`/api/web/<source>@<version>/<name>`, its token taken out) names: a listed web half or stylesheet,
 * or a module or stylesheet inside a listed package's folder (one its web half imports by a relative path,
 * `WEB_IMPORTABLE`), but nothing in its dependencies or hidden, and nothing outside it.
 */
const webFileFor = (files: readonly WebFile[], path: string): string | undefined => {
  const listed = files.find((file) => file.url.split("?")[0] === path);
  if (listed !== undefined) return listed.path;
  const asked = /^\/api\/web\/(user|project)@[^/]+\/(.+)$/.exec(path);
  if (asked === null) return undefined;
  const [, source, encoded] = asked as unknown as [string, string, string];
  let name: string;
  try {
    name = encoded.split("/").map(decodeURIComponent).join("/");
  } catch {
    return undefined;
  }
  const folder = name.split("/")[0]!;
  const owner = files.find((file) => file.source === source && file.name.includes("/") && file.name.split("/")[0] === folder);
  if (owner === undefined || !WEB_IMPORTABLE.has(extname(name))) return undefined;
  const pluginsDir = owner.path.slice(0, owner.path.length - owner.name.length);
  const packageDir = resolve(pluginsDir, folder);
  const file = resolve(pluginsDir, name);
  if (!isInside(packageDir, file)) return undefined;
  return relative(packageDir, file)
    .split(/[\\/]/)
    .some((part) => part === "node_modules" || part.startsWith("."))
    ? undefined
    : file;
};

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * `permessage-deflate` for what the host sends of 1 KiB or more (a thread's log, a listing, a finished message): zlib's
 * fastest level, a sixth of a log's bytes at half the time of the default level's. A delta, far smaller, goes as it
 * is. `ws` holds to the threshold only without context takeover: with it, it compresses every message.
 */
const COMPRESSION = { threshold: 1024, serverNoContextTakeover: true, zlibDeflateOptions: { level: 1 } } as const;

/**
 * A `/rpc/http` exchange's replies of 1 KiB or more, compressed as the client accepts: brotli at quality 4, else gzip at
 * its fastest level, which Node's `fetch` (the CLI's) offers. Either makes a log a fifth or less of its bytes at about
 * 3 ms a megabyte, as the WebSocket's does. A stream's replies go compressed as they come, each flushed at once.
 */
const compressReplies = HttpMiddleware.compression({
  algorithms: ["br", "gzip"],
  levels: { br: 4, gzip: 1 },
  minSize: COMPRESSION.threshold,
  compressible: (type) => type.startsWith("application/ndjson"),
});

/**
 * Binds the address and serves until the scope closes. `/rpc` (WebSocket,
 * JSON) and `/rpc/http` (streaming HTTP, NDJSON) share one handler set;
 * `/rpc*` and `/api*` require the token, static assets do not. Web halves are
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
    // A handler's defect fails its own request: by default it would end every request on the connection.
    const websocket = yield* RpcServer.toHttpEffectWebsocket(ServedRpcs, { disableFatalDefects: true }).pipe(
      Effect.provide(RpcSerialization.layerJson),
      Effect.provide(handlerContext),
    );
    const http = yield* RpcServer.toHttpEffect(ServedRpcs, { disableFatalDefects: true }).pipe(
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provide(handlerContext),
    );
    const platform = yield* Layer.build(NodeHttpServer.layerHttpServices);
    const exchange = options.compression ? compressReplies(http).pipe(Effect.provide(platform)) : http;
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
        if (path === "/rpc/http" && request.method === "POST") {
          // The exchange's replies have left once its response has: until then they wait in the response body's queue.
          const closed = Deferred.makeUnsafe<void>();
          NodeHttpServerRequest.toServerResponse(request).once("close", () => Deferred.doneUnsafe(closed, Effect.void));
          return yield* Effect.provideService(exchange, ReplySent, Deferred.await(closed));
        }
        if (path === "/api/health") return HttpServerResponse.jsonUnsafe({ ok: true, version: options.version, protocol: HOST_PROTOCOL });
        if (under(path, "/api/web") && options.web !== undefined && (request.method === "GET" || request.method === "HEAD")) {
          const tokened = WEB_TOKEN.exec(path);
          const file = webFileFor((yield* options.web).files, tokened === null ? path : `/api/web${tokened[2]}`);
          if (file === undefined) return HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });
          // TypeScript, its types stripped (erasable syntax only), so a web half may be written in it with no build.
          if (/\.m?ts$/.test(file)) {
            return yield* Effect.tryPromise(async () => stripTypeScriptTypes(await readFile(file, "utf8"), { mode: "strip" })).pipe(
              Effect.map((script) => HttpServerResponse.text(script, { contentType: "text/javascript", headers: { "cache-control": "no-cache" } })),
              Effect.catch((error) => Effect.succeed(HttpServerResponse.text(`Cannot serve ${file}: ${String(error)}`, { status: 500 }))),
            );
          }
          // The version in the URL makes an edited file a new URL, so nothing needs revalidating by date.
          return yield* HttpServerResponse.file(file, { headers: { "cache-control": "no-cache" } }).pipe(
            Effect.provide(platform),
            Effect.catch(() => Effect.succeed(HttpServerResponse.text("Cannot read file", { status: 500 }))),
          );
        }
        return HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return HttpServerResponse.empty({ status: 405 });
      if (root === undefined) return HttpServerResponse.text("No web app is configured (transport config `staticDir`)", { status: 404 });
      return yield* serveStatic(request, root, path).pipe(Effect.provide(platform));
    });

    const server = yield* NodeHttpServer.make(() => node, {
      host: options.host,
      port: options.port,
      ...(options.compression ? { websocket: { perMessageDeflate: COMPRESSION } } : {}),
    });
    yield* server.serve(app);
    const address = node.address();
    if (address === null || typeof address === "string") return yield* Effect.die(new Error("Expected a TCP listener"));
    return { hostname: address.address, port: address.port } satisfies TcpAddress;
  });
