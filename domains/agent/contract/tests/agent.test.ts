import { describe, expect, test } from "vitest";
import { Effect, Option, Schema, Stream } from "effect";
import type { Context } from "effect";
import { Events, makeCore } from "@lemma/core";
import { AgentChannels, AgentError, AssistantDelta, serveAgent, TurnEnded, TurnStarted } from "../src/agent.ts";
import type { Agent } from "../src/agent.ts";
import { elementsOf, resultOf, wireCodec } from "@lemma/contracts";
import type { Channel, ChannelCall, ChannelStream } from "@lemma/contracts";
import { ToolOutput } from "@lemma/tools";

describe("serveAgent", () => {
  /** An agent that records what each channel asked of it, with a turn running in `s1`. */
  const recording = () => {
    const asked: unknown[][] = [];
    const answer =
      <A>(name: string, value: A) =>
      (...args: unknown[]) =>
        Effect.sync(() => {
          asked.push([name, ...args]);
          return value;
        });
    const agent: Context.Service.Shape<typeof Agent> = {
      prompt: answer("prompt", { kind: "placed" } as const),
      cancel: answer("cancel", undefined),
      busy: answer("busy", true),
      running: Effect.succeed(["s1"]),
      queue: answer("queue", []),
      withdraw: answer("withdraw", false),
      promote: answer("promote", false),
      view: answer("view", { output: [], queue: [], queueRevision: 1 }),
    };
    return { asked, agent };
  };
  const withServed = <A>(
    body: (channels: ReadonlyMap<string, Channel>, asked: unknown[][], events: Context.Service.Shape<typeof Events>) => Effect.Effect<A, unknown>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* makeCore([])).run(Events);
          const { asked, agent } = recording();
          return yield* body(new Map(serveAgent(agent, events).map((channel) => [channel.id, channel])), asked, events);
        }),
      ),
    );
  const called = (channels: ReadonlyMap<string, Channel>, id: string, payload: unknown) => resultOf(channels.get(id) as ChannelCall, payload);
  const content = [{ type: "text", text: "hi" }];

  test("serves each declaration as declared", () =>
    withServed((channels) =>
      Effect.sync(() => {
        expect([...channels.values()].map(({ handle: _, ...declared }) => declared)).toEqual(Object.values(AgentChannels));
      }),
    ));

  test("a prompt reaches the agent with its request id, turn options, and what to do while busy, and nothing the client left out", () =>
    withServed((channels, asked) =>
      Effect.gen(function* () {
        yield* called(channels, "agent.prompt", { sessionId: "s1", content, requestId: "r1" });
        yield* called(channels, "agent.prompt", { sessionId: "s1", content, options: { model: "p/m", thinking: "high" }, requestId: "r2", whenBusy: "steer" });
        yield* called(channels, "agent.withdraw", { sessionId: "s1", requestId: "r2" });
        yield* called(channels, "agent.promote", { sessionId: "s1", requestId: "r1" });
        expect(asked).toEqual([
          ["prompt", "s1", content, { requestId: "r1" }],
          ["prompt", "s1", content, { model: "p/m", thinking: "high", requestId: "r2", whenBusy: "steer" }],
          ["withdraw", "s1", "r2"],
          ["promote", "s1", "r1"],
        ]);
      }),
    ));

  test("a prompt names its request id, without which a client's retry would place it twice: none, or an empty one, is refused", () => {
    const decode = (payload: unknown) => Schema.decodeUnknownSync(wireCodec(AgentChannels.prompt.payload))(payload);
    expect(decode({ sessionId: "s1", content, requestId: "r1" })).toEqual({ sessionId: "s1", content, requestId: "r1" });
    expect(() => decode({ sessionId: "s1", content })).toThrow();
    expect(() => decode({ sessionId: "s1", content, requestId: "" })).toThrow();
  });

  test("activity starts with subscribed and the sessions running then, and reports tools' output with its offset", () =>
    withServed((channels, _, events) =>
      Effect.gen(function* () {
        const activity = elementsOf(channels.get("agent.activity") as ChannelStream, undefined).pipe(
          Stream.tap((element: any) =>
            element.type === "subscribed" ? events.publish(ToolOutput, { sessionId: "s1", toolCallId: "c1", chunk: "ok", offset: 3 }) : Effect.void,
          ),
          Stream.take(2),
        );
        expect(yield* Stream.runCollect(activity)).toEqual([
          { type: "subscribed", running: ["s1"] },
          { type: "tool-output", sessionId: "s1", toolCallId: "c1", chunk: "ok", offset: 3 },
        ]);
      }),
    ));

  /** What a turn in `sessionId` publishes: its start, one delta, one chunk of a tool's output, its end. */
  const turn = (events: Context.Service.Shape<typeof Events>, sessionId: string) =>
    Effect.all([
      events.publish(TurnStarted, { sessionId, turnId: `t-${sessionId}`, requestIds: [] }),
      events.publish(AssistantDelta, { sessionId, turnId: `t-${sessionId}`, stepId: "st", seq: 1, event: { type: "start" } }),
      events.publish(ToolOutput, { sessionId, toolCallId: `c-${sessionId}`, chunk: "ok", offset: 0 }),
      events.publish(TurnEnded, { sessionId, turnId: `t-${sessionId}`, usage, reason: "done" as const }),
    ]);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  test("activity opened without output hears every session's turns and none of their output; with no payload, all of it", () =>
    withServed((channels, _, events) =>
      Effect.gen(function* () {
        const heard = (payload: unknown) =>
          elementsOf(channels.get("agent.activity") as ChannelStream, Schema.decodeUnknownSync(wireCodec(AgentChannels.activity.payload))(payload)).pipe(
            Stream.tap((element: any) => (element.type === "subscribed" ? Effect.andThen(turn(events, "s1"), turn(events, "s2")) : Effect.void)),
            Stream.takeUntil((element: any) => element.type === "turn-ended" && element.sessionId === "s2"),
            Stream.runCollect,
          );
        const scoped: any[] = yield* heard({ output: false });
        expect(scoped.map((element) => element.type).filter((type) => type === "delta" || type === "tool-output")).toEqual([]);
        expect(scoped.filter((element) => element.type === "turn-started").map((element) => element.sessionId)).toEqual(["s1", "s2"]);
        // As a client calling it by id sends no payload, `null` on the wire.
        const all: any[] = yield* heard(null);
        expect(all.filter((element) => element.type === "tool-output").map((element) => element.sessionId)).toEqual(["s1", "s2"]);
      }),
    ));

  test("output opens with the agent's view of its session, then sends that session's output alone; with no view to tell, none", () =>
    withServed((channels, asked, events) =>
      Effect.gen(function* () {
        const output = (sessionId: string) =>
          elementsOf(channels.get("agent.output") as ChannelStream, { sessionId }).pipe(
            Stream.tap((element: any) => (element.type === "subscribed" ? Effect.andThen(turn(events, "s2"), turn(events, sessionId)) : Effect.void)),
            Stream.take(3),
            Stream.runCollect,
          );
        expect(yield* output("s1")).toEqual([
          { type: "subscribed", view: { output: [], queue: [], queueRevision: 1 } },
          { type: "delta", sessionId: "s1", turnId: "t-s1", stepId: "st", seq: 1, event: { type: "start" } },
          { type: "tool-output", sessionId: "s1", toolCallId: "c-s1", chunk: "ok", offset: 0 },
        ]);
        expect(asked).toContainEqual(["view", "s1"]);

        const failing = new Map(
          serveAgent(
            { ...recording().agent, view: (sessionId) => Effect.fail(new AgentError({ sessionId, reason: "Session", message: "unreadable" })) },
            events,
          ).map((channel) => [channel.id, channel]),
        );
        const first = yield* Stream.runHead(elementsOf(failing.get("agent.output") as ChannelStream, { sessionId: "s1" }));
        expect(first).toEqual(Option.some({ type: "subscribed" }));
      }),
    ));
});
