import { describe, expect, it } from "vitest";
import type { ModelInfo, ThinkingLevel } from "../src/llm.ts";
import { chooseSmallModel, smallModel } from "../src/small.ts";
import { lowestThinking } from "../src/thinking.ts";

const model = (ref: string, levels: readonly ThinkingLevel[] = []): ModelInfo => {
  const slash = ref.indexOf("/");
  return {
    ref,
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    name: ref.slice(slash + 1),
    api: "x",
    reasoning: levels.length > 0,
    thinkingLevels: levels,
    input: ["text"],
    contextWindow: 1,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
};

/** Each provider's models as pi-ai's catalog lists them (some of them), read 2026-10-22. */
const catalog = (provider: string, ids: string) => ids.split(" ").map((id) => model(`${provider}/${id}`));
const anthropic = catalog("anthropic", "claude-fable-5 claude-haiku-4-5 claude-haiku-4-5-20251001 claude-haiku-5-5 claude-opus-5-5 claude-sonnet-5-5");
const openai = catalog("openai", "gpt-4o-mini gpt-5-mini gpt-5-nano gpt-5.6-luna gpt-5.6-sol gpt-6-luna gpt-6-sol o4-mini");
const google = catalog(
  "google",
  "gemini-2.5-flash gemini-2.5-flash-lite gemini-3.1-flash-lite gemini-3.1-flash-lite-image gemini-3.1-flash-lite-preview gemini-3.5-flash-lite gemini-3.8-flash gemini-flash-lite-latest gemini-4-argon",
);
const bedrock = catalog(
  "amazon-bedrock",
  "amazon.nova-lite-v1:0 anthropic.claude-haiku-4-5-20251001-v1:0 anthropic.claude-haiku-5-5 eu.anthropic.claude-haiku-5-5 anthropic.claude-opus-5-5",
);
const openrouter = catalog(
  "openrouter",
  "anthropic/claude-haiku-5.5 anthropic/claude-haiku-5.5:batch ~anthropic/claude-haiku-latest anthropic/claude-opus-5.5 ~openai/gpt-luna-latest",
);
const copilot = catalog("github-copilot", "claude-haiku-5.5 claude-opus-5.5 gemini-3.8-flash gpt-6-luna gpt-6-sol mai-code-1.1-flash");
const xai = catalog("xai", "grok-4.5 grok-4.7");
const all = [...anthropic, ...openai, ...google, ...bedrock, ...openrouter, ...copilot, ...xai];

const smallFor = (ref: string) =>
  smallModel(
    all,
    all.find((candidate) => candidate.ref === ref)!,
  )?.ref;

describe("a provider's small model", () => {
  it("is the newest of its family, in the thread's own provider", () => {
    expect(smallFor("anthropic/claude-opus-5-5")).toBe("anthropic/claude-haiku-5-5");
    expect(smallFor("openai/gpt-6-sol")).toBe("openai/gpt-6-luna");
    // Flash-Lite before Flash, and a plain id before its image and preview variants or the alias for the newest.
    expect(smallFor("google/gemini-4-argon")).toBe("google/gemini-3.5-flash-lite");
  });

  it("is the model a provider names plainly: no region, no batch", () => {
    expect(smallFor("amazon-bedrock/anthropic.claude-opus-5-5")).toBe("amazon-bedrock/anthropic.claude-haiku-5-5");
    expect(smallFor("openrouter/anthropic/claude-opus-5.5")).toBe("openrouter/anthropic/claude-haiku-5.5");
  });

  it("is of the thread's own line where the provider serves several", () => {
    expect(smallFor("github-copilot/claude-opus-5.5")).toBe("github-copilot/claude-haiku-5.5");
    expect(smallFor("github-copilot/gpt-6-sol")).toBe("github-copilot/gpt-6-luna");
    // Of no family's line: the first family it offers.
    expect(smallFor("openrouter/~openai/gpt-luna-latest")).toBe("openrouter/~openai/gpt-luna-latest");
  });

  it("is the newest by version, a dated snapshot's date coming after it", () => {
    const dated = catalog("openai", "gpt-6-luna-2026-01-15 gpt-6.1-luna gpt-6-sol");
    expect(smallModel(dated, dated[2]!)?.id).toBe("gpt-6.1-luna");
    // Of one version, the plain id before its snapshots, then the latest snapshot.
    const snapshots = catalog("anthropic", "claude-haiku-5-5-20260101 claude-haiku-5-5 claude-haiku-5-5-20260301 claude-opus-5-5");
    expect(smallModel(snapshots, snapshots[3]!)?.id).toBe("claude-haiku-5-5");
    expect(smallModel([snapshots[0]!, snapshots[2]!, snapshots[3]!], snapshots[3]!)?.id).toBe("claude-haiku-5-5-20260301");
  });

  it("is none where the provider offers no family", () => {
    expect(smallFor("xai/grok-4.7")).toBeUndefined();
  });
});

describe("what a small task runs on", () => {
  const reasoning = [
    model("anthropic/claude-opus-5-5", ["low", "medium", "high", "max"]),
    model("anthropic/claude-haiku-5-5", ["minimal", "low", "medium", "high"]),
  ];

  it("is the small model of the thread's provider, at its least reasoning until a level is chosen, until a model is", () => {
    expect(chooseSmallModel(reasoning, {}, "anthropic/claude-opus-5-5")).toEqual({ model: reasoning[1], thinking: "minimal" });
    // A level chosen applies to it too, as far as it offers that level.
    expect(chooseSmallModel(reasoning, { thinking: "high" }, "anthropic/claude-opus-5-5")).toEqual({ model: reasoning[1], thinking: "high" });
    expect(chooseSmallModel(reasoning, { thinking: "max" }, "anthropic/claude-opus-5-5")?.thinking).toBe("high");
    // The thread's own model where its provider has no small one, at the least it offers.
    expect(chooseSmallModel(xai, {}, "xai/grok-4.7")).toEqual({ model: xai[1] });
    // No thread: as a turn naming no model, the first available.
    expect(chooseSmallModel(reasoning, {})?.model.ref).toBe("anthropic/claude-haiku-5-5");
    expect(chooseSmallModel([], {})).toBeUndefined();
  });

  it("is the model chosen while it is available, at the level chosen as far as it offers it", () => {
    expect(chooseSmallModel(reasoning, { model: "anthropic/claude-opus-5-5", thinking: "high" }, "xai/grok-4.7")).toEqual({
      model: reasoning[0],
      thinking: "high",
    });
    expect(chooseSmallModel(reasoning, { model: "anthropic/claude-opus-5-5", thinking: "xhigh" })?.thinking).toBe("max");
    expect(chooseSmallModel(reasoning, { model: "anthropic/claude-opus-5-5" })?.thinking).toBe("low");
    // Its provider logged out: the small model of the thread's provider again.
    expect(chooseSmallModel(reasoning, { model: "openai/gpt-6-luna" }, "anthropic/claude-opus-5-5")?.model.ref).toBe("anthropic/claude-haiku-5-5");
  });

  it("asks the least reasoning by rank, not by the order a model lists its levels", () => {
    expect(lowestThinking(model("a/b", ["high", "off", "low"]))).toBe("off");
    expect(lowestThinking(model("a/b", ["low"]))).toBeUndefined();
  });
});
