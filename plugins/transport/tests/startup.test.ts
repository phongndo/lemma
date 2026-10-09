import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Channels, Inspectors, serveChannel } from "@lemma/contracts";
import { readDiscovery } from "@lemma/contracts/discovery";
import { definePlugin, makeCore, PluginContext } from "@lemma/core";
import { settled } from "../../../scripts/e2e.ts";
import { connect, hostError, hostPlugins, makeHolder, withHost } from "./harness.ts";
import type { Client, Kind } from "./harness.ts";

/**
 * Serves `warmup.echo` and `warmup.count`, adds the inspector `warmup.state`,
 * and finishes starting only once `ready` has run. Independent plugins start
 * in id order, so it starts after the transport, which is listening by then.
 */
const warmup = (ready: Effect.Effect<void>) =>
  definePlugin({
    id: "warmup",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        yield* owner.add(
          Channels,
          serveChannel({ kind: "call", id: "warmup.echo", payload: Schema.String, success: Schema.String }, (text) => Effect.succeed(text)),
        );
        yield* owner.add(
          Channels,
          serveChannel({ kind: "stream", id: "warmup.count", payload: Schema.Void, success: Schema.Number }, () => Stream.make(1, 2, 3)),
        );
        yield* owner.add(Inspectors, { id: "warmup.state", title: "State", snapshot: Effect.succeed({ warm: true }) });
        yield* ready;
      }).pipe(Effect.orDie),
    ),
  });

interface Starting {
  /** The address and token in transport.json. */
  readonly url: string;
  readonly token: string;
  readonly connect: (kind: Kind) => Effect.Effect<Client, never, Scope.Scope>;
  /** Whether the composition is up. */
  readonly up: Effect.Effect<boolean>;
  /** Lets `warmup` finish starting, and waits until the composition is up. */
  readonly release: Effect.Effect<void>;
}

/** Starts a host and runs `body` once transport.json appears, while `warmup` is still starting. */
const whileStarting = <A, E>(body: (host: Starting) => Effect.Effect<A, E, Scope.Scope>, config: Record<string, unknown> = {}): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "lemma-transport-")));
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(home, { recursive: true, force: true })));
        const holder = yield* makeHolder;
        const release = yield* Deferred.make<void>();
        // As the host app does, the core is attached once it has started: `HostControl.composition` waits for that.
        const starting = yield* Effect.forkChild(
          Effect.flatMap(
            makeCore([...hostPlugins(home, holder), warmup(Deferred.await(release))], { configs: { transport: { port: 0, ...config } } }),
            (core) => Deferred.succeed(holder.core, core),
          ),
        );
        const found = yield* readDiscovery(home).pipe(
          Effect.flatMap((entry) => (entry === undefined ? Effect.fail("not written yet") : Effect.succeed(entry))),
          Effect.retry(Schedule.spaced(Duration.millis(10))),
        );
        return yield* body({
          url: found.url,
          token: found.token,
          connect: (kind) => connect(found.url, found.token, kind),
          up: Deferred.isDone(holder.core),
          release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(starting)), Effect.orDie, Effect.asVoid),
        });
      }).pipe(Effect.timeout(Duration.seconds(20))),
    ),
  );

/** A request as `effect/rpc` writes it in JSON: no payload is `null`. */
const request = (id: string, tag: string, payload: unknown = null) => ({ _tag: "Request", id, tag, payload, headers: [] });

interface WireExit {
  readonly _tag: "Success" | "Failure";
  readonly value?: unknown;
}

interface WireMessage {
  readonly _tag: string;
  readonly requestId?: string;
  readonly exit?: WireExit;
  readonly values?: readonly unknown[];
}

/** What came back for each request, by id: its exit, and a stream's elements. */
interface Answers {
  readonly exits: ReadonlyMap<string, WireExit>;
  readonly elements: ReadonlyMap<string, readonly unknown[]>;
}

/**
 * Sends `requests` in order, over one WebSocket or in one streaming HTTP
 * request, and collects each one's exit and elements by id as they arrive.
 * The host takes them in that order, so once one is answered, those before it
 * have arrived.
 */
const send = (host: Starting, kind: Kind, requests: readonly ReturnType<typeof request>[]): Effect.Effect<Answers, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const exits = new Map<string, WireExit>();
      const elements = new Map<string, unknown[]>();
      const take = (message: WireMessage) => {
        if (message.requestId === undefined) return;
        if (message._tag === "Exit" && message.exit !== undefined) exits.set(message.requestId, message.exit);
        if (message._tag === "Chunk") elements.set(message.requestId, [...(elements.get(message.requestId) ?? []), ...(message.values ?? [])]);
      };
      if (kind === "websocket") {
        const socket = new WebSocket(`${host.url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(host.token)}`);
        await new Promise((opened, failed) => {
          socket.onopen = opened;
          socket.onerror = failed;
        });
        socket.onmessage = (event) => {
          for (const message of [JSON.parse(String(event.data)) as WireMessage | WireMessage[]].flat()) {
            take(message);
            // Over a WebSocket, the server sends a stream's next chunk, or its end, once the last is acknowledged.
            if (message._tag === "Chunk") socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
          }
        };
        for (const each of requests) socket.send(JSON.stringify(each));
        return { answers: { exits, elements }, close: () => socket.close() };
      }
      const abort = new AbortController();
      // The response starts once the first answer is ready.
      const response = await fetch(`${host.url}/rpc/http`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}` },
        body: requests.map((each) => `${JSON.stringify(each)}\n`).join(""),
        signal: abort.signal,
      });
      void (async () => {
        let buffer = "";
        for await (const text of response.body!.pipeThrough(new TextDecoderStream())) {
          buffer += text;
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) if (line !== "") take(JSON.parse(line));
        }
      })().catch(() => undefined);
      return { answers: { exits, elements }, close: () => abort.abort() };
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ answers }) => answers));

const arrived = (done: () => boolean) =>
  Effect.promise(async () => {
    if ((await settled(async () => done() || undefined)) === undefined) throw new Error("timed out");
  });

describe("startup", () => {
  for (const kind of ["websocket", "http"] satisfies Kind[]) {
    test(`over ${kind}, a request made once the host is found waits for its plugins and reaches their channel or inspector`, () =>
      whileStarting((host) =>
        Effect.gen(function* () {
          // transport.json is written once the transport listens, while the plugins after it are still starting.
          expect(yield* host.up).toBe(false);
          // `Interaction.List` is not held: once it is answered, the requests sent before it are at the gate.
          const held = ["call", "list", "open", "inspectors", "inspect"];
          const { exits, elements } = yield* send(host, kind, [
            request("call", "Channel.Call", { id: "warmup.echo", payload: "hi" }),
            request("list", "Channel.List"),
            request("open", "Channel.Open", { id: "warmup.count" }),
            request("inspectors", "Host.Inspectors"),
            request("inspect", "Host.Inspect", { id: "warmup.state" }),
            request("last", "Interaction.List"),
          ]);
          yield* arrived(() => exits.has("last"));
          expect(exits.get("last")).toEqual({ _tag: "Success", value: [] });
          // Without the gate, the call, the open, and the inspect would have failed `NotFound`, and the lists been empty.
          expect(held.map((id) => exits.get(id) ?? elements.get(id))).toEqual(held.map(() => undefined));
          yield* host.release;
          yield* arrived(() => held.every((id) => exits.has(id)));
          expect(exits.get("call")).toEqual({ _tag: "Success", value: "hi" });
          expect(exits.get("list")).toMatchObject({ _tag: "Success", value: expect.arrayContaining([{ id: "warmup.echo", kind: "call", source: "warmup" }]) });
          expect(exits.get("open")).toMatchObject({ _tag: "Success" });
          expect(elements.get("open")).toEqual([1, 2, 3]);
          expect(exits.get("inspectors")).toMatchObject({
            _tag: "Success",
            value: expect.arrayContaining([{ id: "warmup.state", title: "State", source: "warmup" }]),
          });
          expect(exits.get("inspect")).toEqual({ _tag: "Success", value: { warm: true } });
        }),
      ));

    test(`over ${kind}, a request still held at the startup timeout fails Unavailable; once the host is up, it is served`, () =>
      whileStarting(
        (host) =>
          Effect.gen(function* () {
            const client = yield* host.connect(kind);
            const message = "The host is still starting its plugins (waited 0.1s); try again once it has started";
            const call = hostError(yield* Effect.exit(client["Channel.Call"]({ id: "warmup.echo", payload: "hi" })));
            expect(call).toMatchObject({ code: "Unavailable", subject: "warmup.echo", message });
            // Held before the stream is looked for, so not `NotFound`.
            const opened = hostError(yield* Effect.exit(Stream.runDrain(client["Channel.Open"]({ id: "warmup.count" }))));
            expect(opened).toMatchObject({ code: "Unavailable", subject: "warmup.count", message });
            const list = hostError(yield* Effect.exit(client["Channel.List"]()));
            expect(list).toMatchObject({ code: "Unavailable", message });
            expect(list.subject).toBeUndefined();
            const inspect = hostError(yield* Effect.exit(client["Host.Inspect"]({ id: "warmup.state" })));
            expect(inspect).toMatchObject({ code: "Unavailable", subject: "warmup.state", message });
            const inspectors = hostError(yield* Effect.exit(client["Host.Inspectors"]()));
            expect(inspectors).toMatchObject({ code: "Unavailable", message });
            expect(yield* host.up).toBe(false);
            yield* host.release;
            expect(yield* client["Channel.Call"]({ id: "warmup.echo", payload: "hi" })).toBe("hi");
            expect(yield* Stream.runCollect(client["Channel.Open"]({ id: "warmup.count" }))).toEqual([1, 2, 3]);
            expect(yield* client["Host.Inspect"]({ id: "warmup.state" })).toEqual({ warm: true });
          }),
        { startupTimeoutMs: 100 },
      ));
  }

  test("a restarted transport's gate is open at once", () =>
    withHost(
      (host) =>
        Effect.gen(function* () {
          yield* host.core.restart("transport", { force: true });
          const found = yield* readDiscovery(host.home);
          const client = yield* connect(found!.url, found!.token, "websocket");
          // With no time to wait, a held request would fail `Unavailable`.
          expect(yield* client["Channel.Call"]({ id: "warmup.echo", payload: "hi" })).toBe("hi");
          expect(yield* client["Host.Inspect"]({ id: "warmup.state" })).toEqual({ warm: true });
        }),
      { startupTimeoutMs: 0 },
      undefined,
      [warmup(Effect.void)],
    ));
});
