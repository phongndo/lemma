import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { definePlugin, Hooks, makeCore } from "@lemma/core";
import { HostControl } from "@lemma/contracts";
import { pathsPlugin } from "@lemma/contracts/testing";
import { Agent } from "@lemma/agent";
import { agentConformance } from "@lemma/agent/testing";
import { emptyUsage, Llm, LlmError, streamThroughHook } from "@lemma/llm";
import type { LlmRequest, ModelInfo, StreamEvent } from "@lemma/llm";
import { Sessions } from "@lemma/sessions";
import sessions from "@lemma/sessions-files";
import tools from "@lemma/tools-registry";
import { World } from "@lemma/sim";
import freshLoop, { makeFreshLoop } from "../fresh-loop.ts";

const host = definePlugin({
  id: "host",
  provides: [HostControl],
  layer: Layer.succeed(HostControl, {
    runtime: [HostControl.key],
    process: { pid: process.pid, startedAt: 0 },
    plugins: Effect.succeed([]),
    composition: Effect.succeed({ id: "composition", plugins: [] }),
    restart: () => Effect.succeed({}),
    reload: Effect.die("unused"),
    configure: () => Effect.die("unused"),
    web: Effect.succeed({ plugins: {}, enabledIn: {}, configIn: {}, files: [] }),
  }),
});

const home = () => fs.mkdtemp(path.join(os.tmpdir(), "lemma-fresh-loop-"));

// An agent of another kind meets the contract agent.loop does, beside the same store and registry.
agentConformance("fresh-loop", async () => {
  const dir = await home();
  return [pathsPlugin(dir, { cwd: dir }), host, sessions, tools, freshLoop];
});

describe("each turn", () => {
  it("starts from a handoff of the turn before, in place of the whole history", async () => {
    const model: ModelInfo = {
      ref: "test/model",
      provider: "test",
      id: "model",
      name: "model",
      api: "test",
      reasoning: false,
      thinkingLevels: [],
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 8_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const requests: LlmRequest[] = [];
    const answers = ["The capital is Paris.", "It has about two million people."];
    const llm = definePlugin({
      id: "llm",
      provides: [Llm],
      layer: Layer.effect(
        Llm,
        Effect.map(Hooks, (hooks) => ({
          providers: Effect.succeed([]),
          models: () => Effect.succeed([model]),
          model: () => Effect.succeed(model),
          stream: (request: LlmRequest) =>
            streamThroughHook(hooks, request, (asked) =>
              Effect.sync(() => {
                requests.push(asked);
                const text = answers.shift() ?? "";
                return Stream.fromIterable<StreamEvent>([
                  { type: "start" },
                  {
                    type: "done",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text }],
                      api: "test",
                      provider: "test",
                      model: "model",
                      usage: emptyUsage,
                      stopReason: "stop",
                      timestamp: 1,
                    },
                  },
                ]);
              }),
            ),
          login: () => Effect.void,
          logout: () => Effect.void,
          addCustom: () => Effect.succeed("custom"),
          removeCustom: () => Effect.void,
          setLogo: () => Effect.void,
          classifiers: () => Effect.succeed([]),
          classify: () => Effect.fail(new LlmError({ reason: "UnknownModel", message: "none" })),
        })),
      ),
    });
    const dir = await home();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([pathsPlugin(dir, { cwd: dir }), host, sessions, tools, llm, freshLoop], {
            configs: { "fresh-loop": { defaultModel: model.ref } },
          });
          yield* core.run(
            Effect.gen(function* () {
              const { id } = yield* (yield* Sessions).create();
              const agent = yield* Agent;
              yield* agent.prompt(id, [{ type: "text", text: "What is the capital of France?" }]);
              yield* agent.prompt(id, [{ type: "text", text: "How many people live there?" }]);
            }),
          );
        }),
      ),
    );
    await fs.rm(dir, { recursive: true, force: true });
    const second = requests[1]!.messages;
    expect(second).toHaveLength(2);
    const said = second.map((message) => (message.role === "user" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : ""));
    expect(said[0]).toContain("The turn before, you were asked:\nWhat is the capital of France?");
    expect(said[0]).toContain("And you answered:\nThe capital is Paris.");
    expect(said[1]).toBe("How many people live there?");
  });
});

describe("in the harness simulator", () => {
  it("runs the workload under faults, crashes, and restarts, and the checks hold", async () => {
    process.env.TZ = "UTC";
    for (let seed = 1; seed <= 12; seed++) await new World({ seed, ticks: 60, agent: (seams) => makeFreshLoop(seams) }).run();
  }, 120_000);
});
