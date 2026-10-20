import { describe, expect, test } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { SessionError, SessionRemoveHook, Sessions, SessionChannels } from "@lemma/sessions";
import type { ChannelInfo } from "@lemma/contracts";
import type { EventData, RequestView, SessionEvent, SessionInfo, SessionRecords } from "@lemma/sessions";
import { definePlugin, PluginContext } from "@lemma/core";
import { pathsPlugin } from "@lemma/contracts/testing";
import sessions from "../src/index.ts";
import { call, collect, hostError, open, served } from "./served.ts";

/** The assistant message a `message` event carries. */
type AssistantMessage = Extract<Extract<EventData, { readonly type: "message" }>["message"], { readonly role: "assistant" }>;

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
          Object.values(SessionChannels).map((channel) => [channel.id, channel.kind, "sessions.files"]),
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

  test("records, request, and cache read a session's branch as its Trajectory view does", () =>
    withSessions((client, core) =>
      Effect.gen(function* () {
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        const usage = {
          input: 10,
          output: 5,
          cacheRead: 4,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
          role: "assistant",
          content,
          api: "x",
          provider: "p",
          model: "m",
          usage,
          stopReason,
          timestamp: 0,
        });
        const asked = (stepId: string, prompt: string): EventData => ({
          type: "request",
          turnId: "t1",
          stepId,
          model: "p/m",
          composition: "c1",
          system: prompt,
          contributions: [{ source: "agent", kind: "system", label: "base", chars: prompt.length }],
        });
        const events: EventData[] = [
          { type: "turn-start", turnId: "t1" },
          { type: "message", turnId: "t1", message: { role: "user", content: [{ type: "text", text: "fix the test" }], timestamp: 0 } },
          { type: "step-start", turnId: "t1", stepId: "t1.1" },
          asked("t1.1", "You are an agent."),
          {
            type: "message",
            turnId: "t1",
            stepId: "t1.1",
            message: reply([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }], "toolUse"),
          },
          {
            type: "message",
            turnId: "t1",
            stepId: "t1.1",
            message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "exit 1" }], isError: true, timestamp: 0 },
          },
          { type: "step-end", turnId: "t1", stepId: "t1.1" },
          { type: "step-start", turnId: "t1", stepId: "t1.2" },
          asked("t1.2", "You are a careful agent."),
          { type: "message", turnId: "t1", stepId: "t1.2", message: reply([{ type: "text", text: "Fixed." }], "stop") },
          { type: "step-end", turnId: "t1", stepId: "t1.2" },
          { type: "turn-end", turnId: "t1", reason: "done" },
        ];
        yield* core.run(Effect.flatMap(Sessions, (store) => Effect.forEach(events, (data) => store.append(id, data))));

        const all = (yield* call(client, "sessions.records", { sessionId: id })) as SessionRecords;
        expect(all.running).toBe(false);
        expect(all.records.map((record) => [record.kind, record.status])).toEqual([
          ["user", "sent"],
          ["system", "initial"],
          ["assistant", "tool use"],
          ["tool", "error"],
          ["system", "changed"],
          ["assistant", "stop"],
        ]);
        const failed = (yield* call(client, "sessions.records", { sessionId: id, filter: "is:error tool:bash" })) as SessionRecords;
        expect(failed.records).toEqual([
          expect.objectContaining({ kind: "tool", tool: "bash", arguments: { command: "false" }, result: "exit 1", error: true }),
        ]);

        const last = (yield* call(client, "sessions.request", { sessionId: id })) as RequestView;
        expect(last).toMatchObject({ number: 2, turn: 1, step: 2, composition: "c1", previous: expect.any(String) });
        expect(last.sections).toEqual([{ id: "base", source: "agent", chars: 24, changed: true, text: "You are a careful agent." }]);
        expect(last.plugins).toEqual([expect.objectContaining({ source: "agent", systemChars: 24, changed: ["base"] })]);
        expect(last.rebuilt).toBeUndefined();
        const first = (yield* call(client, "sessions.request", { sessionId: id, request: 1, rebuilt: true })) as RequestView;
        expect(first).toMatchObject({ number: 1, step: 1, rebuilt: { model: "p/m", system: "You are an agent." } });
        expect(first.previous).toBeUndefined();
        expect(hostError(yield* Effect.exit(call(client, "sessions.request", { sessionId: id, request: 3 })))).toMatchObject({ code: "NotFound", subject: id });
        // A number is a request's number: one with a fraction would read as <turn>.<step>, and 2.10 as "2.1".
        expect(hostError(yield* Effect.exit(call(client, "sessions.request", { sessionId: id, request: 1.5 })))).toMatchObject({ code: "InvalidPayload" });
        expect(yield* call(client, "sessions.request", { sessionId: id, request: "1.2" })).toMatchObject({ number: 2, turn: 1, step: 2 });

        expect(yield* call(client, "sessions.cache", { sessionId: id })).toEqual({ requests: 2, changed: 1, changedBy: { agent: 1 }, input: 28, cacheRead: 8 });
      }),
    ));
});
