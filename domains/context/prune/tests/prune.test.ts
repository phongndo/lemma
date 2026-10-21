import * as fs from "node:fs/promises";
import { Effect, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Events, Hooks, makeCore } from "@lemma/core";
import { Notice } from "@lemma/contracts";
import type { NoticePayload } from "@lemma/contracts";
import { Agent } from "@lemma/agent";
import { CompactionError, CompactionHook } from "@lemma/context";
import type { CompactionRequest } from "@lemma/context";
import { emptyUsage } from "@lemma/llm";
import type { AssistantMessage } from "@lemma/llm";
import { branchOf, rebuildRequest } from "@lemma/sessions";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import compaction from "@lemma/context-compaction";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { assistant, call, host, log, newSession, paths, reply, respond, runAgent, tempDir, text, useTools } from "../../../agent/loop/tests/fakes.ts";
import type { Script } from "../../../agent/loop/tests/fakes.ts";
import prune, { shorten, shortened, toShorten } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const branch = (...data: EventData[]): SessionEvent[] =>
  data.map((entry, i) => ({ seq: i + 1, id: `e${i}`, parent: i === 0 ? null : `e${i - 1}`, at: i, data: entry }));
const result = (id: string, value: string, toolName = "echo"): EventData => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: value }], isError: false, timestamp: 0 },
});
const said = (content: AssistantMessage["content"]): EventData => ({
  type: "message",
  message: assistant(content, content.some((part) => part.type === "toolCall") ? "toolUse" : "stop"),
});
const calling = (id: string, name = "echo"): EventData => said([call(id, name, {})]);
const ids = (events: readonly { readonly id: string }[]) => events.map((event) => event.id);

describe("which results it shortens", () => {
  const turns: EventData[] = [
    { type: "turn-start", turnId: "t1" },
    calling("c1"),
    result("c1", "z".repeat(50)),
    calling("c2"),
    result("c2", "short"),
    { type: "turn-start", turnId: "t2" },
    calling("c3"),
    result("c3", "y".repeat(50)),
  ];
  const answered = [...turns, said([{ type: "text", text: "ok" }])];
  const all = { minChars: 20, keepRecent: 0, exclude: [] };

  it("takes long results the model has answered, before the latest tokens it keeps whole", () => {
    // The last result is not answered yet: the model has not seen it.
    expect(ids(toShorten(branch(...turns), all))).toEqual(["e2"]);
    expect(ids(toShorten(branch(...answered), all))).toEqual(["e2", "e7"]);
    // About 15 tokens follow the first result, and 1 the last.
    expect(ids(toShorten(branch(...answered), { ...all, keepRecent: 2 }))).toEqual(["e2"]);
    expect(toShorten(branch(...answered), { ...all, keepRecent: 20 })).toEqual([]);
  });

  it("takes each once, even one an edit left long", () => {
    // Another plugin put long text in the first result's place: it is an edit already, not one to shorten.
    const edited = branch(...answered, {
      type: "context-edit",
      target: "e2",
      op: "replace",
      content: [{ type: "text", text: "w".repeat(60) }],
      source: "other",
    });
    expect(ids(toShorten(edited, all))).toEqual(["e7"]);
  });

  it("takes none of a tool it excludes", () => {
    const asked = branch(calling("c1", "ask_user"), result("c1", "z".repeat(50), "ask_user"), calling("c2"), result("c2", "y".repeat(50)), said([]));
    expect(ids(toShorten(asked, { ...all, exclude: ["ask_user"] }))).toEqual(["e3"]);
  });

  it("keeps the start and end, says how much it left out, and leaves a result the note would not shorten", () => {
    const value = `${"a".repeat(10)}${"m".repeat(100)}${"b".repeat(10)}`;
    expect(shortened(value, 20)).toBe(`${"a".repeat(10)}\n… [100 characters left out by context.prune; run the tool again for them] …\n${"b".repeat(10)}`);
    const [long, middling] = branch(result("c1", "z".repeat(2_000)), result("c2", "z".repeat(600)));
    expect(shorten([long!], 40, "context.prune")[0]?.freed).toBeGreaterThan(450);
    // Keeping more than the result holds would make it longer, and repeat its middle.
    expect(shorten([middling!], 1_000, "context.prune")).toEqual([]);
  });
});

// The second turn's request holds about 6,000 tokens (the reply before it says so), past compaction's 5,500 of the
// 100,000 window; shortening the 20,000-character result frees about 5,000 of them.
const holding = respond([{ type: "text", text: "done" }], "stop", { usage: { ...emptyUsage, input: 6_000, output: 5, totalTokens: 6_005 } });
const configs = (room: number) => ({
  "context.compaction": { at: 0.055, keepRecent: 10 },
  "context.prune": { room, minChars: 500, keepChars: 40, keepRecent: 0 },
});

/** Two turns in one session with compaction and prune, the first calling a tool; the model plays `scripts`. */
const twoTurns = (scripts: readonly Script[], room: number, extra: readonly Tool<any>[] = []) =>
  runAgent(dir, { scripts, tools: extra, plugins: [compaction, prune], configs: configs(room) }, ({ requests }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const notices: NoticePayload[] = [];
        yield* Effect.forkScoped(Stream.runForEach((yield* Events).stream(Notice), (notice) => Effect.sync(() => notices.push(notice))));
        yield* Effect.yieldNow;
        const { id } = yield* newSession;
        const agent = yield* Agent;
        yield* agent.prompt(id, text("go"));
        yield* agent.prompt(id, text("and again"));
        return { events: yield* log(id), notices, requests };
      }),
    ),
  );

/** The text of the tool result request `index` sent. */
const sentResult = (requests: Awaited<ReturnType<typeof twoTurns>>["requests"], index: number) =>
  requests[index]!.messages.find((message) => message.role === "toolResult")
    ?.content.map((part) => (part.type === "text" ? part.text : ""))
    .join("") ?? "";

const echoing = useTools(call("c1", "echo", { text: "z".repeat(20_000) }));

describe("in place of a summary", () => {
  it("shortens old results, and compaction does not summarize, when that leaves room below its threshold", async () => {
    const { events, notices, requests } = await twoTurns([echoing, holding, reply("again")], 0.01);
    expect(events.some((event) => event.data.type === "compaction")).toBe(false);
    expect(events.find((event) => event.data.type === "context-edit")?.data).toMatchObject({ op: "replace", source: "context.prune" });
    expect(notices).toContainEqual(
      expect.objectContaining({ level: "info", source: "context.prune", message: expect.stringMatching(/^Shortened 1 old tool result \(about 5k tokens\)/) }),
    );
    // No model call wrote a summary: in its own turn the result went out whole, and in the next shortened.
    expect(requests).toHaveLength(3);
    expect(sentResult(requests, 1)).toContain("z".repeat(20_000));
    expect(sentResult(requests, 2)).toContain("left out by context.prune");
    // The log keeps the result whole, and the request sent rebuilds from it.
    const logged = events.find((event) => event.data.type === "message" && event.data.message.role === "toolResult")!;
    expect(JSON.stringify(logged.data)).toContain("z".repeat(20_000));
    const lastRequest = [...events].reverse().find((event) => event.data.type === "request")!;
    expect(rebuildRequest(branchOf(events, events.at(-1)!.id), lastRequest.id)?.messages).toEqual(requests[2]!.messages);
  });

  it("leaves it to compaction when shortening would not leave room enough", async () => {
    const { events, requests } = await twoTurns([echoing, holding, reply("The summary."), reply("again")], 0.5);
    expect(events.find((event) => event.data.type === "compaction")?.data).toMatchObject({ summary: "The summary.", source: "context.compaction" });
    expect(events.some((event) => event.data.type === "context-edit")).toBe(false);
    expect(requests).toHaveLength(4);
  });

  it("keeps a shortened result's images: only its text is long", async () => {
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const shot: Tool<Record<string, never>> = {
      name: "shot",
      description: "Takes a screenshot, and describes it at length.",
      input: Schema.Struct({}),
      // Compaction counts the image as 1,200 tokens: the text is shorter, so the first turn stays below its threshold.
      execute: async () => new ToolResult({ content: [{ type: "text", text: "z".repeat(16_000) }, image] }),
    };
    const { requests } = await twoTurns([useTools(call("c1", "shot", {})), holding, reply("again")], 0.01, [shot]);
    const sent = requests[2]!.messages.find((message) => message.role === "toolResult")!;
    expect(sent.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(JSON.stringify(sent.content[0])).toContain("left out by context.prune");
    expect(sent.content[1]).toEqual(image);
  });

  it("leaves whole the results of a tool that says running it again would not give them back", async () => {
    const recall: Tool<Record<string, never>> = {
      name: "recall",
      description: "Recalls what was remembered.",
      input: Schema.Struct({}),
      irreplaceable: true,
      execute: async () => new ToolResult({ content: [{ type: "text", text: "z".repeat(20_000) }] }),
    };
    const { events } = await twoTurns([useTools(call("c1", "recall", {})), holding, reply("The summary."), reply("again")], 0.01, [recall]);
    expect(events.some((event) => event.data.type === "context-edit")).toBe(false);
    expect(events.some((event) => event.data.type === "compaction")).toBe(true);
  });
});

describe("a compaction it is asked about directly", () => {
  const history = branch(calling("c1"), result("c1", "z".repeat(20_000)), said([{ type: "text", text: "done" }]), {
    type: "message",
    message: { role: "user", content: text("and again"), timestamp: 0 },
  });
  const asked = (overrides: Partial<CompactionRequest>): CompactionRequest => ({
    sessionId: "s",
    turnId: "t",
    model: "fake/m1",
    contextWindow: 100_000,
    tokens: 6_000,
    threshold: 5_500,
    reason: "threshold",
    branch: history,
    firstKept: 2,
    append: (data) => Effect.succeed({ seq: 0, id: "appended", parent: null, at: 0, data }),
    ...overrides,
  });
  /** The request without `key`, as a compaction plugin written before it sends it. */
  const without = (key: "threshold" | "append") => Object.fromEntries(Object.entries(asked({})).filter(([name]) => name !== key)) as CompactionRequest;
  const summary = { kind: "summary", summary: "The summary.", firstKeptId: "e2" } as const;
  const invoke = (request: CompactionRequest) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, prune], {
            configs: { "context.prune": { minChars: 500, keepRecent: 0, room: 0.01 } },
          });
          return yield* core.run(Effect.flatMap(Hooks, (hooks) => hooks.invoke(CompactionHook, request, () => Effect.succeed(summary))));
        }),
      ),
    );

  it("shortens in its place when it can", async () => {
    expect(await invoke(asked({}))).toMatchObject({ kind: "skip" });
  });

  it("leaves to compaction one from a plugin that gives no threshold or append, an overflow, and /compact", async () => {
    for (const request of [without("threshold"), without("append"), asked({ reason: "overflow" }), asked({ reason: "requested" })])
      expect(await invoke(request)).toEqual(summary);
  });

  it("leaves it to compaction when its edits cannot be appended", async () => {
    expect(await invoke(asked({ append: () => Effect.fail(new CompactionError({ message: "the disk is full" })) }))).toEqual(summary);
  });
});
