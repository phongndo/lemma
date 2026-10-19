import { describe, expect, it } from "vitest";
import { emptyUsage, LlmRequest } from "@lemma/llm";
import type { AssistantMessage } from "@lemma/llm";
import type * as Pi from "@earendil-works/pi-ai";
import { AMAZON_BEDROCK_MODELS } from "@earendil-works/pi-ai/providers/amazon-bedrock.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { bindsThinking, toContext } from "../src/convert.ts";

const thought = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: `why ${text}`, thinkingSignature: `sig-${text}` },
    { type: "text", text },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: 1,
});

const request = (thinkingFrom?: number) =>
  new LlmRequest({
    model: "anthropic/m",
    messages: [{ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 }, thought("a"), thought("b")],
    ...(thinkingFrom === undefined ? {} : { thinkingFrom }),
  });

/** A model of pi-ai's catalogs, by provider and id. */
const catalog = { anthropic: ANTHROPIC_MODELS, bedrock: AMAZON_BEDROCK_MODELS } as unknown as Record<string, Record<string, Pi.Model<Pi.Api>>>;
const model = (provider: "anthropic" | "bedrock", id: string) => catalog[provider]![id]!;
const adaptive = model("anthropic", "claude-opus-5-5");
const openai = { api: "openai-responses", id: "gpt-6-sol", name: "gpt-6-sol", reasoning: true } as unknown as Pi.Model<Pi.Api>;

const blocks = (context: ReturnType<typeof toContext>) =>
  context.messages.map((message) => (message.role === "assistant" ? message.content.map((block) => block.type) : message.role));

describe("toContext", () => {
  it("leaves out the thinking made under another prefix, for a model that binds thinking to it", () => {
    expect(blocks(toContext(request(2), adaptive))).toEqual(["user", ["text"], ["thinking", "text"]]);
    expect(blocks(toContext(request(2), model("bedrock", "anthropic.claude-sonnet-5-5")))).toEqual(["user", ["text"], ["thinking", "text"]]);
  });

  it("sends every thinking block to a model that binds none: budget-thinking Claude needs a tool round's back, and others take it back", () => {
    expect(blocks(toContext(request(2), model("anthropic", "claude-sonnet-4-5")))).toEqual(["user", ["thinking", "text"], ["thinking", "text"]]);
    expect(blocks(toContext(request(2), model("bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0")))).toEqual([
      "user",
      ["thinking", "text"],
      ["thinking", "text"],
    ]);
    expect(blocks(toContext(request(2), openai))).toEqual(["user", ["thinking", "text"], ["thinking", "text"]]);
    expect(blocks(toContext(request(), adaptive))).toEqual(["user", ["thinking", "text"], ["thinking", "text"]]);
  });

  it("takes Anthropic's adaptive-thinking models from pi-ai's thinking levels, as its own metadata marks them", () => {
    // Bedrock's models carry no such mark: pi-ai tells them by id, which the same levels agree with.
    for (const each of Object.values(catalog.anthropic!).filter((candidate) => candidate.reasoning)) {
      expect([each.id, bindsThinking(each)]).toEqual([each.id, (each as Pi.Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true]);
    }
    expect(bindsThinking(model("bedrock", "anthropic.claude-opus-4-6-v1"))).toBe(true);
    expect(bindsThinking(model("bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"))).toBe(false);
  });
});
