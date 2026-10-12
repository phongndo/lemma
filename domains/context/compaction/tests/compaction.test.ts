import * as fs from "node:fs/promises";
import { Effect, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext } from "@lemma/core";
import type { Handler, Plugin } from "@lemma/core";
import { CompactionHook } from "@lemma/context";
import type { CompactionError } from "@lemma/context";
import type { CompactionRequest, CompactionResult } from "@lemma/context";
import { Notice } from "@lemma/contracts";
import { Agent, AgentRequestHook } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import { branchOf, rebuildRequest, Sessions, trajectory } from "@lemma/sessions";
import type { NoticePayload } from "@lemma/contracts";
import type { AssistantMessage, Message, StreamEvent } from "@lemma/llm";
import type { EventData, SessionEvent } from "@lemma/sessions";
import agent from "@lemma/agent-loop";
import { call, failWith, fakeLlm, host, paths, reply, tempDir, testTools, useTools } from "../../../agent/loop/tests/fakes.ts";
import type { Script } from "../../../agent/loop/tests/fakes.ts";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import compaction, { chooseCut, estimateTokens, requestChars, transcript } from "../src/index.ts";
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
      source: "context.compaction",
    });
    // The usage before it counted what the summary replaced: estimated instead (base, summary, kept prompt).
    expect(estimateTokens(compacted, () => 400)).toBe(100 + 10 + 10);
  });
});

describe("the request's own size", () => {
  it("counts the tools the model is sent, not those only a tool that runs others calls", () => {
    const tool = (name: string, description: string, flags: { readonly nested?: true; readonly nests?: true }) => ({
      spec: { name, description, parameters: {} },
      source: "test",
      ...flags,
    });
    const runner = tool("codemode", "Runs others", { nests: true });
    const many = Array.from({ length: 50 }, (_, i) => tool(`mcp__docs__t${i}`, "d".repeat(2_000), { nested: true }));
    expect(requestChars({ sections: [], tools: [runner, ...many] })).toBeLessThan(200);
    // With nothing to call them, they are declared, and counted.
    expect(requestChars({ sections: [], tools: many })).toBeGreaterThan(100_000);
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
const twoTurns = (summary: Script, second: readonly Script[] = [reply("b")], others: readonly Plugin[] = []) => {
  const llm = fakeLlm([reply("a"), summary, ...second]);
  const toolset = testTools();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, toolset.plugin, llm.plugin, agent, compaction, ...others], {
          configs: { "context.compaction": { at: 0.0005, keepRecent: 10 } },
        });
        return yield* core.run(
          Effect.gen(function* () {
            const store = yield* Sessions;
            const notices: NoticePayload[] = [];
            yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice))));
            yield* Effect.yieldNow;
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

/** A plugin whose `CompactionHook` handler answers every compaction with `result` (given the request). */
const answering = (id: string, result: (request: CompactionRequest) => CompactionResult) =>
  definePlugin({
    id,
    layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(CompactionHook, (request) => Effect.succeed(result(request))))),
  });

describe("in a session", () => {
  it("lets a plugin write the summary itself through CompactionHook: no model writes one, and it is credited", async () => {
    const mine = answering("my-summary", (request) => ({ kind: "summary", summary: "Mine.", firstKeptId: request.branch[request.firstKept]!.id }));
    const { events, requests } = await twoTurns(reply("b"), [], [mine]);
    expect(requests.map((request) => request.system === SUMMARY_PROMPT)).toEqual([false, false]);
    expect(events.flatMap((event) => (event.data.type === "compaction" ? [event.data] : []))).toMatchObject([{ summary: "Mine.", source: "my-summary" }]);
  });

  it("credits the outermost plugin whose summary differs from what it was handed", async () => {
    const handler = (id: string, order: number, handle: Handler<CompactionRequest, CompactionResult, CompactionError>) =>
      definePlugin({ id, layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(CompactionHook, handle, { order }))) });
    // The inner one skips; the outer one writes a summary over the skip.
    const skips = handler("skips", 1, () => Effect.succeed({ kind: "skip", reason: "not now" }));
    const writesOver = handler("writes-over", 0, (request, next) =>
      Effect.map(next(request), (made) =>
        made.kind === "skip" ? { kind: "summary", summary: "Over.", firstKeptId: request.branch[request.firstKept]!.id } : made,
      ),
    );
    const { events } = await twoTurns(reply("b"), [], [skips, writesOver]);
    expect(events.flatMap((event) => (event.data.type === "compaction" ? [event.data] : []))).toMatchObject([{ summary: "Over.", source: "writes-over" }]);
  });

  it("keeps the history only from a place it may be: a summary cut elsewhere fails, and the history stays as it is", async () => {
    // Its first event: before anything the summary could stand for.
    const { events, notices } = await twoTurns(
      reply("b"),
      [],
      [answering("bad-cut", (request) => ({ kind: "summary", summary: "Mine.", firstKeptId: request.branch[0]!.id }))],
    );
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    expect(notices).toMatchObject([{ level: "warning", source: "context.compaction", message: expect.stringContaining("cannot be kept from") }]);
  });

  it("lets a plugin skip a compaction, which leaves the history as it is", async () => {
    const { events, requests } = await twoTurns(reply("b"), [], [answering("keeps-all", () => ({ kind: "skip", reason: "keeps everything" }))]);
    expect(requests).toHaveLength(2);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
  });

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
      source: "context.compaction",
      turnId: turns[1]!.turnId,
      usage: { input: 10, output: 5 },
    });
    // The model saw the summary, then the kept prompt; the log rebuilds exactly that.
    expect(requests[2]!.messages.map((sent) => JSON.stringify(sent).includes("They asked about x"))).toEqual([true, false]);
    const request = [...events].reverse().find((event) => event.data.type === "request")!;
    expect(rebuildRequest(branchOf(events, request.id), request.id, id)).toEqual(requests[2]);
    expect(notices).toMatchObject([{ level: "info", source: "context.compaction" }]);
    // The summary's cost is part of the turn's: its model call and the summary's, 10 in and 5 out each.
    expect(turns[1]!.usage).toMatchObject({ input: 20, output: 10 });
  });

  it("summarizes, whatever its estimate, once the model refused a request as too long", async () => {
    const llm = fakeLlm([
      reply("a"),
      failWith("prompt is too long: 120000 tokens > 100000 maximum", { kind: "overflow" }),
      reply("They asked about x."),
      reply("b"),
    ]);
    const toolset = testTools();
    const { events, requests } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, toolset.plugin, llm.plugin, agent, compaction], {
            configs: { "context.compaction": { keepRecent: 10 }, "agent.loop": { retryDelay: 0.001 } },
          });
          return yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const { id } = yield* store.create();
              const turns = yield* Agent;
              yield* turns.prompt(id, long("x"));
              yield* turns.prompt(id, long("y"));
              return { events: yield* store.events(id), requests: llm.requests };
            }),
          );
        }),
      ),
    );
    // The first turn's request, the refused one, the summary, and the shortened request.
    expect(requests.map((request) => request.system === SUMMARY_PROMPT)).toEqual([false, false, true, false]);
    expect(events.filter((event) => event.data.type === "compaction")).toHaveLength(1);
    expect(events.flatMap((event) => (event.data.type === "turn-end" ? [event.data.reason] : []))).toEqual(["done", "done"]);
  });

  it("goes ahead without a summary when writing one fails, and tries no more that turn", async () => {
    const { events, notices, requests } = await twoTurns(failWith("overloaded"), [useTools(call("c1", "echo", { text: "hi" })), reply("b")]);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    // The second turn's two model calls, with one summary attempt before the first.
    expect(requests.map((request) => request.system === SUMMARY_PROMPT)).toEqual([false, true, false, false]);
    expect(requests[2]!.messages).toHaveLength(3);
    expect(notices).toEqual([{ level: "warning", source: "context.compaction", message: "Could not summarize the earlier conversation: overloaded" }]);
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
          // However late another handler asks to run, compaction's phase comes after it.
          const late = definePlugin({
            id: "zzz.late",
            setup: function* () {
              yield* (yield* PluginContext).on(AgentRequestHook, (draft, next) => next(draft), { order: Number.MAX_SAFE_INTEGER });
            },
          });
          const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, fakeLlm([]).plugin, agent, compaction, late]);
          const snapshot = yield* core.inspect;
          return snapshot.hooks.find((hook) => hook.name === "lemma/agent.request")?.handlers;
        }),
      ),
    );
    expect(order?.at(-1)).toEqual({ pluginId: "context.compaction", phase: "fit", order: 0 });
    expect(order?.at(-2)).toMatchObject({ pluginId: "zzz.late", phase: "shape" });
  });
});
