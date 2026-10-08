import { describe, expect, test } from "vitest";
import { Effect, Schema, Stream } from "effect";
import type { Context } from "effect";
import { Events, makeCore } from "@lemma/core";
import { AgentChannels, serveAgent } from "../src/agent.ts";
import type { Agent } from "../src/agent.ts";
import { elementsOf, resultOf, wireCodec } from "../src/channels.ts";
import type { Channel, ChannelCall, ChannelStream } from "../src/channels.ts";
import { ToolOutput } from "../src/tools.ts";

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
      prompt: answer("prompt", undefined),
      cancel: answer("cancel", undefined),
      busy: answer("busy", true),
      running: Effect.succeed(["s1"]),
      queue: answer("queue", []),
      withdraw: answer("withdraw", false),
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
        expect(asked).toEqual([
          ["prompt", "s1", content, { requestId: "r1" }],
          ["prompt", "s1", content, { model: "p/m", thinking: "high", requestId: "r2", whenBusy: "steer" }],
          ["withdraw", "s1", "r2"],
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
});
