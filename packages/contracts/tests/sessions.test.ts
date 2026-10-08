import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import type { Context } from "effect";
import { Events, makeCore } from "@lemma/core";
import { elementsOf, resultOf } from "../src/channels.ts";
import type { Channel, ChannelCall, ChannelStream } from "../src/channels.ts";
import { NewThreadRoute, serveSessions, SessionRemoved, SessionsChannels, ThreadRoute } from "../src/sessions.ts";
import type { SessionInfo, Sessions } from "../src/sessions.ts";

describe("thread routes", () => {
  test("threads have readable paths", () => {
    expect(NewThreadRoute.href({})).toBe("/");
    expect(ThreadRoute.href({ id: "s1" })).toBe("/threads/s1");
    expect(ThreadRoute.href({ id: "s1", view: "trajectory" })).toBe("/threads/s1/trajectory");
  });
});

describe("serveSessions", () => {
  const info: SessionInfo = { id: "s1", cwd: "/work", createdAt: 0, updatedAt: 0, lastSeq: 0 };
  /** A store that records what each channel asked of it. */
  const recording = () => {
    const asked: unknown[][] = [];
    const answer =
      <A>(name: string, value: A) =>
      (...args: unknown[]) =>
        Effect.sync(() => {
          asked.push([name, ...args]);
          return value;
        });
    const store: Context.Service.Shape<typeof Sessions> = {
      create: answer("create", info),
      list: answer("list", [info]),
      get: answer("get", { ...info, title: "Named" }),
      append: answer("append", { seq: 1, id: "e1", parent: null, at: 0, data: { type: "title", title: "Named" } }),
      events: answer("events", []),
      branch: answer("branch", []),
      checkout: answer("checkout", info),
      mark: answer("mark", info),
      remove: answer("remove", undefined),
    };
    return { asked, store };
  };
  const withServed = <A>(
    body: (channels: ReadonlyMap<string, Channel>, asked: unknown[][], events: Context.Service.Shape<typeof Events>) => Effect.Effect<A, unknown>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* makeCore([])).run(Events);
          const { asked, store } = recording();
          return yield* body(new Map(serveSessions(store, events).map((channel) => [channel.id, channel])), asked, events);
        }),
      ),
    );
  const called = (channels: ReadonlyMap<string, Channel>, id: string, payload: unknown) => resultOf(channels.get(id) as ChannelCall, payload);

  test("serves each declaration as declared", () =>
    withServed((channels) =>
      Effect.sync(() => {
        expect([...channels.values()].map(({ handle: _, ...declared }) => declared)).toEqual(Object.values(SessionsChannels));
      }),
    ));

  test("asks the store what each call names, leaving out what the client left out", () =>
    withServed((channels, asked) =>
      Effect.gen(function* () {
        yield* called(channels, "sessions.create", {});
        yield* called(channels, "sessions.create", { cwd: "/work/app" });
        yield* called(channels, "sessions.list", {});
        yield* called(channels, "sessions.events", { sessionId: "s1" });
        yield* called(channels, "sessions.events", { sessionId: "s1", after: 2 });
        yield* called(channels, "sessions.mark", { sessionId: "s1", pinned: true });
        yield* called(channels, "sessions.checkout", { sessionId: "s1", eventId: "e1" });
        yield* called(channels, "sessions.delete", { sessionId: "s1" });
        expect(asked).toEqual([
          ["create", undefined],
          ["create", { cwd: "/work/app" }],
          ["list", undefined],
          ["events", "s1", undefined],
          ["events", "s1", { after: 2 }],
          ["mark", "s1", { pinned: true }],
          ["checkout", "s1", "e1"],
          ["remove", "s1"],
        ]);
      }),
    ));

  test("set-title appends a title event and answers with the session as it is then", () =>
    withServed((channels, asked) =>
      Effect.gen(function* () {
        expect(yield* called(channels, "sessions.set-title", { sessionId: "s1", title: "Named" })).toMatchObject({ title: "Named" });
        expect(asked).toEqual([
          ["append", "s1", { type: "title", title: "Named" }],
          ["get", "s1"],
        ]);
      }),
    ));

  test("changes start with subscribed, then report what the store publishes", () =>
    withServed((channels, _, events) =>
      Effect.gen(function* () {
        const changes = elementsOf(channels.get("sessions.changes") as ChannelStream, undefined).pipe(
          Stream.tap((change: any) => (change.type === "subscribed" ? events.publish(SessionRemoved, { sessionId: "s1" }) : Effect.void)),
          Stream.take(2),
        );
        expect(yield* Stream.runCollect(changes)).toEqual([{ type: "subscribed" }, { type: "session-removed", sessionId: "s1" }]);
      }),
    ));
});
