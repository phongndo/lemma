import { describe, expect, test } from "vitest";
import { Effect, Exit, Stream } from "effect";
import type { Context } from "effect";
import { Events, makeCore } from "@lemma/core";
import { elementsOf, resultOf } from "../src/channels.ts";
import type { Channel, ChannelCall, ChannelStream } from "../src/channels.ts";
import { NewThreadRoute, serveSessions, SessionAppended, SessionError, SessionRemoved, SessionChannels, ThreadRoute } from "../src/sessions.ts";
import type { SessionEvent, SessionInfo, SessionLogUpdate, Sessions } from "../src/sessions.ts";

describe("thread routes", () => {
  test("threads have readable paths", () => {
    expect(NewThreadRoute.href({})).toBe("/");
    expect(ThreadRoute.href({ id: "s1" })).toBe("/threads/s1");
    expect(ThreadRoute.href({ id: "s1", view: "trajectory" })).toBe("/threads/s1/trajectory");
  });
});

const info: SessionInfo = { id: "s1", cwd: "/work", createdAt: 0, updatedAt: 0, lastSeq: 0 };

/** The event numbered `seq` in a log of title events. */
const titled = (seq: number): SessionEvent => ({
  seq,
  id: `e${seq}`,
  parent: seq === 1 ? null : `e${seq - 1}`,
  at: seq,
  data: { type: "title", title: `Title ${seq}` },
});

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
    hold: answer("hold", undefined),
    remove: answer("remove", undefined),
  };
  return { asked, store };
};

describe("serveSessions", () => {
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
        expect([...channels.values()].map(({ handle: _, ...declared }) => declared)).toEqual(Object.values(SessionChannels));
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

  test("changes start with subscribed, then report what the store publishes of sessions, not their appends", () =>
    withServed((channels, _, events) =>
      Effect.gen(function* () {
        const changes = elementsOf(channels.get("sessions.changes") as ChannelStream, undefined).pipe(
          Stream.tap((change: any) =>
            change.type === "subscribed"
              ? Effect.andThen(events.publish(SessionAppended, { sessionId: "s1", event: titled(1) }), events.publish(SessionRemoved, { sessionId: "s1" }))
              : Effect.void,
          ),
          Stream.take(2),
        );
        expect(yield* Stream.runCollect(changes)).toEqual([{ type: "subscribed" }, { type: "session-removed", sessionId: "s1" }]);
      }),
    ));
});

describe("sessions.log", () => {
  /**
   * Follows `s1`, whose log holds `log`, reading it as it stands; `react` runs
   * on each update the stream sends, before the next is taken. The store
   * publishes nothing itself: a test publishes what it wants heard.
   */
  const follow = <E>(
    log: SessionEvent[],
    payload: unknown,
    react: (update: SessionLogUpdate, events: Context.Service.Shape<typeof Events>) => Effect.Effect<void, E>,
    count: number,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* makeCore([])).run(Events);
          const store: Context.Service.Shape<typeof Sessions> = {
            ...recording().store,
            events: (sessionId, options) =>
              sessionId === "s1"
                ? Effect.sync(() => log.filter((event) => event.seq > (options?.after ?? 0)))
                : Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: `Session ${sessionId} does not exist` })),
          };
          const channel = serveSessions(store, events).find((served) => served.id === "sessions.log") as ChannelStream;
          return yield* (elementsOf(channel, payload) as Stream.Stream<SessionLogUpdate, unknown>).pipe(
            Stream.tap((update) => react(update, events)),
            Stream.take(count),
            Stream.runCollect,
            Effect.exit,
          );
        }),
      ),
    );
  const appended = (event: SessionEvent): SessionLogUpdate => ({ type: "appended", event });

  test("starts with subscribed and the log after `after`, then sends each event appended to its session, once", async () => {
    const log = [titled(1), titled(2), titled(3)];
    const exit = await follow(
      log,
      { sessionId: "s1", after: 1 },
      (update, events) =>
        update.type === "subscribed"
          ? Effect.gen(function* () {
              // Heard while the log was read: sent already.
              yield* events.publish(SessionAppended, { sessionId: "s1", event: titled(3) });
              yield* events.publish(SessionAppended, { sessionId: "s2", event: titled(1) });
              log.push(titled(4), titled(5));
              yield* events.publish(SessionAppended, { sessionId: "s1", event: titled(4) });
              yield* events.publish(SessionAppended, { sessionId: "s1", event: titled(5) });
            })
          : Effect.void,
      3,
    );
    expect(exit).toEqual(Exit.succeed([{ type: "subscribed", events: [titled(2), titled(3)] }, appended(titled(4)), appended(titled(5))]));
  });

  test("reads the appends it did not hear from the log, so its client sees no gap", async () => {
    const log = [titled(1)];
    const exit = await follow(
      log,
      { sessionId: "s1" },
      (update, events) =>
        Effect.gen(function* () {
          if (update.type === "subscribed") {
            log.push(titled(2), titled(3), titled(4));
            // The last is heard first, as when a slow client's buffer lets the others go; one heard late was sent already.
            yield* events.publish(SessionAppended, { sessionId: "s1", event: titled(4) });
            yield* events.publish(SessionAppended, { sessionId: "s1", event: titled(3) });
          } else if (update.event.seq === 4) {
            log.push(titled(5));
            yield* events.publish(SessionAppended, { sessionId: "s1", event: titled(5) });
          }
        }),
      5,
    );
    expect(exit).toEqual(
      Exit.succeed([{ type: "subscribed", events: [titled(1)] }, appended(titled(2)), appended(titled(3)), appended(titled(4)), appended(titled(5))]),
    );
  });

  test("fails NotFound, naming the session, once the session is deleted, or when it does not exist", async () => {
    const deleted = await follow(
      [titled(1)],
      { sessionId: "s1" },
      (update, events) =>
        update.type === "subscribed"
          ? Effect.andThen(events.publish(SessionRemoved, { sessionId: "s2" }), events.publish(SessionRemoved, { sessionId: "s1" }))
          : Effect.void,
      2,
    );
    expect(Exit.isFailure(deleted) && Exit.findErrorOption(deleted)).toMatchObject({ _tag: "Some", value: { reason: "NotFound", sessionId: "s1" } });
    const missing = await follow([], { sessionId: "nope" }, () => Effect.void, 1);
    expect(Exit.isFailure(missing) && Exit.findErrorOption(missing)).toMatchObject({ _tag: "Some", value: { reason: "NotFound", sessionId: "nope" } });
  });
});
