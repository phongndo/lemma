import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect";
import type { Context } from "effect";
import { TestClock } from "effect/testing";
import { definePlugin, Event, Events, makeCore, makeLoader, PluginContext, Registries } from "@lemma/core";
import type { PluginSource } from "@lemma/core";
import {
  channelProblem,
  Channels,
  defineChannel,
  elementsOf,
  eventFeed,
  optionalPayload,
  serveChannel,
  wireCodec,
  withChannel,
  withdrawnFrom,
} from "../src/channels.ts";
import type { CallLifetime } from "../src/channels.ts";
import { callServed } from "../src/testing.ts";

describe("channelProblem", () => {
  const good = { kind: "call", id: "probe.call", payload: Schema.Void, success: Schema.Void, handle: () => Effect.void };

  test("accepts a channel as serveChannel makes it, with or without a title and description", () => {
    expect(channelProblem(serveChannel({ kind: "call", id: "probe.call", payload: Schema.Void, success: Schema.Void }, () => Effect.void))).toBeUndefined();
    expect(channelProblem({ ...good, kind: "stream", title: "Probe", description: "Ticks", handle: () => Stream.empty })).toBeUndefined();
  });

  test("names what is wrong with an untyped plugin's item", () => {
    expect(channelProblem(undefined)).toBe("a channel is an object");
    expect(channelProblem({ ...good, id: "" })).toBe("its `id` must be a non-empty string");
    expect(channelProblem({ ...good, kind: "subscription" })).toBe('"probe.call": its `kind` must be "call" or "stream", not "subscription"');
    expect(channelProblem({ ...good, kind: undefined })).toBe('"probe.call": its `kind` must be "call" or "stream", not undefined');
    expect(channelProblem({ ...good, title: 1 })).toBe('"probe.call": its `title` must be a string');
    expect(channelProblem({ ...good, description: {} })).toBe('"probe.call": its `description` must be a string');
    expect(channelProblem({ ...good, payload: {} })).toBe('"probe.call": its `payload` must be a Schema');
    expect(channelProblem({ ...good, success: undefined })).toBe('"probe.call": its `success` must be a Schema');
    expect(channelProblem({ ...good, handle: "run" })).toBe('"probe.call": its `handle` must be a function');
    expect(channelProblem({ ...good, repeatable: "yes" })).toBe('"probe.call": its `repeatable` must be a boolean');
    expect(channelProblem({ ...good, kind: "stream", repeatable: true })).toBe('"probe.call": only a call is `repeatable`: a client reopens a stream itself');
    expect(channelProblem({ ...good, repeatable: true })).toBeUndefined();
  });

  test("a typed declaration cannot make a stream repeatable, and Channels refuses an untyped one", () => {
    // @ts-expect-error A stream is never repeatable: its client reopens it.
    const stream = defineChannel({ kind: "stream", id: "probe.stream", payload: Schema.Void, success: Schema.Void, repeatable: true });
    expect(channelProblem(serveChannel(stream, () => Stream.empty))).toContain("only a call is `repeatable`");
  });
});

describe("eventFeed", () => {
  const Ping = Event.make<number>("test/ping");
  const Pong = Event.make<string>("test/pong");
  const withEvents = <A>(body: (events: Context.Service.Shape<typeof Events>) => Effect.Effect<A>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([]), (core) => Effect.flatMap(core.run(Events), body))));
  const take = <A>(feed: Stream.Stream<A>, n: number) => Stream.runCollect(Stream.take(feed, n));

  test("sends first once every source has subscribed, so what is published from then on arrives after it", () =>
    withEvents((events) =>
      Effect.gen(function* () {
        // `first` itself publishes: only a source already subscribed hears it.
        const first = Effect.as(Effect.andThen(events.publish(Ping, 1), events.publish(Pong, "a")), "first");
        const feed = eventFeed(first, [Stream.map(events.stream(Ping), String), events.stream(Pong)]);
        const elements = yield* take(feed, 3);
        expect(elements[0]).toBe("first");
        expect(elements.slice(1).sort()).toEqual(["1", "a"]);
      }),
    ));

  test("keeps each source's order, and a client that falls behind loses the oldest", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Five moved on from the source before the client reads any: the feed keeps the latest three.
        const sent = yield* Deferred.make<void>();
        const source = Stream.concat(Stream.make(1, 2, 3, 4, 5), Stream.drain(Stream.fromEffect(Deferred.succeed(sent, undefined))));
        const feed = eventFeed(Effect.as(Deferred.await(sent), 0), [source], 3);
        expect(yield* take(feed, 4)).toEqual([0, 3, 4, 5]);
      }),
    ));
});

describe("optionalPayload", () => {
  const filters = wireCodec(optionalPayload({ cwd: Schema.optional(Schema.String) }));
  const decode = (payload: unknown) => Schema.decodeUnknownSync(filters)(payload);

  test("takes no payload (null on the wire) as no fields, and a payload as its fields", () => {
    expect(decode(null)).toEqual({});
    expect(decode({})).toEqual({});
    expect(decode({ cwd: "/work" })).toEqual({ cwd: "/work" });
    expect(Schema.encodeUnknownSync(filters)({ cwd: "/work" })).toEqual({ cwd: "/work" });
  });

  test("still rejects a malformed one", () => {
    expect(() => decode({ cwd: 1 })).toThrow();
    expect(() => decode("all")).toThrow();
  });
});

describe("callServed", () => {
  const declaration = { kind: "call", id: "echo.say", payload: Schema.String, success: Schema.String } as const;
  /** Serves `echo.say`, each instance answering with its number; the first's calls wait until `release`, taking no notice of its leaving. */
  const echoing = (release: Deferred.Deferred<void>, started: Deferred.Deferred<void>) => {
    let instances = 0;
    return definePlugin({
      id: "echo",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const instance = ++instances;
          yield* owner.add(
            Channels,
            serveChannel(declaration, (text) =>
              instance === 1 ? Effect.as(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release)), `1:${text}`) : `${instance}:${text}`,
            ),
          );
          yield* owner.add(
            Channels,
            serveChannel({ kind: "stream", id: "echo.all", payload: Schema.Void, success: Schema.String }, () => Stream.empty),
          );
        }).pipe(Effect.orDie),
      ),
    });
  };

  test("calls as the transport does: NotFound when no call answers, Withdrawn past the dispose deadline, and a channel that left before running is found again", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const core = yield* makeCore([echoing(release, started)], { deadlines: { dispose: Duration.millis(50) } });
          const registries = yield* core.run(Registries);
          expect(yield* Effect.flip(callServed(registries, "echo.none", "hi"))).toMatchObject({ code: "NotFound", subject: "echo.none" });
          expect(yield* Effect.flip(callServed(registries, "echo.all", undefined))).toMatchObject({
            code: "NotFound",
            subject: "echo.all",
            message: '"echo.all" is a stream, not a call: open it',
          });

          // A call that outlives its plugin's dispose deadline is interrupted, and Withdrawn, as a client's is.
          const waiting = yield* Effect.forkChild(Effect.flip(callServed(registries, "echo.say", "hi")));
          yield* Deferred.await(started);
          yield* core.restart("echo", { force: true });
          expect(yield* Fiber.join(waiting)).toEqual(withdrawnFrom("echo.say", "call"));

          // A call that found the channel just before a restart replaced it: a reader whose first look is from before.
          const stale = yield* registries.items(Channels);
          yield* core.restart("echo", { force: true });
          let looks = 0;
          const reader: typeof registries = {
            items: (registry) => (looks++ === 0 ? Effect.succeed(stale as never) : registries.items(registry)),
            changes: registries.changes,
            run: registries.run,
            settled: registries.settled,
          };
          expect(yield* callServed(reader, "echo.say", "late")).toBe("3:late");
        }),
      ),
    ));
});

describe("a request while what answers changes", () => {
  const read = { kind: "call", id: "patient.read", payload: Schema.String, success: Schema.String, repeatable: true } as const;
  const write = { kind: "call", id: "patient.write", payload: Schema.String, success: Schema.String } as const;
  const hold = { kind: "call", id: "patient.hold", payload: Schema.String, success: Schema.String } as const;
  const feed = { kind: "stream", id: "patient.feed", payload: Schema.Void, success: Schema.Number } as const;

  /**
   * A plugin (exclusive unless told otherwise) serving `patient.read` (repeatable) and `patient.write` (not), whose
   * calls wait until their instance leaves, and `patient.hold`, whose calls take no notice of that and wait to be
   * released, so their instance's disposal waits for them; `patient.feed` sends the instance's number. Instances from
   * `answering` (2) on answer those calls at once with their number, and instance `gate` (2) starts once opened.
   */
  const patient = (options: { readonly exclusive?: boolean; readonly answering?: number; readonly gate?: number | false } = {}) => {
    const answering = options.answering ?? 2;
    const started = { read: Deferred.makeUnsafe<void>(), write: Deferred.makeUnsafe<void>(), hold: Deferred.makeUnsafe<void>() };
    /** Completed once instance `n`'s finalizers run. */
    const finals = new Map<number, Deferred.Deferred<void>>();
    const final = (n: number) => {
      const found = finals.get(n) ?? Deferred.makeUnsafe<void>();
      finals.set(n, found);
      return found;
    };
    const opened = Deferred.makeUnsafe<void>();
    const released = Deferred.makeUnsafe<void>();
    let instances = 0;
    let answered = 0;
    const handle =
      (instance: number, call: keyof typeof started) =>
      (text: string, { left }: CallLifetime) => {
        if (instance >= answering)
          return Effect.sync(() => {
            answered++;
            return `${instance}:${text}`;
          });
        const begun = Deferred.succeed(started[call], undefined);
        return call === "hold"
          ? Effect.andThen(begun, Effect.as(Deferred.await(released), `${instance}:${text}`))
          : Effect.raceFirst(Effect.andThen(begun, Effect.never), left);
      };
    const plugin = definePlugin({
      id: "patient",
      exclusive: options.exclusive ?? true,
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          const instance = ++instances;
          yield* Effect.addFinalizer(() => Deferred.succeed(final(instance), undefined));
          if (instance === (options.gate ?? 2)) yield* Deferred.await(opened);
          yield* owner.add(Channels, serveChannel(read, handle(instance, "read")));
          yield* owner.add(Channels, serveChannel(write, handle(instance, "write")));
          yield* owner.add(Channels, serveChannel(hold, handle(instance, "hold")));
          yield* owner.add(
            Channels,
            serveChannel(feed, () => Stream.make(instance)),
          );
        }).pipe(Effect.orDie),
      ),
    });
    return {
      plugin,
      started,
      finalized: (n: number) => Deferred.await(final(n)),
      open: Deferred.succeed(opened, undefined),
      release: Deferred.succeed(released, undefined),
      answered: () => answered,
    };
  };
  /** Lets the fibers a step woke run on. */
  const settle = Effect.repeat(Effect.yieldNow, { times: 50 });
  const unanswered = { code: "Withdrawn", subject: "patient.read", message: expect.stringContaining("nothing answers for it now") };

  test("a repeatable call withdrawn while it waits is made again on the exclusive replacement once it starts; the old instance finalizes meanwhile, and a call not repeatable ends Withdrawn", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient();
          // A long dispose deadline: a repeat that held the old instance would hold its finalizers past the test's timeout.
          const core = yield* makeCore([served.plugin], { deadlines: { dispose: Duration.seconds(60) } });
          const registries = yield* core.run(Registries);
          const reading = yield* Effect.forkChild(callServed(registries, "patient.read", "hi"));
          const writing = yield* Effect.forkChild(Effect.flip(callServed(registries, "patient.write", "hi")));
          yield* Deferred.await(served.started.read);
          yield* Deferred.await(served.started.write);
          const restarting = yield* Effect.forkChild(core.restart("patient", { force: true }));
          // The old instance is gone, and nothing answers until the replacement starts: the read waits for it.
          yield* served.finalized(1);
          expect(yield* Fiber.join(writing)).toEqual(withdrawnFrom("patient.write", "call"));
          yield* settle;
          expect(reading.pollUnsafe()).toBeUndefined();
          yield* served.open;
          expect(yield* Fiber.join(reading)).toBe("2:hi");
          yield* Fiber.join(restarting);
        }),
      ),
    ));

  test("a repeatable call is made again on a replacement as soon as it answers, while the old instance is still held", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient({ exclusive: false, gate: false });
          const core = yield* makeCore([served.plugin]);
          const registries = yield* core.run(Registries);
          const reading = yield* Effect.forkChild(callServed(registries, "patient.read", "hi"));
          const holding = yield* Effect.forkChild(callServed(registries, "patient.hold", "on"));
          yield* Deferred.await(served.started.read);
          yield* Deferred.await(served.started.hold);
          // The replacement is published, then the old instance's disposal waits for the held call: the change goes on.
          const restarting = yield* Effect.forkChild(core.restart("patient", { force: true }));
          expect(yield* Fiber.join(reading)).toBe("2:hi");
          expect(restarting.pollUnsafe()).toBeUndefined();
          yield* served.release;
          expect(yield* Fiber.join(holding)).toBe("1:on");
          yield* Fiber.join(restarting);
        }),
      ),
    ));

  test("a repeatable call reaches an exclusive replacement however long its predecessor takes to stop", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient({ gate: false });
          const core = yield* makeCore([served.plugin], { deadlines: { dispose: Duration.minutes(2) } });
          const registries = yield* core.run(Registries);
          const reading = yield* Effect.forkChild(callServed(registries, "patient.read", "hi"));
          const holding = yield* Effect.forkChild(callServed(registries, "patient.hold", "on"));
          yield* Deferred.await(served.started.read);
          yield* Deferred.await(served.started.hold);
          // The old instance's disposal waits for the held call, and its replacement starts only after it.
          const restarting = yield* Effect.forkChild(core.restart("patient", { force: true }));
          yield* settle;
          yield* TestClock.adjust("1 minute");
          yield* settle;
          expect(reading.pollUnsafe()).toBeUndefined();
          yield* served.release;
          expect(yield* Fiber.join(holding)).toBe("1:on");
          expect(yield* Fiber.join(reading)).toBe("2:hi");
          yield* Fiber.join(restarting);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("a repeatable call fails Withdrawn as soon as the change has finished when nothing answers then, as when its plugin is turned off", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient();
          const source: PluginSource = { resolve: () => Effect.succeed(served.plugin) };
          const loader = yield* makeLoader({ source, composition: { plugins: { patient: {} } } });
          const registries = yield* loader.core.run(Registries);
          const reading = yield* Effect.forkChild(Effect.flip(callServed(registries, "patient.read", "hi")));
          yield* Deferred.await(served.started.read);
          yield* loader.apply({ plugins: { patient: { enabled: false } } });
          expect(yield* Fiber.join(reading)).toMatchObject(unanswered);
        }),
      ),
    ));

  test("a repeatable call fails Withdrawn at once when the core closes while it waits", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient();
          const scope = yield* Scope.make();
          const core = yield* Scope.provide(makeCore([served.plugin]), scope);
          const registries = yield* core.run(Registries);
          const reading = yield* Effect.forkChild(Effect.flip(callServed(registries, "patient.read", "hi")));
          yield* Deferred.await(served.started.read);
          yield* Scope.close(scope, Exit.void);
          expect(yield* Fiber.join(reading)).toMatchObject(unanswered);
        }),
      ),
    ));

  test("a repeatable call whose handler withdrew it while its plugin stayed fails Withdrawn rather than asking it again", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let asked = 0;
          const selfish = definePlugin({
            id: "selfish",
            layer: Layer.effectDiscard(
              Effect.flatMap(PluginContext, (owner) =>
                owner.add(
                  Channels,
                  serveChannel({ ...read, id: "selfish.read" }, () =>
                    Effect.andThen(
                      Effect.sync(() => asked++),
                      Effect.fail(withdrawnFrom("selfish.read", "call")),
                    ),
                  ),
                ),
              ).pipe(Effect.orDie),
            ),
          });
          const core = yield* makeCore([selfish]);
          const registries = yield* core.run(Registries);
          expect(yield* Effect.flip(callServed(registries, "selfish.read", "hi"))).toMatchObject({ code: "Withdrawn", subject: "selfish.read" });
          expect(asked).toBe(1);
        }),
      ),
    ));

  test("when what it found leaves before it runs, a repeat waits again and looks again", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Instance 2 serves the call, instance 3 replaces it once opened; instance 1's channels are what a stale look sees.
          const served = patient({ answering: 3, gate: 3 });
          const core = yield* makeCore([served.plugin]);
          const registries = yield* core.run(Registries);
          const stale = yield* registries.items(Channels);
          yield* core.restart("patient", { force: true });
          // A reader that sees the change settle at once the first time it asks, and on its first look then finds a
          // channel that has left: as if another change began between the two.
          let looks = 0;
          let settles = 0;
          const reader: typeof registries = {
            items: (registry) => (++looks === 2 ? Effect.succeed(stale as never) : registries.items(registry)),
            changes: registries.changes,
            run: registries.run,
            settled: Effect.suspend(() => (++settles === 1 ? Effect.void : registries.settled)),
          };
          const reading = yield* Effect.forkChild(callServed(reader, "patient.read", "hi"));
          yield* Deferred.await(served.started.read);
          const restarting = yield* Effect.forkChild(core.restart("patient", { force: true }));
          yield* served.finalized(2);
          yield* settle;
          expect([looks, settles, reading.pollUnsafe()]).toEqual([3, 2, undefined]);
          yield* served.open;
          expect(yield* Fiber.join(reading)).toBe("3:hi");
          yield* Fiber.join(restarting);
        }),
      ),
    ));

  test("a repeat's wait ends when the call is interrupted, and the replacement never hears it", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient();
          const core = yield* makeCore([served.plugin]);
          const registries = yield* core.run(Registries);
          const reading = yield* Effect.forkChild(callServed(registries, "patient.read", "hi"));
          yield* Deferred.await(served.started.read);
          const restarting = yield* Effect.forkChild(core.restart("patient", { force: true }));
          yield* served.finalized(1);
          yield* settle;
          // Its wait would end only once the replacement starts, which comes after this.
          yield* Fiber.interrupt(reading);
          expect(Exit.hasInterrupts(yield* Fiber.await(reading))).toBe(true);
          yield* served.open;
          yield* Fiber.join(restarting);
          yield* settle;
          expect(served.answered()).toBe(0);
        }),
      ),
    ));

  test("a call or a stream's opening that finds nothing while an exclusive replacement is pending reaches the replacement", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = patient();
          const core = yield* makeCore([served.plugin]);
          const registries = yield* core.run(Registries);
          const restarting = yield* Effect.forkChild(core.restart("patient", { force: true }));
          yield* served.finalized(1);
          // Nothing answers now, and a change is under way: both wait for it.
          expect(yield* registries.items(Channels)).toEqual([]);
          const writing = yield* Effect.forkChild(callServed(registries, "patient.write", "hi"));
          const opening = yield* Effect.forkChild(withChannel(registries, "patient.feed", "stream", ({ item }) => Stream.runHead(elementsOf(item, undefined))));
          yield* settle;
          expect([writing.pollUnsafe(), opening.pollUnsafe()]).toEqual([undefined, undefined]);
          yield* served.open;
          expect(yield* Fiber.join(writing)).toBe("2:hi");
          expect(yield* Fiber.join(opening)).toEqual(Option.some(2));
          yield* Fiber.join(restarting);
          // With no change under way, finding nothing is NotFound at once.
          expect(yield* Effect.flip(callServed(registries, "patient.none", "hi"))).toMatchObject({ code: "NotFound", subject: "patient.none" });
        }),
      ),
    ));
});
