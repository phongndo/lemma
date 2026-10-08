import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Exit, Layer, Option, Queue, Scope } from "effect";
import type { Cause } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError, RpcGroup } from "effect/rpc";
import { Socket } from "effect/socket";
import { ChannelRpcs, HostError, HostRpcs, SUBSCRIBED_HEADER } from "@lemma/contracts";
import type { HostEvent } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { makeCore } from "@lemma/core";
import type { Core, CoreOptions, Plugin } from "@lemma/core";
import commands from "@lemma/plugin-commands";
import transport from "../src/index.ts";
import { fakeAgent, fakeGreeter, fakeHostControl, fakeInteraction, fakeLlm, fakePaths, fakeSessions, fakeWorkspace } from "./fakes.ts";
import type { ControlHolder } from "./fakes.ts";

/** What a client of the transport reaches: `HostRpcs` and `ChannelRpcs`. */
const ClientRpcs = HostRpcs.merge(ChannelRpcs);

export type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ClientRpcs>, RpcClientError.RpcClientError>;
export type EventBox = Queue.Dequeue<HostEvent, RpcClientError.RpcClientError | Cause.Done>;
export type Kind = "websocket" | "http";

export interface Host {
  readonly core: Core<any>;
  readonly url: string;
  readonly token: string;
  readonly home: string;
  readonly holder: ControlHolder;
  readonly connect: (kind: Kind, token?: string) => Effect.Effect<Client, never, Scope.Scope>;
}

export const connect = (url: string, token: string, kind: Kind): Effect.Effect<Client, never, Scope.Scope> =>
  Effect.gen(function* () {
    const protocol =
      kind === "websocket"
        ? RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
            Layer.provide(Socket.layerWebSocket(`${url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`)),
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
            Layer.provide(RpcSerialization.layerJson),
          )
        : // As `makeHostRpcHttp` does: the protocol would post to `<url>/`, which the host does not route.
          RpcClient.layerProtocolHttp({ url: `${url}/rpc/http`, transformClient: HttpClient.mapRequest(HttpClientRequest.setUrl(`${url}/rpc/http`)) }).pipe(
            // Without filterStatusOk the client parses a 401 body as NDJSON and waits forever.
            Layer.provide(
              Layer.effect(
                HttpClient.HttpClient,
                Effect.map(HttpClient.HttpClient, (client) =>
                  client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token)), HttpClient.filterStatusOk),
                ),
              ),
            ),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(RpcSerialization.layerNdjson),
          );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(ClientRpcs).pipe(Effect.provide(context));
  });

/** Mounts the transport on an ephemeral port with fakes behind it; the client finds it through `transport.json`. */
export const withHost = <A, E>(
  body: (host: Host) => Effect.Effect<A, E, Scope.Scope>,
  config: Record<string, unknown> = {},
  /** A caller-owned home outlives the host, so tests can inspect it afterwards. */
  owned?: string,
  /** More plugins to run beside the fakes. */
  extra: readonly Plugin[] = [],
  /** The core's lifecycle deadlines. */
  deadlines?: CoreOptions["deadlines"],
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = owned ?? (yield* Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-transport-"))));
        if (owned === undefined) yield* Effect.addFinalizer(() => Effect.promise(() => rm(home, { recursive: true, force: true })));
        const holder: ControlHolder = { restarted: [], off: {}, ui: { plugins: {}, enabledIn: {}, configIn: {}, files: [] } };
        const core = yield* makeCore(
          [
            transport,
            fakeAgent,
            fakeSessions,
            fakeLlm,
            fakeInteraction,
            fakeHostControl(holder),
            fakePaths(home),
            fakeWorkspace,
            commands,
            fakeGreeter,
            ...extra,
          ],
          {
            configs: { transport: { port: 0, interactionGraceMs: 100, ...config } },
            ...(deadlines === undefined ? {} : { deadlines }),
          },
        );
        holder.core = core;
        const found = yield* readDiscovery(home);
        if (found === undefined) return yield* Effect.die(new Error("no discovery file"));
        return yield* body({ core, url: found.url, token: found.token, home, holder, connect: (kind, token = found.token) => connect(found.url, token, kind) });
      }).pipe(Effect.timeout(Duration.seconds(20))),
    ),
  );

/** Takes events until one satisfies the predicate (inclusive). */
export const waitFor = (events: EventBox, done: (event: HostEvent) => boolean) => {
  const loop = (seen: HostEvent[]): Effect.Effect<HostEvent[]> =>
    Effect.flatMap(Effect.orDie(Queue.take(events)), (event) => (done(event) ? Effect.succeed([...seen, event]) : loop([...seen, event])));
  return loop([]).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
};

/** Subscribes and waits for the host's `subscribed`: from then on the subscription receives everything. */
export const subscribe = (client: Client) =>
  Effect.gen(function* () {
    const events = yield* client["Host.Events"](undefined, { asQueue: true, headers: { [SUBSCRIBED_HEADER]: "1" } });
    yield* waitFor(events, (event) => event.type === "subscribed");
    return events;
  });

/** The exit's typed failure, if it failed with one. */
export const failure = (exit: Exit.Exit<unknown, unknown>): unknown => Option.getOrUndefined(Exit.findErrorOption(exit));

export const hostError = (exit: Exit.Exit<unknown, unknown>): HostError => {
  const error = failure(exit);
  if (error instanceof HostError) return error;
  throw new Error(`Expected a HostError, got ${String(exit)}`);
};
