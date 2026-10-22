import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { testPlugin } from "@lemma/core/testing";
import { Llm, SmallModel } from "@lemma/llm";
import type { ModelInfo, ThinkingLevel } from "@lemma/llm";
import smallModel from "../src/index.ts";

const model = (ref: string, levels: readonly ThinkingLevel[] = []): ModelInfo => {
  const [provider, id] = ref.split("/") as [string, string];
  return {
    ref,
    provider,
    id,
    name: id,
    api: "x",
    reasoning: levels.length > 0,
    thinkingLevels: levels,
    input: ["text"],
    contextWindow: 1,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
};

const opus = model("anthropic/claude-opus-5-5", ["low", "medium", "high", "max"]);
const haiku = model("anthropic/claude-haiku-5-5", ["minimal", "low", "medium", "high"]);
const luna = model("openai/gpt-6-luna", ["minimal", "low", "medium"]);

/** `Llm` as far as `llm.small-model` asks it: `available`, and Luna besides, listed though its provider is logged out. */
const llm = (available: readonly ModelInfo[]) =>
  [Llm, { models: (options?: { readonly available?: boolean }) => Effect.succeed(options?.available === true ? available : [...available, luna]) }] as const;

const choose = async (config: unknown, available: readonly ModelInfo[], near?: string) => {
  await using tested = await testPlugin(smallModel, { config, provide: [llm(available)] });
  return tested.run((await tested.get(SmallModel)).choose(near));
};

describe("llm.small-model", () => {
  it("runs a thread's small task on its provider's small model, reasoning least, until a model is chosen", async () => {
    expect(await choose({}, [opus, haiku], opus.ref)).toEqual({ model: haiku, thinking: "minimal" });
    expect(await choose({ model: opus.ref, thinking: "high" }, [opus, haiku], opus.ref)).toEqual({ model: opus, thinking: "high" });
  });

  it("chooses among the models available when asked: one logged out of gives way to its thread's provider's", async () => {
    // Listed, but its provider is not logged in.
    expect(await choose({ model: luna.ref }, [opus, haiku], opus.ref)).toEqual({ model: haiku, thinking: "minimal" });
    expect(await choose({}, [])).toBeUndefined();
  });

  it("refuses a level that is none", async () => {
    await expect(testPlugin(smallModel, { config: { thinking: "lots" }, provide: [llm([])] })).rejects.toThrow(/thinking/);
  });
});
