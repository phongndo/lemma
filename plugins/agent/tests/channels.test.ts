import { rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { Cause, Duration, Effect, Exit, Fiber } from "effect";
import { AgentChannels, Sessions } from "@lemma/contracts";
import type { AgentView, ChannelInfo, QueuedPrompt, SessionEvent, SessionInfo } from "@lemma/contracts";
import { callServed } from "@lemma/contracts/testing";
import { makeCore, Registries } from "@lemma/core";
import sessions from "../../sessions/src/index.ts";
import { call, collect, hostError, open, served } from "../../sessions/tests/served.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";
import { fakeLlm, hang, host, log, newSession, paths, reply, tempDir, testTools, text, waitFor } from "./fakes.ts";
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

  test("a prompt answers when its turn ends, which activity reports after subscribed; sent again with its id, it is not placed twice", () =>
    withAgent([reply("hello there")], (client) =>
      Effect.gen(function* () {
        const activity = yield* open(client, "agent.activity");
        expect(yield* activity.next).toEqual({ type: "subscribed", running: [] });
        const { id } = (yield* call(client, "sessions.create", {})) as SessionInfo;
        expect(yield* call(client, "agent.prompt", { sessionId: id, content: text("hi"), requestId: "r1" })).toBeNull();

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

        expect(hostError(yield* Effect.exit(call(client, "agent.prompt", { sessionId: id, content: text("no"), whenBusy: "reject" })))).toMatchObject({
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
        expect(hostError(yield* Effect.exit(call(client, "agent.prompt", { sessionId: "nope", content: text("hi") })))).toMatchObject({
          code: "Session",
          subject: "nope",
        });
        expect(hostError(yield* Effect.exit(call(client, "agent.prompt", { sessionId: "nope", content: "hi" })))).toMatchObject({
          code: "InvalidPayload",
          subject: "agent.prompt",
        });
      }),
    ));
});

// The transport restarts with the agent while it requires it, so these call as it does (`callServed`), not over the wire.
describe("the agent leaving", () => {
  test(
    "ends a prompt call waiting on its turn Withdrawn at once, despite a long dispose deadline; called again, it waits for the resumed turn",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* Effect.acquireRelease(Effect.promise(tempDir), (made) => Effect.promise(() => rm(made, { recursive: true, force: true })));
            // The first model call never answers; the resumed turn's does.
            const llm = fakeLlm([hang("thinking"), reply("done")]);
            const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, testTools().plugin, llm.plugin, agent], {
              configs: { agent: { stopGrace: 0 } },
              deadlines: { dispose: Duration.seconds(30) },
            });
            const registries = yield* core.run(Registries);
            const { id } = yield* core.run(newSession);
            const prompt = { sessionId: id, content: text("go"), requestId: "r1" };
            const waiting = yield* Effect.forkChild(Effect.exit(callServed(registries, "agent.prompt", prompt)));
            // The turn waits on the model, which only the agent stopping ends.
            yield* waitFor(
              Effect.sync(() => llm.requests.length),
              (asked) => asked === 1,
            );

            const restarting = yield* Effect.forkChild(core.restart("agent", { force: true }));
            const ended = yield* Fiber.join(waiting).pipe(Effect.timeout(Duration.seconds(3)));
            expect(Exit.isFailure(ended) && Cause.squash(ended.cause)).toMatchObject({ code: "Withdrawn", subject: "agent.prompt" });
            yield* Fiber.join(restarting);

            // The prompt stayed taken: the replacement resumes its turn, and the call waits for it, placing nothing twice.
            expect(yield* callServed(registries, "agent.prompt", prompt)).toBeUndefined();
            expect(llm.requests).toHaveLength(2);
            const users = (yield* core.run(log(id))).filter((event) => event.data.type === "message" && event.data.message.role === "user");
            expect(users).toHaveLength(1);
          }),
        ).pipe(Effect.timeout(Duration.seconds(20))),
      ),
    30_000,
  );
});
