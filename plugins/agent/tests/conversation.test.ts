import * as fs from "node:fs/promises";
import { Effect, Schema } from "effect";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { makeCore } from "@lemma/core";
import { Agent, branchOf, emptyUsage, rebuildRequest, Sessions } from "@lemma/contracts";
import type { LlmRequest, Message, SessionEvent, Tool } from "@lemma/contracts";
import sessions from "../../sessions/src/index.ts";
import tools from "../../tools/src/index.ts";
import agent from "../src/index.ts";
import { call, failWith, fakeLlm, host, paths, reply, tempDir, testTools, useTools } from "./fakes.ts";
import type { Script } from "./fakes.ts";

/*
 * Random conversations: prompts, answers that call tools (one of which
 * throws), failures, and checkouts back to any point of the branch, including
 * an assistant message whose calls were never answered. Every request the
 * model received must be well formed (each tool call answered, no result
 * without its call), never patched by a provider library behind the log's
 * back, and exactly what `rebuildRequest` rebuilds from the log.
 */

type Answer =
  | { readonly kind: "reply" }
  | { readonly kind: "tools"; readonly calls: number; readonly failing: boolean }
  | { readonly kind: "transient" }
  | { readonly kind: "fatal" };
type Step = { readonly kind: "prompt" } | { readonly kind: "checkout"; readonly back: number };

const answer: fc.Arbitrary<Answer> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "reply" as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("tools" as const), calls: fc.integer({ min: 1, max: 3 }), failing: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "transient" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "fatal" as const }) },
);
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "prompt" as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("checkout" as const), back: fc.nat(12) }) },
);

const boom: Tool<{ readonly text: string }> = {
  name: "boom",
  description: "Fails.",
  input: Schema.Struct({ text: Schema.String }),
  execute: async () => {
    throw new Error("boom");
  },
};

/** Problems with a request a provider would reject or repair: calls without results, results without calls. */
export function malformed(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  let open = new Set<string>();
  const answered = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      if (!open.delete(message.toolCallId)) problems.push(`message ${index}: result for ${message.toolCallId}, which no pending call made`);
      answered.add(message.toolCallId);
      continue;
    }
    if (open.size > 0) problems.push(`message ${index} (${message.role}): calls ${[...open].join(", ")} have no result`);
    open = new Set();
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") open.add(block.id);
    }
  }
  if (open.size > 0) problems.push(`calls ${[...open].join(", ")} have no result at the end`);
  return problems;
}

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const conversation = (answers: readonly Answer[], steps: readonly Step[]) => {
  let next = 0;
  let calls = 0;
  /** One answer per model call, in order; past the end, a reply, so every turn ends. */
  const script = (_request: LlmRequest): Script => {
    const chosen = answers[next++] ?? { kind: "reply" };
    switch (chosen.kind) {
      case "reply":
        return reply("answered");
      case "tools":
        return useTools(
          ...Array.from({ length: chosen.calls }, (_, i) => call(`c${++calls}`, chosen.failing && i === 0 ? "boom" : "echo", { text: `t${calls}` })),
        );
      case "transient":
        return failWith("502 Bad Gateway", { kind: "transient" });
      case "fatal":
        return failWith("Invalid API key", { kind: "fatal" });
    }
  };
  const llm = fakeLlm(Array.from({ length: 200 }, () => script));
  const toolset = testTools([boom]);
  return Effect.scoped(
    Effect.gen(function* () {
      const core = yield* makeCore([paths(dir, dir), host(), sessions, tools, toolset.plugin, llm.plugin, agent], {
        configs: { agent: { stopGrace: 0, retryDelay: 0.001, retries: 1, maxSteps: 4 } },
      });
      yield* core.run(
        Effect.gen(function* () {
          const store = yield* Sessions;
          const assistant = yield* Agent;
          const { id } = yield* store.create();
          for (const [index, current] of steps.entries()) {
            if (current.kind === "prompt") {
              yield* assistant.prompt(id, [{ type: "text", text: `prompt ${index}` }]).pipe(Effect.ignore);
              continue;
            }
            const branch = yield* store.branch(id);
            const target = branch.at(-1 - Math.min(current.back, branch.length - 1));
            if (target !== undefined) yield* store.checkout(id, target.id);
          }
          const events = yield* store.events(id);
          const logged = events.filter((event) => event.data.type === "request");
          expect(logged.length).toBe(llm.requests.length);
          logged.forEach((event: SessionEvent, i) => {
            const sent = llm.requests[i]!;
            expect(malformed(sent.messages), `request ${i}`).toEqual([]);
            expect(rebuildRequest(branchOf(events, event.id), event.id, id), `request ${i} rebuilds`).toEqual(sent);
          });
        }),
      );
    }),
  );
};

describe("conversations", () => {
  test("every request is well formed and rebuilds from the log, whatever the branch", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(answer, { maxLength: 30 }), fc.array(step, { minLength: 1, maxLength: 12 }), async (answers, steps) => {
        await Effect.runPromise(conversation(answers, steps));
      }),
      {
        numRuns: Number(process.env.LEMMA_CONVERSATION_RUNS ?? 25),
        ...(process.env.LEMMA_CONVERSATION_SEED === undefined ? {} : { seed: Number(process.env.LEMMA_CONVERSATION_SEED) }),
        ...(process.env.LEMMA_CONVERSATION_PATH === undefined ? {} : { path: process.env.LEMMA_CONVERSATION_PATH }),
      },
    );
  }, 300_000);

  test("malformed finds calls without results and results without calls", () => {
    const user: Message = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
    const callBlock = call("a", "echo", {});
    const assistantWith: Message = {
      role: "assistant",
      content: [callBlock],
      api: "",
      provider: "",
      model: "",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 0,
    };
    const result: Message = { role: "toolResult", toolCallId: "a", toolName: "echo", content: [], isError: false, timestamp: 0 };
    expect(malformed([user, assistantWith, result, user])).toEqual([]);
    expect(malformed([user, assistantWith, user])).toEqual(["message 2 (user): calls a have no result"]);
    expect(malformed([user, result])).toEqual(["message 1: result for a, which no pending call made"]);
  });
});
