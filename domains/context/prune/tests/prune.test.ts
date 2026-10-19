import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCore } from "@lemma/core";
import { Agent } from "@lemma/agent";
import { branchOf, rebuildRequest, Sessions } from "@lemma/sessions";
import type { EventData, SessionEvent } from "@lemma/sessions";
import agent from "@lemma/agent-loop";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { call, fakeLlm, host, paths, reply, tempDir, testTools, useTools } from "../../../agent/loop/tests/fakes.ts";
import prune, { shortened, toShorten } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const branch = (...data: EventData[]): SessionEvent[] =>
  data.map((entry, i) => ({ seq: i + 1, id: `e${i}`, parent: i === 0 ? null : `e${i - 1}`, at: i, data: entry }));
const result = (id: string, text: string): EventData => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError: false, timestamp: 0 },
});
const calling = (id: string): EventData => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "echo", arguments: {} }],
    api: "fake",
    provider: "fake",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  },
});

describe("which results it shortens", () => {
  it("takes long results before the turns it keeps whole, once each", () => {
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
    const log = branch(...turns);
    expect(toShorten(log, { minChars: 20, keepTurns: 1 }).map((event) => event.id)).toEqual(["e2"]);
    expect(toShorten(log, { minChars: 20, keepTurns: 0 }).map((event) => event.id)).toEqual(["e2", "e7"]);
    expect(toShorten(log, { minChars: 20, keepTurns: 2 })).toEqual([]);
    const edited = branch(...turns, { type: "context-edit", target: "e2", op: "replace", content: [{ type: "text", text: "z…" }], source: "context.prune" });
    expect(toShorten(edited, { minChars: 20, keepTurns: 0 }).map((event) => event.id)).toEqual(["e7"]);
  });

  it("keeps the start and end, and says how much it left out", () => {
    const text = `${"a".repeat(10)}${"m".repeat(100)}${"b".repeat(10)}`;
    expect(shortened(text, 20)).toBe(`${"a".repeat(10)}\n… [100 characters left out by context.prune; run the tool again for them] …\n${"b".repeat(10)}`);
  });
});

describe("in a turn", () => {
  it("shortens an old long result in what the model is sent, logs the edit, and the request rebuilds from the log", async () => {
    const llm = fakeLlm([useTools(call("c1", "echo", { text: "z".repeat(2_000) })), reply("done"), reply("again")]);
    const toolset = testTools();
    const { events, requests } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, toolset.plugin, llm.plugin, agent, prune], {
            configs: { "context.prune": { at: 0.001, minChars: 500, keepChars: 40, keepTurns: 1 } },
          });
          return yield* core.run(
            Effect.gen(function* () {
              const store = yield* Sessions;
              const { id } = yield* store.create();
              const turns = yield* Agent;
              yield* turns.prompt(id, [{ type: "text", text: "go" }]);
              yield* turns.prompt(id, [{ type: "text", text: "and again" }]);
              return { events: yield* store.events(id), requests: llm.requests };
            }),
          );
        }),
      ),
    );
    const resultText = (index: number) => {
      const sent = requests[index]!.messages.find((message) => message.role === "toolResult");
      return sent?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
    };
    // In its own turn the result is whole; in the next it is shortened.
    expect(resultText(1)).toContain("z".repeat(2_000));
    expect(resultText(2)).toContain("left out by context.prune");
    expect(resultText(2).length).toBeLessThan(200);
    const edit = events.find((event) => event.data.type === "context-edit");
    expect(edit?.data).toMatchObject({ op: "replace", source: "context.prune" });
    // The log keeps the result whole, and the request sent rebuilds from it.
    const logged = events.find((event) => event.data.type === "message" && event.data.message.role === "toolResult")!;
    expect(JSON.stringify(logged.data)).toContain("z".repeat(2_000));
    const lastRequest = [...events].reverse().find((event) => event.data.type === "request")!;
    const rebuilt = rebuildRequest(branchOf(events, events.at(-1)!.id), lastRequest.id);
    expect(rebuilt?.messages).toEqual(requests[2]!.messages);
  });
});
