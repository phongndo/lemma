import { describe, expect, test } from "vitest";
import { Duration, Effect, Exit, Fiber } from "effect";
import { AgentChannels, Sessions } from "@lemma/contracts";
import type { AgentView, ChannelInfo, QueuedPrompt, SessionEvent, SessionInfo } from "@lemma/contracts";
import sessions from "../../sessions/src/index.ts";
import { call, collect, hostError, open, served } from "../../sessions/tests/served.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";
import { fakeLlm, hang, host, paths, reply, testTools, text, waitFor } from "./fakes.ts";
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
          Object.values(AgentChannels).map((channel) => [channel.id, channel.kind, "agent"]),
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
        expect(yield* call(client, "agent.prompt", { sessionId: id, content: text("hi"), requestId: "r1" })).toBeNull();
        // The session's log, as it is appended: its message carries the request id, which tells a client the prompt was taken.
        const appended = (yield* collect(followed, (seen) => seen.at(-1)?.event.data.type === "turn-end")).map((element) => element.event);
        expect(appended.map((event) => event.seq)).toEqual(appended.map((_, index) => index + 1));
        expect(appended.find((event) => event.data.type === "message" && event.data.message.role === "user")?.data).toMatchObject({ requestId: "r1" });

        // Each kind keeps its own order; `turn-ended` can overtake the last delta.
        const seen = yield* collect(activity, (seen) => count(seen, "turn-ended") === 1 && count(seen, "delta") === 4);
        const turnId = seen.find((element) => element.type === "turn-started")?.turnId;
        expect(seen.filter((element) => element.type === "turn-started")).toEqual([{ type: "turn-started", sessionId: id, turnId }]);
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
        expect(yield* call(client, "agent.prompt", { sessionId: id, content: text("hi"), requestId: "r1" })).toBeNull();
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

        // Refused by the agent through `SessionRemoveHook`, for a client and for a plugin alike.
        expect(hostError(yield* Effect.exit(call(client, "sessions.delete", { sessionId: id })))).toMatchObject({ code: "Busy", subject: id });
        const removed = yield* Effect.exit(core.run(Effect.flatMap(Sessions, (store) => store.remove(id))));
        expect(Exit.isFailure(removed) && Exit.findErrorOption(removed)).toMatchObject({ _tag: "Some", value: { reason: "Busy", sessionId: id } });

        expect(yield* call(client, "agent.cancel", { sessionId: id })).toBeNull();
        expect(yield* Fiber.join(first)).toBeNull();
        expect(yield* collect(activity, (seen) => count(seen, "turn-ended") === 1).pipe(Effect.map((seen) => seen.at(-1)))).toMatchObject({
          type: "turn-ended",
          sessionId: id,
          reason: "cancelled",
        });
        // With no turn running, it goes.
        expect(yield* call(client, "sessions.delete", { sessionId: id })).toBeNull();
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
          yield* core.restart("agent", { force: true });
          expect(Date.now() - started).toBeLessThan(3_000);

          // The prompt stayed taken: the replacement resumes its turn, and the call, made again, waits for it, placing
          // nothing twice.
          expect(yield* Fiber.join(waiting)).toBeNull();
          expect(llm.requests).toHaveLength(2);
          const log = (yield* call(client, "sessions.events", { sessionId: id })) as SessionEvent[];
          expect(log.filter((event) => event.data.type === "message" && event.data.message.role === "user")).toHaveLength(1);
        }),
      { configs: { agent: { stopGrace: 0 } }, deadlines: { dispose: Duration.seconds(30) } },
    );
  }, 30_000);
});
