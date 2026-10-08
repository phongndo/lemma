import { describe, expect, test } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { SessionError, SessionRemoveHook, Sessions, SessionChannels } from "@lemma/contracts";
import type { ChannelInfo, SessionEvent, SessionInfo } from "@lemma/contracts";
import { definePlugin, PluginContext } from "@lemma/core";
import { pathsPlugin } from "@lemma/contracts/testing";
import sessions from "../src/index.ts";
import { call, collect, hostError, open, served } from "./served.ts";

const withSessions = <A, E>(body: Parameters<typeof served<A, E>>[1]) => served((home) => [pathsPlugin(home, { cwd: "/work" }), sessions], body);

/** Refuses to remove `kept`, as a `SessionRemoveHook` handler may. */
const keeper = (kept: { id?: string }) =>
  definePlugin({
    id: "keeper",
    layer: Layer.effectDiscard(
      Effect.flatMap(PluginContext, (owner) =>
        owner.on(SessionRemoveHook, (input, next) =>
          input.sessionId === kept.id ? Effect.fail(new SessionError({ sessionId: input.sessionId, reason: "Busy", message: "kept" })) : next(input),
        ),
      ).pipe(Effect.orDie),
    ),
  });

describe("the sessions channels, through the transport", () => {
  test("are listed with their titles, served by the sessions plugin", () =>
    withSessions((client) =>
      Effect.gen(function* () {
        const listed = (yield* client["Channel.List"]()).filter((channel: ChannelInfo) => channel.id.startsWith("sessions."));
        expect(listed.map(({ id, kind, source }) => [id, kind, source])).toEqual(
          Object.values(SessionChannels).map((channel) => [channel.id, channel.kind, "sessions"]),
        );
        expect(listed.every((channel) => channel.title !== undefined && channel.description !== undefined)).toBe(true);
      }),
    ));

  test("create, read, check out, title, file, and delete a session", () =>
    withSessions((client) =>
      Effect.gen(function* () {
        const made = (yield* call(client, "sessions.create", { cwd: "/work/app" })) as SessionInfo;
        expect(made).toMatchObject({ cwd: "/work/app", lastSeq: 0 });
        // No `cwd`, or no payload at all: the host's.
        expect(yield* call(client, "sessions.create", {})).toMatchObject({ cwd: "/work" });
        expect(yield* call(client, "sessions.create")).toMatchObject({ cwd: "/work" });

        const titled = (yield* call(client, "sessions.set-title", { sessionId: made.id, title: "First" })) as SessionInfo;
        expect(titled).toMatchObject({ id: made.id, title: "First", lastSeq: 1 });
        yield* call(client, "sessions.set-title", { sessionId: made.id, title: "Second" });
        const log = (yield* call(client, "sessions.events", { sessionId: made.id })) as SessionEvent[];
        expect(log.map((event) => event.data)).toEqual([
          { type: "title", title: "First" },
          { type: "title", title: "Second" },
        ]);
        expect(yield* call(client, "sessions.events", { sessionId: made.id, after: 1 })).toEqual([log[1]]);

        expect(yield* call(client, "sessions.checkout", { sessionId: made.id, eventId: log[0]!.id })).toMatchObject({ leaf: log[0]!.id });
        expect(yield* call(client, "sessions.get", { sessionId: made.id })).toMatchObject({ leaf: log[0]!.id, title: "Second" });
        expect(yield* call(client, "sessions.mark", { sessionId: made.id, pinned: true })).toMatchObject({ pinned: true });
        expect(yield* call(client, "sessions.mark", { sessionId: made.id, archived: true })).toMatchObject({ pinned: true, archived: true });

        expect(((yield* call(client, "sessions.list", {})) as SessionInfo[]).map((info) => info.cwd).sort()).toEqual(["/work", "/work", "/work/app"]);
        // Called as `lemma channels` lists it, with no payload: every session.
        expect(((yield* call(client, "sessions.list")) as SessionInfo[]).length).toBe(3);
        expect(((yield* call(client, "sessions.list", { cwd: "/work/app" })) as SessionInfo[]).map((info) => info.id)).toEqual([made.id]);

        expect(yield* call(client, "sessions.delete", { sessionId: made.id })).toBeNull();
        expect(((yield* call(client, "sessions.list", { cwd: "/work/app" })) as SessionInfo[]).length).toBe(0);
      }),
    ));

  test("a session error keeps its reason as the code and names the session; a malformed payload names the channel", () =>
    withSessions((client) =>
      Effect.gen(function* () {
        expect(hostError(yield* Effect.exit(call(client, "sessions.get", { sessionId: "nope" })))).toMatchObject({ code: "NotFound", subject: "nope" });
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        expect(hostError(yield* Effect.exit(call(client, "sessions.checkout", { sessionId: id, eventId: "e0" })))).toMatchObject({
          code: "NotFound",
          subject: id,
        });
        expect(hostError(yield* Effect.exit(call(client, "sessions.get", {})))).toMatchObject({ code: "InvalidPayload", subject: "sessions.get" });
      }),
    ));

  test("a removal a SessionRemoveHook handler refuses fails with its code, for a client and for a plugin alike, and keeps the session", () => {
    const kept: { id?: string } = {};
    return served(
      (home) => [pathsPlugin(home), sessions, keeper(kept)],
      (client, core) =>
        Effect.gen(function* () {
          const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
          kept.id = id;
          expect(hostError(yield* Effect.exit(call(client, "sessions.delete", { sessionId: id })))).toMatchObject({ code: "Busy", subject: id });
          const removed = yield* Effect.exit(core.run(Effect.flatMap(Sessions, (store) => store.remove(id))));
          expect(Exit.isFailure(removed) && Exit.findErrorOption(removed)).toMatchObject({ _tag: "Some", value: { reason: "Busy", sessionId: id } });
          expect(yield* call(client, "sessions.get", { sessionId: id })).toMatchObject({ id });

          const { id: other } = (yield* call(client, "sessions.create", {})) as SessionInfo;
          yield* call(client, "sessions.delete", { sessionId: other });
          expect(hostError(yield* Effect.exit(call(client, "sessions.get", { sessionId: other })))).toMatchObject({ code: "NotFound" });
        }),
    );
  });

  test("changes start with subscribed, then report every session created, changed, and removed, an append as its new lastSeq", () =>
    withSessions((client) =>
      Effect.gen(function* () {
        const changes = yield* open(client, "sessions.changes");
        // Nothing has happened yet: what comes first is the acknowledgement, and anything after it is news.
        expect(yield* changes.next).toEqual({ type: "subscribed" });
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        yield* call(client, "sessions.set-title", { sessionId: id, title: "Named" });
        yield* call(client, "sessions.delete", { sessionId: id });
        // Each kind keeps its own order; kinds may interleave either way.
        const count = (seen: readonly any[], type: string) => seen.filter((change) => change.type === type).length;
        const seen = yield* collect(changes, (seen) => count(seen, "session-changed") === 2 && count(seen, "session-removed") === 1);
        expect(seen.length).toBe(3);
        expect(seen.filter((change) => change.type === "session-changed").map((change) => [change.info.title, change.info.lastSeq])).toEqual([
          [undefined, 0],
          ["Named", 1],
        ]);
        expect(seen.filter((change) => change.type === "session-removed")).toEqual([{ type: "session-removed", sessionId: id }]);
      }),
    ));

  test("log follows one session: subscribed with its log after `after`, then each event appended to it, and no other's, until it is deleted", () =>
    withSessions((client) =>
      Effect.gen(function* () {
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        const { id: other } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        yield* call(client, "sessions.set-title", { sessionId: id, title: "First" });
        yield* call(client, "sessions.set-title", { sessionId: id, title: "Second" });
        const log = (yield* call(client, "sessions.events", { sessionId: id })) as SessionEvent[];

        const whole = yield* open(client, "sessions.log", { sessionId: id });
        expect(yield* whole.next).toEqual({ type: "subscribed", events: log });
        // As a client reopening it after a reconnect does, from the last event it has.
        const rest = yield* open(client, "sessions.log", { sessionId: id, after: 1 });
        expect(yield* rest.next).toEqual({ type: "subscribed", events: [log[1]] });

        yield* call(client, "sessions.set-title", { sessionId: other, title: "Elsewhere" });
        yield* call(client, "sessions.set-title", { sessionId: id, title: "Third" });
        const third = yield* whole.next;
        expect(third).toEqual({ type: "appended", event: expect.objectContaining({ seq: 3, parent: log[1]!.id, data: { type: "title", title: "Third" } }) });
        expect(yield* rest.next).toEqual(third);

        yield* call(client, "sessions.delete", { sessionId: id });
        expect(hostError(yield* whole.end)).toMatchObject({ code: "NotFound", subject: id });
        expect(hostError(yield* rest.end)).toMatchObject({ code: "NotFound", subject: id });
        expect(hostError(yield* (yield* open(client, "sessions.log", { sessionId: id })).end)).toMatchObject({ code: "NotFound", subject: id });
      }),
    ));
});
