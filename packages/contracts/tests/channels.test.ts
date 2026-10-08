import { describe, expect, test } from "vitest";
import { Deferred, Effect, Schema, Stream } from "effect";
import type { Context } from "effect";
import { Event, Events, makeCore } from "@lemma/core";
import { channelProblem, eventFeed, optionalPayload, serveChannel, wireCodec } from "../src/channels.ts";

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
