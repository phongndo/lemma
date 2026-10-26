import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Deferred, Effect, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Events, makeCore } from "@lemma/core";
import { definePlugin } from "@lemma/core/plain";
import { Notice } from "@lemma/contracts";
import { hostControlPlugin, pathsPlugin } from "@lemma/contracts/testing";
import { Agent } from "@lemma/agent";
import agent from "@lemma/agent-loop";
import { callTools, reply, scriptedLlm, SCRIPTED_MODEL, toolCall } from "@lemma/llm/testing";
import type { Script } from "@lemma/llm/testing";
import { Sessions } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import { ToolResult, Tools } from "@lemma/tools";
import tools from "@lemma/tools-registry";
import budget, { summary } from "../budget.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lemma-budget-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A tool for the model to call, so a turn takes steps. */
const wait = definePlugin({
  id: "wait",
  setup: (_deps, { add }) => {
    add(Tools, {
      name: "wait",
      description: "Waits",
      input: Schema.Struct({}),
      execute: () => new ToolResult({ content: [{ type: "text", text: "waited" }] }),
    });
  },
});

describe("the notice", () => {
  it("says how long, how many model and tool calls, how much written, and the tokens", () => {
    const meter = { turnId: "t", startedAt: 0, calls: 1, modelMs: 1500, toolCalls: 2, toolMs: 300, chars: 12, tokens: 15, stopped: false };
    expect(summary(meter, 2000, 15, "done")).toBe(
      "Turn done after 2.0s: 1 model call taking 1.5s, 2 tool calls taking 0.3s, 12 characters written, 15 tokens.",
    );
    expect(summary({ ...meter, stopped: true, calls: 2 }, 2000, 30, "done")).toContain("Turn stopped at its token budget after 2.0s: 2 model calls");
  });
});

describe("in a turn", () => {
  const run = (scripts: readonly Script[], maxTokens: number) => {
    const llm = scriptedLlm(scripts);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(dir), hostControlPlugin(), sessions, tools, wait, agent, llm.plugin, budget], {
            configs: { "agent.loop": { defaultModel: SCRIPTED_MODEL.ref }, budget: { maxTokens } },
          });
          return yield* core.run(
            Effect.gen(function* () {
              // Its notice, which an observer of the turn's end posts after the turn.
              const notice = yield* Deferred.make<string>();
              yield* Effect.forkScoped(
                Stream.runForEach((yield* Events).stream(Notice), ({ message }) =>
                  message.startsWith("Turn ") ? Deferred.succeed(notice, message) : Effect.void,
                ),
              );
              yield* Effect.yieldNow;
              const { id } = yield* (yield* Sessions).create();
              yield* (yield* Agent).prompt(id, [{ type: "text", text: "go" }]);
              return { requests: llm.requests, notice: yield* Deferred.await(notice) };
            }),
          );
        }),
      ),
    );
  };
  const steps = [callTools(toolCall("wait", {}, "a")), callTools(toolCall("wait", {}, "b")), reply("done waiting")];

  it("stops a turn once it has used its budget, and says so", async () => {
    // Each answer of the scripted model uses 15 tokens: the second step reaches 20.
    const { requests, notice } = await run(steps, 20);
    expect(requests).toHaveLength(2);
    expect(notice).toMatch(
      /^Turn stopped at its token budget after [\d.]+s: 2 model calls taking [\d.]+s, 2 tool calls taking [\d.]+s, 0 characters written, 30 tokens\.$/,
    );
  });

  it("meters a turn with no budget to its end", async () => {
    const { requests, notice } = await run(steps, 0);
    expect(requests).toHaveLength(3);
    expect(notice).toMatch(/^Turn done after [\d.]+s: 3 model calls taking [\d.]+s, 2 tool calls taking [\d.]+s, 12 characters written, 45 tokens\.$/);
  });
});
