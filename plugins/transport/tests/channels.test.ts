import { describe, expect, test } from "vitest";
import { Cause, Data, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Schema, SchemaTransformation, Stream } from "effect";
import { Channels, FileSearchers, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { definePlugin, PluginContext, Registries } from "@lemma/core";
import { settled } from "../../../scripts/e2e.ts";
import type { Client, Kind } from "./harness.ts";
import { hostError, withHost } from "./harness.ts";

/** A plugin that adds `channels` when it starts. */
const serving = (id: string, ...channels: readonly Channel[]) =>
  definePlugin({
    id,
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) => Effect.forEach(channels, (channel) => owner.add(Channels, channel))).pipe(Effect.orDie),
    ),
  });

/** Opens `id` and returns its first element and the fiber reading the rest. */
const open = (client: Client, id: string) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<unknown>();
    const fiber = yield* Effect.forkChild(Stream.runForEach(client["Channel.Open"]({ id }), (element) => Deferred.succeed(first, element)));
    return { first: yield* Deferred.await(first), fiber };
  });

describe("channels", () => {
  test("a handler that dies fails its own request, and the connection's other requests go on", () => {
    const broken = definePlugin({
      id: "broken-search",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) => owner.add(FileSearchers, { id: "broken-search", search: () => Effect.die(new Error("searcher bug")) })).pipe(
          Effect.orDie,
        ),
      ),
    });
    const steady = serving(
      "steady",
      serveChannel({ kind: "stream", id: "steady.ticks", payload: Schema.Void, success: Schema.Number }, () => Stream.concat(Stream.make(1), Stream.never)),
    );
    return withHost(
      (host) =>
        Effect.gen(function* () {
          // One connection carries all of a WebSocket client's requests; streaming HTTP makes one per request.
          const client = yield* host.connect("websocket");
          const events = yield* Effect.forkChild(Stream.runDrain(client["Host.Events"]()));
          const sibling = yield* open(client, "steady.ticks");
          const exit = yield* Effect.exit(client["Files.Search"]({ cwd: "/tmp", query: "x" }));
          // The caller gets the defect, with its message, as its request's failure.
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Error).message).toBe("searcher bug");
          // The connection still answers, and nothing else on it ended.
          expect((yield* client["Host.Info"]()).version).toBeDefined();
          expect(events.pollUnsafe()).toBeUndefined();
          expect(sibling.fiber.pollUnsafe()).toBeUndefined();
          yield* Fiber.interrupt(events);
          yield* Fiber.interrupt(sibling.fiber);
        }),
      {},
      undefined,
      [broken, steady],
    );
  }, 30_000);

  test("a request whose schema throws, or whose result JSON cannot carry, fails alone", () => {
    const throwsOnBadText = Schema.String.pipe(
      Schema.decodeTo(
        Schema.Unknown,
        SchemaTransformation.transform({ decode: (text: string): unknown => JSON.parse(text), encode: (value) => JSON.stringify(value) }),
      ),
    );
    const numbersOnly = Schema.String.pipe(
      Schema.decodeTo(
        Schema.Unknown,
        SchemaTransformation.transform({
          decode: (text: string): unknown => text,
          encode: (value) => {
            if (typeof value !== "number") throw new Error("not a number");
            return String(value);
          },
        }),
      ),
    );
    const call = (id: string, success: Schema.Codec<any, any>, handle: () => unknown) =>
      serveChannel({ kind: "call", id, payload: Schema.Void, success }, handle);
    const shapes = serving(
      "shapes",
      call("shapes.bigint", Schema.Unknown, () => Effect.succeed({ n: 1n })),
      call("shapes.date", Schema.Unknown, () => Effect.succeed({ at: new Date(0) })),
      call("shapes.dropped", Schema.Unknown, () => Effect.succeed({ kept: 1, dropped: undefined })),
      // What the success schema can send, its JSON codec sends: NaN as a number would not survive JSON.
      call("shapes.nan", Schema.Number, () => Effect.succeed(Number.NaN)),
      call("shapes.void", Schema.Void, () => Effect.void),
      call("shapes.quits", Schema.Void, () => Effect.interrupt),
      serveChannel({ kind: "call", id: "shapes.parse", payload: throwsOnBadText, success: Schema.Unknown }, (value) => Effect.succeed(value)),
      serveChannel({ kind: "stream", id: "shapes.throws", payload: Schema.Void, success: numbersOnly }, () => Stream.make(1, "two")),
      serveChannel({ kind: "stream", id: "shapes.hole", payload: Schema.Void, success: Schema.Unknown }, () => Stream.make(1, undefined)),
      serveChannel({ kind: "stream", id: "shapes.steady", payload: Schema.Void, success: Schema.Number }, () => Stream.concat(Stream.make(1), Stream.never)),
    );
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const events = yield* Effect.forkChild(Stream.runDrain(client["Host.Events"]()));
          const steady = yield* open(client, "shapes.steady");
          const called = (id: string, payload?: unknown) => Effect.exit(client["Channel.Call"](payload === undefined ? { id } : { id, payload }));
          const opened = (id: string) => {
            const elements: unknown[] = [];
            return Effect.map(
              Effect.exit(Stream.runForEach(client["Channel.Open"]({ id }), (element) => Effect.sync(() => void elements.push(element)))),
              (exit) => ({ elements, exit }),
            );
          };

          // What `Schema.Unknown` holds must be JSON already: a BigInt, a Date, or an `undefined` field is refused, not reshaped.
          for (const id of ["shapes.bigint", "shapes.date", "shapes.dropped"]) {
            expect(hostError(yield* called(id))).toMatchObject({ code: "Failed", subject: id, message: expect.stringContaining("Expected JSON value") });
          }
          expect(yield* called("shapes.nan")).toEqual(Exit.succeed("NaN"));
          expect(yield* called("shapes.void")).toEqual(Exit.succeed(null));
          // Interruption stays interruption, never `Failed`.
          expect(Exit.hasInterrupts(yield* called("shapes.quits"))).toBe(true);
          expect(hostError(yield* called("shapes.parse", "{not json"))).toMatchObject({ code: "InvalidPayload", subject: "shapes.parse" });
          expect(yield* called("shapes.parse", '{"a":1}')).toEqual(Exit.succeed({ a: 1 }));
          const thrown = yield* opened("shapes.throws");
          expect(thrown.elements).toEqual(["1"]);
          expect(hostError(thrown.exit)).toMatchObject({ code: "Failed", subject: "shapes.throws", message: expect.stringContaining("not a number") });
          const hole = yield* opened("shapes.hole");
          expect(hole.elements).toEqual([1]);
          expect(hostError(hole.exit)).toMatchObject({ code: "Failed", subject: "shapes.hole", message: expect.stringContaining("Expected JSON value") });

          // Nothing else on the connection ended.
          expect((yield* client["Host.Info"]()).version).toBeDefined();
          expect(events.pollUnsafe()).toBeUndefined();
          expect(steady.fiber.pollUnsafe()).toBeUndefined();
        }),
      {},
      undefined,
      [shapes],
    );
  }, 30_000);

  test("a malformed channel is refused to the plugin adding it, so it never breaks the list or shadows a good one", () => {
    const refused: string[] = [];
    const sloppy = definePlugin({
      id: "sloppy",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          // A plugin file without types: a misspelt kind, under an id a good channel also uses, with a lower order.
          const error = yield* Effect.flip(
            owner.add(Channels, { kind: "subscription", id: "good.thing", payload: Schema.Void, success: Schema.Void, handle: () => Effect.void } as never, {
              order: -1,
            }),
          );
          refused.push(error.message);
        }),
      ),
    });
    const good = serving(
      "good",
      serveChannel({ kind: "call", id: "good.thing", payload: Schema.Void, success: Schema.String }, () => Effect.succeed("good")),
    );
    return withHost(
      (host) =>
        Effect.gen(function* () {
          expect(refused).toEqual(['Invalid item for lemma/channels: "good.thing": its `kind` must be "call" or "stream", not "subscription"']);
          const client = yield* host.connect("websocket");
          expect(yield* client["Channel.List"]()).toEqual([{ id: "good.thing", kind: "call", source: "good" }]);
          expect(yield* client["Channel.Call"]({ id: "good.thing" })).toBe("good");
        }),
      {},
      undefined,
      [sloppy, good],
    );
  }, 30_000);

  test("serves host plugins' channels with their own schemas; a failing one is an error naming it, not a crash", () => {
    class ProbeError extends Data.TaggedError("ProbeError")<{ readonly reason: "Busy"; readonly message: string }> {}
    // Adds channels without requiring anything, and with no change to the contracts or the transport.
    const probe = serving(
      "probe",
      serveChannel(
        {
          kind: "call",
          id: "probe.repeat",
          title: "Repeat",
          description: "The text, repeated",
          payload: Schema.Struct({ text: Schema.String, times: Schema.FiniteFromString }),
          success: Schema.Struct({ text: Schema.String, at: Schema.Date }),
        },
        ({ text, times }) => Effect.succeed({ text: text.repeat(times), at: new Date(0) }),
      ),
      serveChannel({ kind: "call", id: "probe.busy", payload: Schema.Void, success: Schema.Void }, () =>
        Effect.fail(new ProbeError({ reason: "Busy", message: "Busy right now" })),
      ),
      serveChannel({ kind: "call", id: "probe.dies", payload: Schema.Void, success: Schema.Void }, () => Effect.die(new Error("no state here"))),
      serveChannel({ kind: "call", id: "probe.throws", payload: Schema.Void, success: Schema.Void }, () => {
        throw new Error("thrown");
      }),
      serveChannel({ kind: "stream", id: "probe.count", payload: Schema.Struct({ to: Schema.Number }), success: Schema.NumberFromString }, ({ to }) =>
        Stream.range(1, to),
      ),
      serveChannel({ kind: "stream", id: "probe.wrong", payload: Schema.Void, success: Schema.Number }, () => Stream.make(1, "two" as unknown as number)),
    );
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          expect(yield* client["Channel.List"]()).toEqual([
            { id: "probe.repeat", kind: "call", title: "Repeat", description: "The text, repeated", source: "probe" },
            { id: "probe.busy", kind: "call", source: "probe" },
            { id: "probe.dies", kind: "call", source: "probe" },
            { id: "probe.throws", kind: "call", source: "probe" },
            { id: "probe.count", kind: "stream", source: "probe" },
            { id: "probe.wrong", kind: "stream", source: "probe" },
          ]);
          // The payload is decoded and the result encoded by the channel's own schemas, as JSON.
          expect(yield* client["Channel.Call"]({ id: "probe.repeat", payload: { text: "ab", times: "2" } })).toEqual({
            text: "abab",
            at: "1970-01-01T00:00:00.000Z",
          });
          expect(yield* Stream.runCollect(client["Channel.Open"]({ id: "probe.count", payload: { to: 3 } }))).toEqual(["1", "2", "3"]);
          const http = yield* host.connect("http");
          expect(yield* http["Channel.Call"]({ id: "probe.repeat", payload: { text: "a", times: "1" } })).toMatchObject({ text: "a" });
          expect(yield* Stream.runCollect(http["Channel.Open"]({ id: "probe.count", payload: { to: 2 } }))).toEqual(["1", "2"]);

          const call = (id: string, payload?: unknown) => Effect.exit(client["Channel.Call"](payload === undefined ? { id } : { id, payload }));
          expect(hostError(yield* call("nothing"))).toMatchObject({ code: "NotFound", subject: "nothing" });
          expect(hostError(yield* call("probe.count"))).toMatchObject({ code: "NotFound", message: '"probe.count" is a stream, not a call: open it' });
          const invalid = hostError(yield* call("probe.repeat", { text: "ab", times: "twice" }));
          expect(invalid).toMatchObject({ code: "InvalidPayload", subject: "probe.repeat" });
          expect(invalid.message).toContain("times");
          expect(hostError(yield* call("probe.busy"))).toMatchObject({ code: "Busy", subject: "probe.busy", message: "Busy right now" });
          expect(hostError(yield* call("probe.dies"))).toMatchObject({ code: "Failed", subject: "probe.dies", message: "no state here" });
          expect(hostError(yield* call("probe.throws"))).toMatchObject({ code: "Failed", subject: "probe.throws", message: "thrown" });
          const elements: unknown[] = [];
          const wrong = yield* Effect.exit(
            Stream.runForEach(client["Channel.Open"]({ id: "probe.wrong" }), (element) => Effect.sync(() => elements.push(element))),
          );
          expect(elements).toEqual([1]);
          expect(hostError(wrong)).toMatchObject({ code: "Failed", subject: "probe.wrong" });
          // The transport is still serving.
          expect((yield* client["Host.Info"]()).version).toBeDefined();
        }),
      {},
      undefined,
      [probe],
    );
  }, 30_000);

  test("a channel stream ends when its client goes away", () => {
    const lifecycle = Effect.runSync(Queue.unbounded<"opened" | "closed">());
    const endless = serving(
      "endless",
      serveChannel({ kind: "stream", id: "endless.ticks", payload: Schema.Void, success: Schema.Number }, () =>
        Stream.concat(Stream.make(1), Stream.never).pipe(Stream.onStart(Queue.offer(lifecycle, "opened")), Stream.ensuring(Queue.offer(lifecycle, "closed"))),
      ),
    );
    return withHost(
      (host) =>
        Effect.gen(function* () {
          for (const kind of ["websocket", "http"] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const client = yield* host.connect(kind);
                yield* Effect.forkScoped(Stream.runDrain(client["Channel.Open"]({ id: "endless.ticks" })));
                expect(yield* Queue.take(lifecycle)).toBe("opened");
              }),
            );
            const next = yield* Queue.take(lifecycle).pipe(
              Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.fail(new Error(`${kind}: still running`)) }),
            );
            expect(next).toBe("closed");
          }
        }),
      {},
      undefined,
      [endless],
    );
  }, 30_000);

  test("a channel stream fails Withdrawn when its plugin is replaced or stops, and stops running there; opening it again reaches the replacement", () => {
    let instances = 0;
    const running = new Set<number>();
    const trigger = Deferred.makeUnsafe<void>();
    // Each instance's stream says which instance it is, then waits forever.
    const ticking = definePlugin({
      id: "ticking",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const instance = ++instances;
          yield* owner.add(
            Channels,
            serveChannel({ kind: "stream", id: "ticking.instance", payload: Schema.Void, success: Schema.Number }, () =>
              Stream.concat(Stream.make(instance), Stream.never).pipe(
                Stream.onStart(Effect.sync(() => running.add(instance))),
                Stream.ensuring(Effect.sync(() => running.delete(instance))),
              ),
            ),
          );
        }).pipe(Effect.orDie),
      ),
    });
    // Streams from a queue its scope shuts down, so its stream ends as it stops: that too is Withdrawn, not the end.
    const fragile = definePlugin({
      id: "fragile",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const queue = yield* Effect.acquireRelease(Queue.unbounded<number>(), Queue.shutdown);
          yield* Queue.offer(queue, 7);
          yield* owner.add(
            Channels,
            serveChannel({ kind: "stream", id: "fragile.queue", payload: Schema.Void, success: Schema.Number }, () => Stream.fromQueue(queue)),
          );
          yield* owner.background("work", Effect.andThen(Deferred.await(trigger), Effect.fail("broken")), { required: true });
        }).pipe(Effect.orDie),
      ),
    });
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const before = yield* open(client, "ticking.instance");
          expect(before.first).toBe(1);
          yield* host.core.restart("ticking", { force: true });
          expect(hostError(yield* Fiber.await(before.fiber))).toMatchObject({ code: "Withdrawn", subject: "ticking.instance" });
          const after = yield* open(client, "ticking.instance");
          expect(after.first).toBe(2);
          expect([...running]).toEqual([2]);

          const doomed = yield* open(client, "fragile.queue");
          expect(doomed.first).toBe(7);
          yield* Deferred.succeed(trigger, undefined);
          expect(hostError(yield* Fiber.await(doomed.fiber))).toMatchObject({ code: "Withdrawn", subject: "fragile.queue" });
          expect(hostError(yield* Effect.exit(Stream.runDrain(client["Channel.Open"]({ id: "fragile.queue" }))))).toMatchObject({ code: "NotFound" });
        }),
      {},
      undefined,
      [ticking, fragile],
    );
  }, 30_000);

  /** Counts its running streams, and records how many still ran each time an instance's finalizers began. */
  const counted = () => {
    const state = { instances: 0, running: 0, atFinalizers: [] as number[] };
    const plugin = (burst: number) =>
      definePlugin({
        id: "endless",
        layer: Layer.effectDiscard(
          Effect.gen(function* () {
            const owner = yield* PluginContext;
            const instance = ++state.instances;
            yield* Effect.addFinalizer(() => Effect.sync(() => void state.atFinalizers.push(state.running)));
            yield* owner.add(
              Channels,
              serveChannel({ kind: "stream", id: "endless.ticks", payload: Schema.Void, success: Schema.Number }, () =>
                Stream.concat(Stream.range(1, burst).pipe(Stream.map((n) => instance * 1000 + n)), Stream.never).pipe(
                  Stream.onStart(Effect.sync(() => void state.running++)),
                  Stream.ensuring(Effect.sync(() => void state.running--)),
                ),
              ),
            );
          }).pipe(Effect.orDie),
        ),
      });
    return { state, plugin };
  };

  test("a reload ends a stream Withdrawn and stops it before its plugin's finalizers, though its client never acknowledged a chunk", () => {
    const { state, plugin } = counted();
    return withHost(
      (host) =>
        Effect.promise(async () => {
          // A raw WebSocket client: it reads what arrives but never sends the `Ack` the server waits for after each chunk.
          const socket = new WebSocket(`${host.url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(host.token)}`);
          await new Promise((opened, failed) => {
            socket.onopen = opened;
            socket.onerror = failed;
          });
          const messages: { _tag: string; exit?: unknown }[] = [];
          socket.onmessage = (event) => {
            const parsed = JSON.parse(String(event.data));
            messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
          };
          socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: "Channel.Open", payload: { id: "endless.ticks" }, headers: [] }));
          await arrived(() => messages.some((message) => message._tag === "Chunk"));
          const started = Date.now();
          await Effect.runPromise(host.core.restart("endless", { force: true }));
          // Told to stop when its channel left, not cut off at the dispose deadline.
          expect(Date.now() - started).toBeLessThan(2_000);
          await arrived(() => messages.some((message) => message._tag === "Exit"));
          expect(JSON.stringify(messages.find((message) => message._tag === "Exit")?.exit)).toContain('"code":"Withdrawn"');
          expect(state.running).toBe(0);
          expect(state.atFinalizers).toEqual([0]);
          socket.close();
        }),
      {},
      undefined,
      [plugin(1)],
    );
  }, 30_000);

  test("a reload stops a stream whose client stopped reading, its buffer full, before its plugin's finalizers", () => {
    const { state, plugin } = counted();
    return withHost(
      (host) =>
        Effect.gen(function* () {
          for (const kind of ["websocket", "http"] satisfies Kind[]) {
            const client = yield* host.connect(kind);
            const first = yield* Deferred.make<void>();
            // Takes one element and never returns: the client's buffer fills and it stops taking more.
            const reader = yield* Effect.forkChild(
              Stream.runForEach(client["Channel.Open"]({ id: "endless.ticks" }), () => Effect.andThen(Deferred.succeed(first, undefined), Effect.never)),
            );
            yield* Deferred.await(first);
            const started = Date.now();
            yield* host.core.restart("endless", { force: true });
            expect(Date.now() - started).toBeLessThan(2_000);
            expect(state.running).toBe(0);
            expect(state.atFinalizers.at(-1)).toBe(0);
            yield* Fiber.interrupt(reader);
          }
        }),
      {},
      undefined,
      [plugin(100)],
    );
  }, 30_000);

  test("a stream pulling from its plugin's state is never pulled once that plugin's finalizers ran", () => {
    const seen = { pulls: 0, afterFinalizers: 0 };
    const busy = definePlugin({
      id: "busy",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const state = { closed: false };
          yield* Effect.addFinalizer(() => Effect.sync(() => void (state.closed = true)));
          yield* owner.add(
            Channels,
            serveChannel({ kind: "stream", id: "busy.pull", payload: Schema.Void, success: Schema.Number }, () =>
              Stream.fromEffectRepeat(
                Effect.andThen(
                  Effect.yieldNow,
                  Effect.sync(() => {
                    seen.pulls++;
                    if (state.closed) seen.afterFinalizers++;
                    return seen.pulls;
                  }),
                ),
              ),
            ),
          );
        }),
      ),
    });
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* host.connect("websocket");
          const reader = yield* open(client, "busy.pull");
          const started = Date.now();
          yield* host.core.restart("busy", { force: true });
          expect(Date.now() - started).toBeLessThan(2_000);
          expect(hostError(yield* Fiber.await(reader.fiber))).toMatchObject({ code: "Withdrawn" });
          expect(seen.pulls).toBeGreaterThan(0);
          expect(seen.afterFinalizers).toBe(0);
        }),
      {},
      undefined,
      [busy],
    );
  }, 30_000);

  test("a call in flight when its plugin is replaced finishes on its own instance first; one past the dispose deadline is Withdrawn", () => {
    let instances = 0;
    // The first instance's calls say when they are in flight, and its read answers once the test lets it.
    const reading = Deferred.makeUnsafe<void>();
    const waiting = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const resource = definePlugin({
      id: "resource",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const instance = ++instances;
          const state = { closed: false };
          const never = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Effect.sync(() => void (state.closed = true)));
          yield* owner.add(
            Channels,
            serveChannel(
              {
                kind: "call",
                id: "resource.read",
                payload: Schema.Void,
                success: Schema.Struct({ instance: Schema.Number, closedWhenAnswered: Schema.Boolean }),
              },
              () =>
                Effect.suspend(() => (instance === 1 ? Effect.andThen(Deferred.succeed(reading, undefined), Deferred.await(release)) : Effect.void)).pipe(
                  Effect.map(() => ({ instance, closedWhenAnswered: state.closed })),
                ),
            ),
          );
          // Waits for something only its own instance would do: never, once it is replaced.
          yield* owner.add(
            Channels,
            serveChannel({ kind: "call", id: "resource.wait", payload: Schema.Void, success: Schema.Void }, () =>
              Effect.andThen(Deferred.succeed(waiting, undefined), Deferred.await(never)),
            ),
          );
        }),
      ),
    });
    return withHost(
      (host) =>
        Effect.gen(function* () {
          const registries = yield* host.core.run(Registries);
          const first = (yield* registries.items(Channels)).find((contribution) => contribution.item.id === "resource.read");
          const client = yield* host.connect("websocket");
          const read = yield* Effect.forkChild(Effect.exit(client["Channel.Call"]({ id: "resource.read" })));
          const wait = yield* Effect.forkChild(Effect.exit(client["Channel.Call"]({ id: "resource.wait" })));
          yield* Deferred.await(reading);
          yield* Deferred.await(waiting);
          const replacing = yield* Effect.forkChild(host.core.restart("resource", { force: true }));
          // The replacement answers new calls while the old instance drains.
          yield* Stream.runHead(
            registries.changes(Channels).pipe(Stream.filter((items) => items.some((item) => item.item.id === "resource.read" && item !== first))),
          );
          expect(yield* client["Channel.Call"]({ id: "resource.read" })).toEqual({ instance: 2, closedWhenAnswered: false });
          expect(replacing.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(read)).toEqual(Exit.succeed({ instance: 1, closedWhenAnswered: false }));
          expect(hostError(yield* Fiber.join(wait))).toMatchObject({ code: "Withdrawn", subject: "resource.wait" });
          yield* Fiber.join(replacing);
        }),
      {},
      undefined,
      [resource],
      { dispose: Duration.millis(600) },
    );
  }, 30_000);

  test("a synchronous endless stream whose client stopped reading leaves the host responsive and does not run ahead", () => {
    let produced = 0;
    const firehose = serving(
      "firehose",
      serveChannel({ kind: "stream", id: "firehose.all", payload: Schema.Void, success: Schema.Number }, () =>
        Stream.fromEffectRepeat(Effect.sync(() => ++produced)),
      ),
    );
    /** The count once it stops changing between two looks, which only come while the host's timers keep running. */
    const stalled = Effect.promise(() => {
      let last = -1;
      return settled(async () => {
        const now = produced;
        const same = now === last;
        last = now;
        return same ? now : undefined;
      });
    });
    return withHost(
      (host) =>
        Effect.gen(function* () {
          for (const kind of ["websocket", "http"] satisfies Kind[]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const client = yield* host.connect(kind);
                const first = yield* Deferred.make<void>();
                yield* Effect.forkScoped(
                  Stream.runForEach(client["Channel.Open"]({ id: "firehose.all" }), () => Effect.andThen(Deferred.succeed(first, undefined), Effect.never)),
                );
                yield* Deferred.await(first);
                const held = yield* stalled;
                expect(held, `${kind}: production stops once the client stops reading`).toBeDefined();
                // A client that stops reading a stream stalls its own connection; the host serves others.
                const other = yield* host.connect(kind);
                expect((yield* other["Host.Info"]()).version).toBeDefined();
                expect(produced).toBe(held);
              }),
            );
          }
        }),
      {},
      undefined,
      [firehose],
    );
  }, 30_000);
});

/** Waits in real time, as a raw socket's messages arrive on the event loop. */
const arrived = async (done: () => boolean) => {
  if ((await settled(async () => done() || undefined)) === undefined) throw new Error("timed out");
};
