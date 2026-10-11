import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../src/llm.ts";
import { clampThinking, filterModels, resolveModel, thinkingLevels } from "../src/web/prefs.ts";

describe("prefs", () => {
  const model = (ref: string, levels: ModelInfo["thinkingLevels"], reasoning = true): ModelInfo => ({
    ref,
    provider: ref.split("/")[0]!,
    id: ref.split("/")[1]!,
    name: ref.toUpperCase(),
    api: "x",
    reasoning,
    thinkingLevels: levels,
    input: ["text"],
    contextWindow: 1,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  it("shows the chosen model, else the one the host would run", () => {
    const models = [model("opencode-go/glm", []), model("opencode-go/kimi", [])];
    expect(resolveModel(models, "opencode-go/kimi")?.ref).toBe("opencode-go/kimi");
    // Nothing chosen yet, or a choice whose provider is gone: the first available, as the host picks.
    expect(resolveModel(models, undefined)?.ref).toBe("opencode-go/glm");
    expect(resolveModel(models, "anthropic/claude")?.ref).toBe("opencode-go/glm");
    expect(resolveModel([], undefined)).toBeUndefined();
  });
  it("filters and groups models by provider", () => {
    const groups = filterModels([model("a/one", []), model("b/two", []), model("a/three", [])], "a o");
    expect(groups.map((g) => [g.provider, g.models.map((m) => m.ref)])).toEqual([["a", ["a/one"]]]);
    expect(filterModels([model("a/one", []), model("b/two", [])], "").map((g) => g.provider)).toEqual(["a", "b"]);
  });
  it("offers and clamps thinking levels to the model", () => {
    const m = model("a/x", ["low", "medium", "high"]);
    expect(thinkingLevels(model("a/y", ["low"], false))).toEqual([]);
    // A single level is no choice at all.
    expect(thinkingLevels(model("a/z", ["off"]))).toEqual([]);
    expect(clampThinking(model("d/v", ["off", "low", "high", "max"]), "medium")).toBe("high");
    expect(clampThinking(model("d/v", ["off", "low", "high", "max"]), "xhigh")).toBe("max");
    expect(clampThinking(m, "medium")).toBe("medium");
    expect(clampThinking(m, "xhigh")).toBe("high");
    expect(clampThinking(m, "off")).toBe("low");
    expect(clampThinking(m, undefined)).toBeUndefined();
    expect(clampThinking(undefined, "high")).toBeUndefined();
  });
});
