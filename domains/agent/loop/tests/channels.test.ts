import { describe, expect, test } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { Paths } from "@lemma/contracts";
import { Agent, AgentChannels } from "@lemma/agent";
import { SessionError, SessionRemoveHook, Sessions } from "@lemma/sessions";
import type { ChannelInfo } from "@lemma/contracts";
import type { AgentView, QueuedPrompt } from "@lemma/agent";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import { call, collect, hostError, open, served } from "../../../sessions/files/tests/served.ts";
import tools from "@lemma/tools-registry";
import agent from "../src/index.ts";
import { fakeLlm, gated, hang, host, ofType, paths, reply, testTools, text, waitFor } from "./fakes.ts";
import type { Script } from "./fakes.ts";

/** The agent with the sessions store, behind the transport, its model playing `scripts`. */
const withAgent = <A, E>(scripts: readonly Script[], body: Parameters<typeof served<A, E>>[1]) =>
  served((home) => [paths(home, home), host(), sessions, tools, testTools().plugin, fakeLlm(scripts).plugin, agent], body);

const count = (seen: readonly any[], type: string) => seen.filter((element) => element.type === type).length;

describe("the agent channels, through the transport", () => {
  test("are listed with their titles, served by the agent", () =>
    withAgent([], (client) =>
      Effect.gen(function* () {
        const listed = (yield* client["Channel.List"]()).filter((channel: ChannelInfo) => channel.id.startsWith("agent."));
        expect(listed.map(({ id, kind, source }) => [id, kind, source])).toEqual(
          Object.values(AgentChannels).map((channel) => [channel.id, channel.kind, "agent.loop"]),
        );
        expect(listed.every((channel) => channel.title !== undefined && channel.description !== undefined)).toBe(true);
      }),
    ));

  test("a prompt answers when its turn ends, which activity reports after subscribed and the log shows with its id; sent again with it, it is not placed twice", () =>
    withAgent([reply("hello there")], (client) =>
      Effect.gen(function* () {
        const activity = yield* open(client, "agent.activity");
        expect(yield* activity.next).toEqual({ type: "subscribed", running: [] });
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        const followed = yield* open(client, "sessions.log", { sessionId: id });
        expect(yield* followed.next).toEqual({ type: "subscribed", events: [] });
        expect(yield* call(client, "agent.prompt", { sessionId: id, content: text("hi"), requestId: "r1" })).toEqual({ kind: "placed" });
        // The session's log, as it is appended: its message carries the request id, which tells a client the prompt was taken.
        const appended = (yield* collect(followed, (seen) => seen.at(-1)?.event.data.type === "turn-end")).map((element) => element.event);
        expect(appended.map((event) => event.seq)).toEqual(appended.map((_, index) => index + 1));
        expect(appended.find((event) => event.data.type === "message" && event.data.message.role === "user")?.data).toMatchObject({ requestId: "r1" });

        // Each kind keeps its own order; `turn-ended` can overtake the last delta.
        const seen = yield* collect(activity, (seen) => count(seen, "turn-ended") === 1 && count(seen, "delta") === 4);
        const turnId = seen.find((element) => element.type === "turn-started")?.turnId;
        expect(seen.filter((element) => element.type === "turn-started")).toEqual([{ type: "turn-started", sessionId: id, turnId, requestIds: ["r1"] }]);
        expect(seen.filter((element) => element.type === "delta").map((element) => [element.turnId, element.seq, element.event.type])).toEqual([
          [turnId, 1, "start"],
          [turnId, 2, "text-delta"],
          [turnId, 3, "text-delta"],
          [turnId, 4, "done"],
        ]);
        expect(seen.find((element) => element.type === "turn-ended")).toMatchObject({ sessionId: id, turnId, reason: "done", usage: { input: 10 } });

        expect(yield* call(client, "agent.running")).toEqual([]);
        expect((yield* call(client, "agent.view", { sessionId: id })) as AgentView).toMatchObject({ output: [], queue: [] });
        // Exactly once: the turn that placed it has ended, so the call answers at once and places nothing.
        expect(yield* call(client, "agent.prompt", { sessionId: id, content: text("hi"), requestId: "r1" })).toEqual({ kind: "placed" });
        const log = (yield* call(client, "sessions.events", { sessionId: id })) as SessionEvent[];
        expect(log.filter((event) => event.data.type === "message" && event.data.message.role === "user").length).toBe(1);
      }),
    ));

  test("while a turn runs: a rejecting prompt fails Busy, a follow-up queues and is withdrawn, the session cannot be deleted, and cancel ends it", () =>
    withAgent([hang("thinking")], (client, core) =>
      Effect.gen(function* () {
        const activity = yield* open(client, "agent.activity");
        yield* activity.next;
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        const first = yield* Effect.forkChild(call(client, "agent.prompt", { sessionId: id, content: text("go"), requestId: "r1" }));
        const [started] = yield* collect(activity, (seen) => count(seen, "turn-started") === 1).pipe(
          Effect.map((seen) => seen.filter((element) => element.type === "turn-started")),
        );

        // A client subscribing now learns the turn runs from the acknowledgement.
        const late = yield* open(client, "agent.activity");
        expect(yield* late.next).toEqual({ type: "subscribed", running: [id] });
        expect(yield* call(client, "agent.running")).toEqual([id]);
        expect(yield* call(client, "agent.view", { sessionId: id })).toMatchObject({ turnId: started.turnId, queue: [] });

        expect(
          hostError(yield* Effect.exit(call(client, "agent.prompt", { sessionId: id, content: text("no"), requestId: "r0", whenBusy: "reject" }))),
        ).toMatchObject({
          code: "Busy",
          subject: id,
        });

        const queued = yield* Effect.forkChild(call(client, "agent.prompt", { sessionId: id, content: text("next"), requestId: "r2" }));
        yield* collect(activity, (seen) =>
          seen.some((element) => element.type === "queue-changed" && element.queue.some((prompt: QueuedPrompt) => prompt.requestId === "r2")),
        );
        expect(yield* call(client, "agent.queue", { sessionId: id })).toEqual([expect.objectContaining({ requestId: "r2", mode: "follow-up" })]);
        expect(yield* call(client, "agent.withdraw", { sessionId: id, requestId: "r2" })).toBe(true);
        expect(yield* call(client, "agent.withdraw", { sessionId: id, requestId: "r2" })).toBe(false);
        // Taken out of the queue, the prompt fails `Retracted`, naming the session: not the channel's `Withdrawn`, which would say the agent left.
        expect(hostError(yield* Fiber.await(queued))).toMatchObject({ code: "Retracted", subject: id });

        // Refused by the sessions store, as the turn holds the session, for a client and for a plugin alike.
        expect(hostError(yield* Effect.exit(call(client, "sessions.delete", { sessionId: id })))).toMatchObject({ code: "Busy", subject: id });
        const removed = yield* Effect.exit(core.run(Effect.flatMap(Sessions, (store) => store.remove(id))));
        expect(Exit.isFailure(removed) && Exit.findErrorOption(removed)).toMatchObject({ _tag: "Some", value: { reason: "Busy", sessionId: id } });

        expect(yield* call(client, "agent.cancel", { sessionId: id })).toBeNull();
        expect(yield* Fiber.join(first)).toEqual({ kind: "placed" });
        expect(yield* collect(activity, (seen) => count(seen, "turn-ended") === 1).pipe(Effect.map((seen) => seen.at(-1)))).toMatchObject({
          type: "turn-ended",
          sessionId: id,
          reason: "cancelled",
        });
        // With no turn running, it goes.
        expect(yield* call(client, "sessions.delete", { sessionId: id })).toBeNull();
      }),
    ));

  test("a client showing one session of three hears every session's turns and queue on activity without output, and only its session's output on agent.output", () =>
    withAgent([reply("from b"), reply("from c"), reply("from a")], (client) =>
      Effect.gen(function* () {
        const [a, b, c] = (yield* Effect.all([0, 1, 2].map(() => call(client, "sessions.create", {})))) as SessionInfo[];
        const turns = yield* open(client, "agent.activity", { output: false });
        expect(yield* turns.next).toEqual({ type: "subscribed", running: [] });
        const shown = yield* open(client, "agent.output", { sessionId: a!.id });
        expect(yield* shown.next).toEqual({ type: "subscribed", view: { output: [], queue: [], queueRevision: expect.any(Number) } });
        // As every client before `output` was: everything.
        const everything = yield* open(client, "agent.activity");
        yield* everything.next;

        // Read as they come: a client that stops taking a stream's elements stalls its connection.
        const reading = yield* Effect.forkChild(
          Effect.all([
            collect(everything, (seen) => count(seen, "turn-ended") === 3 && count(seen, "delta") === 12),
            collect(turns, (seen) => count(seen, "turn-ended") === 3),
            collect(shown, (seen) => count(seen, "delta") === 4),
          ]),
        );
        // B's turn, then C's, then A's.
        for (const [session, requestId] of [
          [b!, "rb"],
          [c!, "rc"],
          [a!, "ra"],
        ] as const)
          yield* call(client, "agent.prompt", { sessionId: session.id, content: text("go"), requestId });
        const [all, heard, output] = yield* Fiber.join(reading);

        expect(new Set(all.filter((element) => element.type === "delta").map((element) => element.sessionId))).toEqual(new Set([a!.id, b!.id, c!.id]));
        expect(heard.filter((element) => element.type === "turn-started").map((element) => element.sessionId)).toEqual([b!.id, c!.id, a!.id]);
        expect(heard.filter((element) => element.type === "turn-ended").map((element) => element.sessionId)).toEqual([b!.id, c!.id, a!.id]);
        expect(heard.filter((element) => element.type === "delta" || element.type === "tool-output")).toEqual([]);
        // A's own, none of B's or C's, which streamed first.
        expect(output.map((element) => [element.sessionId, element.seq, element.event.type])).toEqual([
          [a!.id, 1, "start"],
          [a!.id, 2, "text-delta"],
          [a!.id, 3, "text-delta"],
          [a!.id, 4, "done"],
        ]);
      }),
    ));

  test("agent.output opened again midway, as after a reconnect, opens with the turn so far, and goes on from it", () =>
    withAgent([hang("thinking")], (client) =>
      Effect.gen(function* () {
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        const first = yield* open(client, "agent.output", { sessionId: id });
        yield* first.next;
        const prompt = yield* Effect.forkChild(call(client, "agent.prompt", { sessionId: id, content: text("go"), requestId: "r1" }));
        expect((yield* collect(first, (seen) => count(seen, "delta") === 2)).map((element) => element.seq)).toEqual([1, 2]);

        const again = yield* open(client, "agent.output", { sessionId: id });
        const resynced = (yield* again.next) as { readonly type: string; readonly view: AgentView };
        expect(resynced).toMatchObject({
          type: "subscribed",
          view: { turnId: expect.any(String), draft: { seq: 2, blocks: [{ index: 0, block: { type: "text", text: "thinking" } }] } },
        });

        yield* call(client, "agent.cancel", { sessionId: id });
        expect(yield* Fiber.join(prompt)).toEqual({ kind: "placed" });
        // A session the agent cannot tell of still opens: its subscribed says nothing of it.
        const unknown = yield* open(client, "agent.output", { sessionId: "nope" });
        expect(yield* unknown.next).toMatchObject({ type: "subscribed" });
      }),
    ));

  test("a prompt's error keeps its reason as the code and names the session; a malformed payload names the channel", () =>
    withAgent([], (client) =>
      Effect.gen(function* () {
        expect(hostError(yield* Effect.exit(call(client, "agent.prompt", { sessionId: "nope", content: text("hi"), requestId: "r1" })))).toMatchObject({
          code: "Session",
          subject: "nope",
        });
        expect(hostError(yield* Effect.exit(call(client, "agent.prompt", { sessionId: "nope", content: "hi", requestId: "r1" })))).toMatchObject({
          code: "InvalidPayload",
          subject: "agent.prompt",
        });
      }),
    ));

  test("a prompt without a request id is refused before it reaches the agent: a retry of it could place it twice", () =>
    withAgent([reply("unasked")], (client) =>
      Effect.gen(function* () {
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        for (const payload of [
          { sessionId: id, content: text("hi") },
          { sessionId: id, content: text("hi"), requestId: "" },
        ]) {
          expect(hostError(yield* Effect.exit(call(client, "agent.prompt", payload)))).toMatchObject({ code: "InvalidPayload", subject: "agent.prompt" });
        }
        expect(yield* call(client, "sessions.events", { sessionId: id })).toEqual([]);
      }),
    ));
});

describe("the agent leaving", () => {
  test("a prompt call waiting on its turn stops waiting at once over the wire, despite a long dispose deadline, and the host makes it again on the replacement, which resumes the turn", () => {
    // The first model call never answers; the resumed turn's does.
    const llm = fakeLlm([hang("thinking"), reply("done")]);
    return served(
      (home) => [paths(home, home), host(), sessions, tools, testTools().plugin, llm.plugin, agent],
      (client, core) =>
        Effect.gen(function* () {
          const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
          const prompt = { sessionId: id, content: text("go"), requestId: "r1" };
          const waiting = yield* Effect.forkChild(call(client, "agent.prompt", prompt));
          // The turn waits on the model, which only the agent stopping ends.
          yield* waitFor(
            Effect.sync(() => llm.requests.length),
            (asked) => asked === 1,
          );

          // The transport needs nothing the agent provides, so the connection stays: the agent alone restarts, its
          // stop never held by the call.
          const started = Date.now();
          yield* core.restart("agent.loop", { force: true });
          expect(Date.now() - started).toBeLessThan(3_000);

          // The prompt stayed taken: the replacement resumes its turn, and the call, made again, waits for it, placing
          // nothing twice.
          expect(yield* Fiber.join(waiting)).toEqual({ kind: "placed" });
          expect(llm.requests).toHaveLength(2);
          const log = (yield* call(client, "sessions.events", { sessionId: id })) as SessionEvent[];
          expect(log.filter((event) => event.data.type === "message" && event.data.message.role === "user")).toHaveLength(1);
        }),
      { configs: { "agent.loop": { stopGrace: 0 } }, deadlines: { dispose: Duration.seconds(30) } },
    );
  }, 30_000);

  test("a session cannot be deleted while a restart of the agent is still stopping its turn, though its channels are gone; once the turn has stopped, it can", () => {
    // The model answers once the gate opens, within the stopping agent's grace.
    const gate = Effect.runSync(Deferred.make<void>());
    const llm = fakeLlm([gated(gate, reply("late"))]);
    return served(
      (home) => [paths(home, home), host(), sessions, tools, testTools().plugin, llm.plugin, agent],
      (client, core) =>
        Effect.gen(function* () {
          const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
          const old = yield* core.run(Agent);
          yield* Effect.forkChild(call(client, "agent.prompt", { sessionId: id, content: text("go"), requestId: "r1" }));
          yield* waitFor(
            Effect.sync(() => llm.requests.length),
            (asked) => asked === 1,
          );

          const restart = yield* Effect.forkChild(core.restart("agent.loop", { force: true }));
          // The old agent's hooks and channels are retired, but its turn still runs, in its call, for the grace.
          yield* waitFor(client["Channel.List"](), (listed: readonly ChannelInfo[]) => !listed.some((channel) => channel.id === "agent.prompt"));
          expect(yield* old.busy(id)).toBe(true);
          expect(hostError(yield* Effect.exit(call(client, "sessions.delete", { sessionId: id })))).toMatchObject({ code: "Busy", subject: id });
          const removed = yield* Effect.exit(core.run(Effect.flatMap(Sessions, (store) => store.remove(id))));
          expect(Exit.isFailure(removed) && Exit.findErrorOption(removed)).toMatchObject({ _tag: "Some", value: { reason: "Busy", sessionId: id } });

          // The call answers, the old turn stops with the session whole, and the replacement takes over; with no turn
          // running, the session goes.
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(restart);
          yield* waitFor(call(client, "agent.running"), (running) => (running as readonly string[]).length === 0);
          expect(ofType((yield* call(client, "sessions.events", { sessionId: id })) as SessionEvent[], "message").map((data) => data.message.role)).toEqual([
            "user",
            "assistant",
          ]);
          expect(yield* call(client, "sessions.delete", { sessionId: id })).toBeNull();
        }),
      { configs: { "agent.loop": { stopGrace: 20 } }, deadlines: { dispose: Duration.seconds(30) } },
    );
  }, 30_000);

  test("a deletion that a SessionRemoveHook handler holds up while the restarted agent resumes a turn, then refuses, leaves the turn to resume", () => {
    const llm = fakeLlm([hang("thinking"), reply("done")]);
    const reached = Effect.runSync(Deferred.make<void>());
    const resume = Effect.runSync(Deferred.make<void>());
    const entered = Effect.runSync(Deferred.make<void>());
    const refuse = Effect.runSync(Deferred.make<void>());
    const race: { sessionId?: string } = {};
    // The sessions store, but the next hold of `race.sessionId` says it is `reached`, then waits for `resume`: the
    // restarted agent, about to hold the session to resume its turn, held up there while a deletion starts.
    const racing = definePlugin({
      id: "sessions",
      provides: [Sessions],
      requires: [Paths],
      exclusive: true,
      layer: Layer.effect(
        Sessions,
        Effect.map(Sessions, (store) => ({
          ...store,
          hold: (sessionId: string) => {
            if (sessionId !== race.sessionId) return store.hold(sessionId);
            delete race.sessionId;
            return Effect.andThen(Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(resume)), store.hold(sessionId));
          },
        })),
      ).pipe(Layer.provide(sessions.layer({}) as Layer.Layer<Sessions, never, Paths>)),
    });
    // Holds every deletion up until `refuse`, then refuses it.
    const refusing = definePlugin({
      id: "refusing",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(SessionRemoveHook, (input) =>
            Effect.andThen(
              Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(refuse)),
              Effect.fail(new SessionError({ sessionId: input.sessionId, reason: "Busy", message: "kept" })),
            ),
          ),
        ).pipe(Effect.orDie),
      ),
    });
    return served(
      (home) => [paths(home, home), host(), racing, tools, testTools().plugin, llm.plugin, agent, refusing],
      (client, core) =>
        Effect.gen(function* () {
          const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
          yield* Effect.forkChild(call(client, "agent.prompt", { sessionId: id, content: text("go"), requestId: "r1" }));
          yield* waitFor(
            Effect.sync(() => llm.requests.length),
            (asked) => asked === 1,
          );

          race.sessionId = id;
          const restart = yield* Effect.forkChild(core.restart("agent.loop", { force: true }));
          // The old turn has stopped and nothing holds the session: a deletion starts, and the handler holds it up.
          yield* Deferred.await(reached);
          const deletion = yield* Effect.forkChild(call(client, "sessions.delete", { sessionId: id }));
          yield* Deferred.await(entered);
          // The new agent holds the session and resumes its turn; then the handler refuses the deletion.
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(restart);
          yield* Deferred.succeed(refuse, undefined);
          expect(hostError(yield* Fiber.await(deletion))).toMatchObject({ code: "Busy", subject: id, message: "kept" });

          // Its journal kept, the turn resumed, asked the model again, and ended.
          yield* waitFor(call(client, "agent.running"), (running) => (running as readonly string[]).length === 0);
          const log = (yield* call(client, "sessions.events", { sessionId: id })) as SessionEvent[];
          expect(ofType(log, "turn-end")).toMatchObject([{ reason: "done" }]);
          expect(llm.requests).toHaveLength(2);
        }),
      { configs: { "agent.loop": { stopGrace: 0 } } },
    );
  }, 30_000);
});
