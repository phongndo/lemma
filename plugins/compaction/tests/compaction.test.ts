import * as fs from "node:fs/promises";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Events, makeCore } from "@lemma/core";
import { Agent, branchOf, emptyUsage, Notice, rebuildRequest, Sessions, trajectory } from "@lemma/contracts";
import type { AssistantMessage, EventData, Message, NoticePayload, SessionEvent, StreamEvent } from "@lemma/contracts";
import agent from "../../agent/src/index.ts";
import harnesses from "../../harnesses/src/index.ts";
import { call, failWith, fakeLlm, host, paths, reply, tempDir, testTools, useTools } from "../../agent/tests/fakes.ts";
import type { Script } from "../../agent/tests/fakes.ts";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import compaction, { chooseCut, estimateTokens, transcript } from "../src/index.ts";
import { SUMMARY_PROMPT } from "../src/compact.ts";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const answer = (content: AssistantMessage["content"], input = 0, output = 0): Message => ({
  role: "assistant",
  content,
  api: "fake",
  provider: "fake",
  model: "m",
  usage: { ...emptyUsage, input, output, totalTokens: input + output },
  stopReason: "stop",
  timestamp: 1,
});
const result = (id: string, text: string): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 1,
});
const branch = (...data: EventData[]): SessionEvent[] =>
  data.map((entry, i) => ({ seq: i + 1, id: `e${i}`, parent: i === 0 ? null : `e${i - 1}`, at: i, data: entry }));
const message = (value: Message): EventData => ({ type: "message", message: value });

describe("the estimate", () => {
  it("counts from the last reported usage, and only one after the latest compaction", () => {
    const log = branch(message(user("x".repeat(400))), message(answer([{ type: "text", text: "ok" }], 900, 100)), message(user("y".repeat(40))));
    // 1,000 reported, then 10 for the new prompt.
    expect(estimateTokens(log, () => 0)).toBe(1010);
    const compacted = branch(message(user("x".repeat(400))), message(answer([{ type: "text", text: "ok" }], 900, 100)), message(user("y".repeat(40))), {
      type: "compaction",
      summary: "s".repeat(40),
      firstKeptId: "e2",
      tokensBefore: 1010,
      source: "compaction",
    });
    // The usage before it counted what the summary replaced: estimated instead (base, summary, kept prompt).
    expect(estimateTokens(compacted, () => 400)).toBe(100 + 10 + 10);
  });
});

describe("the cut", () => {
  it("keeps about the recent tokens asked for, never between a tool call and its result", () => {
    const log = branch(
      message(user("a".repeat(400))),
      message(answer([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }])),
      message(result("c1", "r".repeat(4000))),
      message(answer([{ type: "text", text: "done" }])),
      message(user("b".repeat(40))),
    );
    // The last prompt alone (10 tokens) is enough.
    expect(chooseCut(log, 10)).toBe(4);
    // More than the last two messages: the result is too big to start at, so its call is where the kept part starts.
    expect(chooseCut(log, 20)).toBe(1);
    // More than there is: keep all but the first message.
    expect(chooseCut(log, 1_000_000)).toBe(1);
    expect(chooseCut(branch(message(user("only"))), 1)).toBeUndefined();
  });

  it("drops the oldest messages from what it sends to summarize, keeping the previous summary", () => {
    const text = transcript([user("a".repeat(100)), user("b".repeat(100)), result("c", "r".repeat(5000))], "before", 2_200);
    expect(text.startsWith("[summary of the conversation before this]\nbefore")).toBe(true);
    expect(text).toContain("[2 earlier messages omitted]");
    expect(text).toContain("more characters)");
  });
});

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const long = (letter: string) => [{ type: "text" as const, text: letter.repeat(400) }];

/**
 * Two turns in one session, the second summarizing the first once 50 tokens (of a 100,000 window) are in use; the
 * second turn's model calls play `second` (a tool call makes a turn of two steps).
 */
const twoTurns = (summary: Script, second: readonly Script[] = [reply("b")]) => {
  const llm = fakeLlm([reply("a"), summary, ...second]);
  const toolset = testTools();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(dir, dir), host(), sessions, harnesses, tools, toolset.plugin, llm.plugin, agent, compaction], {
          configs: { compaction: { at: 0.0005, keepRecent: 10 } },
        });
        return yield* core.run(
          Effect.gen(function* () {
            const store = yield* Sessions;
            const notices: NoticePayload[] = [];
            yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice))));
            yield* Effect.yieldNow();
            const { id } = yield* store.create();
            const turns = yield* Agent;
            yield* turns.prompt(id, long("x"));
            yield* turns.prompt(id, long("y"));
            yield* Effect.sleep("10 millis");
            const events = yield* store.events(id);
            return { id, events, notices, requests: llm.requests, turns: trajectory(branchOf(events, events.at(-1)!.id)) };
          }),
        );
      }),
    ),
  );
};

/** A summary the model stopped writing at its length limit. */
const cutOff: Script = Stream.fromIterable<StreamEvent>([
  { type: "start" },
  { type: "text-delta", index: 0, delta: "They asked about" },
  {
    type: "done",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "They asked about" }],
      api: "fake",
      provider: "fake",
      model: "m1",
      usage: { ...emptyUsage, input: 10, output: 8192, totalTokens: 8202 },
      stopReason: "length",
      timestamp: 1,
    },
  },
]);

describe("in a session", () => {
  it("summarizes the earlier conversation before a call that would fill too much of the window", async () => {
    const { id, events, notices, requests, turns } = await twoTurns(reply("They asked about x; it was answered."));
    // The first turn's request, the summary, the second turn's request.
    expect(requests.map((request) => request.system === SUMMARY_PROMPT)).toEqual([false, true, false]);
    expect(JSON.stringify(requests[1]!.messages)).toContain("x".repeat(400));
    const logged = events.flatMap((event) => (event.data.type === "compaction" ? [event] : []));
    expect(logged).toHaveLength(1);
    const prompt = [...events].reverse().find((event) => event.data.type === "message" && event.data.message.role === "user")!;
    expect(logged[0]!.data).toMatchObject({
      summary: "They asked about x; it was answered.",
      firstKeptId: prompt.id,
      source: "compaction",
      turnId: turns[1]!.turnId,
      usage: { input: 10, output: 5 },
    });
    // The model saw the summary, then the kept prompt; the log rebuilds exactly that.
    expect(requests[2]!.messages.map((sent) => JSON.stringify(sent).includes("They asked about x"))).toEqual([true, false]);
    const request = [...events].reverse().find((event) => event.data.type === "request")!;
    expect(rebuildRequest(branchOf(events, request.id), request.id, id)).toEqual(requests[2]);
    expect(notices).toMatchObject([{ level: "info", source: "compaction" }]);
    // The summary's cost is part of the turn's: its model call and the summary's, 10 in and 5 out each.
    expect(turns[1]!.usage).toMatchObject({ input: 20, output: 10 });
  });

  it("goes ahead without a summary when writing one fails, and tries no more that turn", async () => {
    const { events, notices, requests } = await twoTurns(failWith("overloaded"), [useTools(call("c1", "echo", { text: "hi" })), reply("b")]);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    // The second turn's two model calls, with one summary attempt before the first.
    expect(requests.map((request) => request.system === SUMMARY_PROMPT)).toEqual([false, true, false, false]);
    expect(requests[2]!.messages).toHaveLength(3);
    expect(notices).toEqual([{ level: "warning", source: "compaction", message: "Could not summarize the earlier conversation: overloaded" }]);
  });

  it("does not take a summary cut off at its length limit", async () => {
    const { events, notices } = await twoTurns(cutOff);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    expect(notices[0]!.message).toContain("the summary ran past");
  });

  it("sizes the request after every other handler has added to it", async () => {
    const order = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(dir, dir), host(), sessions, harnesses, tools, fakeLlm([]).plugin, agent, compaction]);
          const snapshot = yield* core.inspect;
          return snapshot.hooks.find((hook) => hook.name === "lemma/agent.request")?.handlers.find((handler) => handler.pluginId === "compaction")?.order;
        }),
      ),
    );
    expect(order).toBe(1_000);
  });
});
