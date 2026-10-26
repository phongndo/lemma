import * as fs from "node:fs/promises";
import { Effect, Fiber, Option, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Notice } from "@lemma/contracts";
import { Agent, AgentRequestHook } from "@lemma/agent";
import { contentText, emptyUsage } from "@lemma/llm";
import { branchOf, promptUpdateText, rebuildRequest, Sessions, summaryText, trajectory } from "@lemma/sessions";
import type { NoticePayload } from "@lemma/contracts";
import type { AssistantMessage, LlmRequest, Message, StreamEvent } from "@lemma/llm";
import type { EventData, SessionEvent } from "@lemma/sessions";
import agent from "@lemma/agent-loop";
import { call, failWith, fakeLlm, host, ofType, paths, reply, respond, tempDir, testTools, useTools } from "../../../agent/loop/tests/fakes.ts";
import type { Script } from "../../../agent/loop/tests/fakes.ts";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import compaction, { chooseCut, compactAsked, estimateTokens, requestChars, transcript } from "../src/index.ts";
import { filesOf, REVIEW_PROMPT, SUMMARY_PROMPT, summaryAsk, viewTokens } from "../src/compact.ts";

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
    // The usage before it counted what the summary replaced: estimated instead (base and summary as the model reads
    // it, its files too, then the kept prompt).
    const summary = compacted.at(-1)!.data as Extract<EventData, { type: "compaction" }>;
    expect(estimateTokens(compacted, () => 400)).toBe(Math.ceil((400 + summaryText(summary).length) / 4) + 10);
    const listing = { ...summary, files: { read: ["a.ts"], modified: ["b".repeat(400)] } };
    expect(estimateTokens([...compacted.slice(0, -1), { ...compacted.at(-1)!, data: listing }], () => 400)).toBeGreaterThan(100 + 100 + 10);
  });

  it("counts a prompt update only while requests still send it: not once a request has declared the prompt afresh", () => {
    const update: EventData = { type: "prompt-update", sections: [{ id: "todo", source: "t", text: "t".repeat(4_000) }] };
    const restart: EventData = { type: "request", requestId: "r", model: "p/m", restart: "tools" } as unknown as EventData;
    const told = Math.ceil(promptUpdateText(update as Extract<EventData, { type: "prompt-update" }>).length / 4);
    const prompt = message(user("x".repeat(400)));
    expect(estimateTokens(branch(prompt, update), () => 0)).toBe(100 + told);
    expect(estimateTokens(branch(prompt, update, restart), () => 0)).toBe(100);
    expect(viewTokens(branch(prompt, update, restart))).toBe(100);
    expect(viewTokens(branch(prompt, restart, update))).toBe(100 + told);
  });
});

describe("context a plugin told the model", () => {
  it("counts in the estimate, and is a place the history may be kept from", () => {
    const told: EventData = { type: "context", source: "mail", content: [{ type: "text", text: "z".repeat(80) }] };
    const log = branch(message(user("x".repeat(400))), message(answer([{ type: "text", text: "ok" }], 900, 100)), told);
    // 1,000 reported, then 20 for what the plugin told it.
    expect(estimateTokens(log, () => 0)).toBe(1020);
    expect(chooseCut(log, 1)).toBe(2);
  });

  it("is no place to keep the history from when it is logged among a response's results", () => {
    // The model sees it after the result; on the branch it is before it, so keeping from it would keep the result
    // without its call.
    const told: EventData = { type: "context", source: "mail", content: [{ type: "text", text: "z".repeat(80) }] };
    const log = branch(
      message(user("x".repeat(400))),
      message(answer([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }])),
      told,
      message(result("c1", "r".repeat(40))),
      message(answer([{ type: "text", text: "done" }])),
    );
    // The last response, 1 token, is enough; for 20, the call with its result and the context after it.
    expect(chooseCut(log, 1)).toBe(4);
    expect(chooseCut(log, 20)).toBe(1);
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
    expect(text.startsWith("<previous-summary>\nbefore\n</previous-summary>\n\n<conversation>\n[2 earlier messages omitted]")).toBe(true);
    expect(text.endsWith("more characters)\n</conversation>")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2_200);
  });

  it("asks to fold in the previous summary and the user's focus, and always ends with the same line", () => {
    expect(summaryAsk("T", false, undefined)).toBe("T\n\nSummarize the conversation above.");
    const ask = summaryAsk("T", true, "the API design");
    expect(ask).toContain("write one summary of both");
    expect(ask).toContain("The user asked the summary to focus on: the API design");
    expect(ask.endsWith("Summarize the conversation above.")).toBe(true);
  });
});

describe("asking for a compaction", () => {
  const text = (value: string) => [{ type: "text" as const, text: value }];
  it("is /compact alone or with what to focus on, and nothing else", () => {
    expect(compactAsked(text("/compact"))).toEqual({});
    expect(compactAsked(text("  /compact  \n"))).toEqual({});
    expect(compactAsked(text("/compact keep the\nAPI design "))).toEqual({ instructions: "keep the\nAPI design" });
    expect(compactAsked(text("/compaction"))).toBeUndefined();
    expect(compactAsked(text("please /compact"))).toBeUndefined();
    expect(compactAsked([...text("/compact"), { type: "image", data: "", mimeType: "image/png" }])).toBeUndefined();
    // Parts are lines of one prompt: a command split across them is not one, and its focus may follow it.
    expect(compactAsked([...text("/compact"), ...text("keep API")])).toEqual({ instructions: "keep API" });
    expect(compactAsked([...text("/comp"), ...text("act")])).toBeUndefined();
  });
});

/** A request for a summary, whether a fork of the turn's last request or a transcript sent to summarize: it ends asking for one. */
const isSummary = (request: LlmRequest) => contentText(request.messages.at(-1)?.content ?? []).endsWith("Summarize the conversation above.");

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
const twoTurns = (summary: Script, second: readonly Script[] = [reply("b")], others: readonly Plugin[] = [], config: Record<string, unknown> = {}) => {
  const llm = fakeLlm([reply("a"), summary, ...second]);
  const toolset = testTools();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, toolset.plugin, llm.plugin, agent, compaction, ...others], {
          configs: { "context.compaction": { at: 0.0005, keepRecent: 10, ...config } },
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

describe("in a session", () => {
  it("summarizes the earlier conversation before a call that would fill too much of the window", async () => {
    const { id, events, notices, requests, turns } = await twoTurns(reply("They asked about x; it was answered."));
    // The first turn's request, the summary, the second turn's request.
    expect(requests.map((request) => isSummary(request))).toEqual([false, true, false]);
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

  it("writes the summary in a fork of the turn's last request, so its provider's cache serves all but the ask", async () => {
    const { events, requests } = await twoTurns(reply("They asked about x."));
    const [last, fork] = [requests[0]!, requests[1]!];
    expect(fork.system).toBe(last.system);
    expect(fork.tools).toEqual(last.tools);
    expect(fork.messages.slice(0, last.messages.length)).toEqual(last.messages);
    expect(contentText(fork.messages.at(-1)!.content)).toContain("<compaction>\n\nFrom Lemma, not the user");
    // The request after it declares its prompt afresh, as one after a compaction does.
    expect(ofType(events, "request").map((request) => request.restart)).toEqual(["start", "compaction"]);
  });

  it("asks for a transcript's summary when the fork answers without one, and counts both calls", async () => {
    const { events, requests } = await twoTurns(useTools(call("c9", "echo", { text: "no" })), [reply("From the transcript."), reply("b")]);
    expect(requests[1]!.system).toBe(requests[0]!.system);
    expect(requests[2]!.system).toBe(SUMMARY_PROMPT);
    expect(ofType(events, "compaction")[0]).toMatchObject({ summary: "From the transcript.", usage: { input: 20, output: 10 } });
  });

  it("asks for a transcript's summary when the fork fails, is cut off at its limit, or calls a tool after some text", async () => {
    const forks: readonly Script[] = [
      failWith("overloaded"),
      cutOff,
      respond([{ type: "text", text: "Let me check the file first." }, call("c9", "echo", { text: "no" })], "toolUse"),
    ];
    for (const fork of forks) {
      const { events, requests } = await twoTurns(fork, [reply("From the transcript."), reply("b")]);
      expect(requests[2]!.system).toBe(SUMMARY_PROMPT);
      expect(ofType(events, "compaction").map((made) => made.summary)).toEqual(["From the transcript."]);
    }
  });

  it("keeps the summary as written when its review fails, or its reader's questions are cut off", async () => {
    for (const reader of [failWith("rate limited"), cutOff]) {
      const { events, notices } = await twoTurns(reply("They asked about x."), [reader, reply("b")], [], { review: true });
      expect(ofType(events, "compaction").map((made) => made.summary)).toEqual(["They asked about x."]);
      expect(notices.filter((notice) => notice.level === "warning")).toEqual([]);
    }
  });

  it("has a reader of the summary ask what it leaves out, and the turn's model answer, when review is on", async () => {
    const { events, requests } = await twoTurns(reply("They asked about x."), [reply("1. Which file?"), reply("1. src/x.ts"), reply("b")], [], {
      review: true,
    });
    expect(requests[2]!.system).toBe(REVIEW_PROMPT);
    expect(contentText(requests[2]!.messages[0]!.content)).toBe("They asked about x.");
    // The answers come from a fork of the last request, which saw the conversation.
    expect(requests[3]!.system).toBe(requests[0]!.system);
    expect(contentText(requests[3]!.messages.at(-1)!.content)).toContain("1. Which file?");
    const summary = ofType(events, "compaction")[0]!.summary;
    expect(summary).toBe("They asked about x.\n\n## Questions a reader asked, answered\n\n1. Which file?\n\n1. src/x.ts");
  });

  it("summarizes a turn that keeps filling the window three times at most, and says so once", async () => {
    // Each step's tool result alone fills the (tiny) threshold again.
    const echo = (id: string) => useTools(call(id, "echo", { text: id.repeat(200) }));
    const { events, notices } = await twoTurns(reply("Summary 1."), [
      echo("c1"),
      reply("Summary 2."),
      echo("c2"),
      reply("Summary 3."),
      echo("c3"),
      echo("c4"),
      reply("b"),
    ]);
    expect(ofType(events, "compaction").map((made) => made.summary)).toEqual(["Summary 1.", "Summary 2.", "Summary 3."]);
    expect(notices.filter((notice) => notice.level === "warning").map((notice) => notice.message)).toEqual([
      "Summarized 3 times this turn and still near the context limit: not summarizing again until the next turn",
    ]);
    expect(ofType(events, "turn-end").map((ended) => ended.reason)).toEqual(["done", "done"]);
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
    expect(requests.map((request) => isSummary(request))).toEqual([false, false, true, false]);
    expect(events.filter((event) => event.data.type === "compaction")).toHaveLength(1);
    expect(events.flatMap((event) => (event.data.type === "turn-end" ? [event.data.reason] : []))).toEqual(["done", "done"]);
  });

  it("goes ahead without a summary when writing one fails, and tries no more that turn", async () => {
    const { events, notices, requests } = await twoTurns(failWith("overloaded"), [
      failWith("overloaded"),
      useTools(call("c1", "echo", { text: "hi" })),
      reply("b"),
    ]);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    // The second turn's two model calls, with one summary attempt (a fork, then a transcript) before the first.
    expect(requests.map((request) => isSummary(request))).toEqual([false, true, true, false, false]);
    expect(requests[3]!.messages).toHaveLength(3);
    expect(notices).toEqual([{ level: "warning", source: "context.compaction", message: "Could not summarize the earlier conversation: overloaded" }]);
  });

  it("does not take a summary cut off at its length limit", async () => {
    // The fork's, then the transcript's.
    const { events, notices } = await twoTurns(cutOff, [cutOff, reply("b")]);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    expect(notices[0]!.message).toContain("the summary ran past");
  });

  /**
   * A turn, `/compact the x question`, then two more turns, the model answering `script` in turn; with `others`. The
   * first notice published is the compaction's outcome.
   */
  const asking = (script: readonly Script[], others: readonly Plugin[] = []) => {
    const llm = fakeLlm(script);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The default threshold and recent share: these turns are far from both.
          const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, testTools().plugin, llm.plugin, agent, compaction, ...others]);
          return yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const firstNotice = yield* Effect.forkScoped(Stream.runHead((yield* Events).stream(Notice)));
              yield* Effect.yieldNow;
              const { id } = yield* store.create();
              const turns = yield* Agent;
              yield* turns.prompt(id, long("x"));
              const outcome = yield* turns.prompt(id, [{ type: "text", text: "/compact the x question" }]);
              yield* turns.prompt(id, long("y"));
              yield* turns.prompt(id, long("z"));
              return { events: yield* store.events(id), outcome, notice: Option.getOrUndefined(yield* Fiber.join(firstNotice)), requests: llm.requests };
            }),
          );
        }),
      ),
    );
  };

  it("summarizes when the user asks with /compact, before the next model call, whatever its estimate, and only once", async () => {
    const { events, notice, outcome, requests } = await asking([reply("a"), reply("They asked about x."), reply("b"), reply("c")]);
    expect(outcome).toMatchObject({ kind: "handled", by: "context.compaction" });
    // The first turn's request, the summary, then the next two turns' requests: no second summary.
    expect(requests.map((request) => isSummary(request))).toEqual([false, true, false, false]);
    expect(JSON.stringify(requests[1]!.messages)).toContain("The user asked the summary to focus on: the x question");
    // Far shorter than what is kept by default, the conversation is summarized but for its last quarter: the new prompt.
    const prompt = events.find((event) => event.data.type === "message" && JSON.stringify(event.data.message).includes("y".repeat(400)))!;
    expect(events.flatMap((event) => (event.data.type === "compaction" ? [event.data] : []))).toMatchObject([{ firstKeptId: prompt.id }]);
    expect(notice).toMatchObject({ level: "info", message: expect.stringContaining("Summarized the earlier conversation") });
    // The command itself is not logged.
    expect(JSON.stringify(events)).not.toContain("/compact");
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

describe("files", () => {
  const asks = (...calls: readonly (readonly [string, string, Record<string, unknown>])[]): Message => ({
    role: "assistant",
    content: calls.map(([id, name, args]) => ({ type: "toolCall" as const, id, name, arguments: args })),
    api: "fake",
    provider: "fake",
    model: "m1",
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 1,
  });
  const result = (id: string, isError = false): Message => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "t",
    content: [{ type: "text", text: isError ? "failed" : "ok" }],
    isError,
    timestamp: 1,
  });

  it("lists what the replaced history read and changed, after the previous summary's, each once at its latest", () => {
    // Read as `apply_patch` reads it: a marker indented.
    const patch = "*** Begin Patch\n  *** Update File: src/c.ts\n@@\n-a\n+b\n*** Add File: src/d.ts\n+d\n*** End Patch";
    const files = filesOf(
      [
        asks(["r1", "read", { path: "src/a.ts" }], ["r2", "read", { path: "src/b.ts" }]),
        result("r1"),
        result("r2"),
        asks(["e1", "edit", { path: "src/a.ts", edits: [] }], ["p1", "apply_patch", { input: patch }]),
        result("e1"),
        result("p1"),
      ],
      { read: ["old.ts"], modified: ["src/b.ts"] },
    );
    // Read files changed since are listed as changed only.
    expect(files).toEqual({ read: ["old.ts"], modified: ["src/b.ts", "src/a.ts", "src/c.ts", "src/d.ts"] });
  });

  it("leaves out calls that failed, or have no result: they read and changed nothing", () => {
    const files = filesOf(
      [
        asks(["r1", "read", { path: "gone.ts" }], ["e1", "edit", { path: "a.ts", edits: [] }], ["w1", "write", { path: "b.ts", content: "" }]),
        result("r1", true),
        result("e1", true),
        asks(["p1", "apply_patch", { input: "*** Begin Patch\n*** Update File: c.ts\n-x\n*** End Patch" }]),
      ],
      undefined,
    );
    expect(files).toEqual({ read: [], modified: [] });
  });
});
