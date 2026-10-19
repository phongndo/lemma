import { describe, expect, it } from "vitest";
import { emptyUsage, LlmRequest } from "@lemma/llm";
import type { AssistantMessage, Message, StreamEvent } from "@lemma/llm";
import { anthropicMessages } from "../src/anthropic.ts";
import { openaiCompletions } from "../src/completions.ts";
import { errorText, ProviderError, sse } from "../src/http.ts";
import type { Model } from "../src/model.ts";
import { classifyFailure, Output } from "../src/output.ts";
import { openaiResponses } from "../src/responses.ts";
import type { Wire, WireCall } from "../src/wire.ts";
import { sseBody } from "./helpers.ts";

const model = (extra: Partial<Model> = {}): Model => ({
  provider: "p",
  id: "m",
  name: "m",
  api: "openai-completions",
  baseUrl: "https://p.test/v1",
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 32_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  reasoning: false,
  ...extra,
});

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const answer = (
  by: Pick<Model, "provider" | "api" | "id">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: by.api,
  provider: by.provider,
  model: by.id,
  usage: emptyUsage,
  stopReason,
  timestamp: 1,
});
const result = (toolCallId: string, text: string, image = false): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }, ...(image ? [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }] : [])],
  isError: false,
  timestamp: 1,
});

const call = (target: Model, request: Partial<ConstructorParameters<typeof LlmRequest>[0]>, extra: Partial<WireCall> = {}): WireCall => ({
  model: target,
  request: new LlmRequest({ model: `${target.provider}/${target.id}`, messages: [user("hi")], ...request }),
  level: undefined,
  auth: { key: "sk", oauth: false },
  cacheRetention: "short",
  ...extra,
});

/** What `wire` makes of `body`'s events for `target`, ended as the plugin ends it. */
async function parse(wire: Wire, target: Model, body: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const out = new Output(target, (more) => events.push(...more));
  out.start();
  try {
    await wire.read(sse(new Response(body).body!), out, call(target, {}), () => {});
    out.finish();
  } catch (error) {
    out.fail(error);
  }
  return events;
}

const last = (events: StreamEvent[]) => events.at(-1)!;

describe("anthropic-messages", () => {
  const claude = model({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", id: "claude" });

  it("sends the system prompt, tools, and history with cache breakpoints, its results grouped in one user turn", () => {
    const built = anthropicMessages.build(
      call(
        claude,
        {
          system: "Be brief",
          tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
          messages: [
            user("look"),
            answer(claude, [
              { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
              { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
              { type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
            ]),
            result("t1", "A"),
            result("t2", "B", true),
          ],
        },
        { cacheRetention: "long" },
      ),
    );
    expect(built.url).toBe("https://api.anthropic.com/v1/messages");
    expect(built.headers).toMatchObject({ "x-api-key": "sk", "anthropic-version": "2023-06-01" });
    const cache = { type: "ephemeral", ttl: "1h" };
    expect(built.body).toEqual({
      model: "claude",
      stream: true,
      max_tokens: 32_000,
      system: [{ type: "text", text: "Be brief", cache_control: cache }],
      tools: [
        {
          name: "read",
          description: "Read",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          cache_control: cache,
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "sig" },
            { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
            { type: "tool_use", id: "t2", name: "read", input: { path: "b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "A", is_error: false },
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [
                { type: "text", text: "B" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
              ],
              is_error: false,
              cache_control: cache,
            },
          ],
        },
      ],
    });
  });

  it("asks an adaptive model for an effort, a budget model for tokens, and turns thinking off only where it can be", () => {
    const adaptive = { ...claude, reasoning: true, thinking: { kind: "effort" as const, levels: ["off", "low", "high", "max"] as const } } as Model;
    const budget = { ...claude, reasoning: true, thinking: { kind: "budget" as const, levels: ["off", "low", "high"] as const } } as Model;
    expect(anthropicMessages.build(call(adaptive, { providerOptions: { temperature: 0.5 } }, { level: "max" })).body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
    const off = anthropicMessages.build(call(adaptive, { providerOptions: { temperature: 0.5 } }, { level: "off" })).body;
    expect(off.thinking).toBeUndefined();
    expect(off.temperature).toBe(0.5);
    const thinking = anthropicMessages.build(call(budget, { maxTokens: 1000, providerOptions: { temperature: 0.5 } }, { level: "low" }));
    // The budget comes on top of the answer's own limit; a temperature is refused with thinking on.
    expect(thinking.body).toMatchObject({ max_tokens: 3048, thinking: { type: "enabled", budget_tokens: 2024 } });
    expect(thinking.body.temperature).toBeUndefined();
    expect(thinking.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(anthropicMessages.build(call(budget, {}, { level: "off" })).body.thinking).toEqual({ type: "disabled" });
  });

  it("sends another model's thinking as text, its ids as Anthropic takes them, and leaves out a failed answer", () => {
    const other = { provider: "openai", api: "openai-responses", id: "gpt" } as const;
    const body = anthropicMessages.build(
      call(claude, {
        messages: [
          user("go"),
          answer(other, [{ type: "text", text: "cut off" }], "error"),
          answer(other, [
            { type: "thinking", thinking: "why", thinkingSignature: '{"type":"reasoning"}' },
            { type: "toolCall", id: "call_1|fc_abc+/=", name: "read", arguments: {} },
          ]),
          result("call_1|fc_abc+/=", "done"),
          answer(other, [{ type: "toolCall", id: "orphan", name: "read", arguments: {} }]),
          user("next"),
        ],
      }),
    ).body as { messages: { role: string; content: Record<string, unknown>[] }[] };
    expect(body.messages.map((message) => [message.role, message.content.map((block) => block.type).join(",")])).toEqual([
      ["user", "text"],
      ["assistant", "text,tool_use"],
      ["user", "tool_result"],
      ["assistant", "tool_use"],
      // A call left without a result gets one saying so.
      ["user", "tool_result"],
      ["user", "text"],
    ]);
    expect(body.messages[1]!.content).toEqual([
      { type: "text", text: "why" },
      { type: "tool_use", id: "call_1_fc_abc___", name: "read", input: {} },
    ]);
    expect(body.messages[2]!.content[0]).toMatchObject({ tool_use_id: "call_1_fc_abc___" });
    expect(body.messages[4]!.content[0]).toMatchObject({ tool_use_id: "orphan", content: "No result provided", is_error: true });
  });

  it("reads text, signed and redacted thinking, and tool calls, priced from the catalog", async () => {
    const events = await parse(
      anthropicMessages,
      claude,
      sseBody([
        {
          event: "message_start",
          data: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000 } } },
        },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } } },
        { event: "ping", data: { type: "ping" } },
        { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Hi" } } },
        {
          event: "content_block_start",
          data: { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t1", name: "read", input: {} } },
        },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"pa' } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: 'th":"a"}' } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 3 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]),
    );
    expect(events.find((event) => event.type === "toolcall-end")).toEqual({
      type: "toolcall-end",
      index: 3,
      toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
    });
    expect(last(events)).toMatchObject({
      type: "done",
      message: {
        responseId: "msg_1",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
          { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
          { type: "text", text: "Hi" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
        ],
        usage: { input: 1000, output: 50, cacheRead: 2000, totalTokens: 3050, cost: { input: 0.003, output: 0.00075, cacheRead: 0.0006 } },
      },
    });
  });

  it("leaves out a union at a tool schema's root, which Anthropic refuses, and ignores a trailing [DONE]", async () => {
    const union = {
      $schema: "http://json-schema.org/draft-07/schema#",
      anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object" }],
    };
    const body = anthropicMessages.build(call(claude, { tools: [{ name: "pick", description: "Pick", parameters: union }] })).body as {
      tools: { input_schema: unknown }[];
    };
    expect(body.tools[0]!.input_schema).toEqual({ type: "object", properties: {} });
    const done = await parse(
      anthropicMessages,
      claude,
      sseBody([
        { event: "message_start", data: { type: "message_start", message: { id: "m", usage: {} } } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
        { event: "message_stop", data: { type: "message_stop" } },
        "[DONE]",
      ]),
    );
    expect(last(done)).toMatchObject({ type: "done" });
  });

  it("fails on an error event, overloaded as transient, and on a refusal with its explanation", async () => {
    const overloaded = await parse(
      anthropicMessages,
      claude,
      sseBody([{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }]),
    );
    expect(last(overloaded)).toMatchObject({ type: "error", failure: { kind: "transient" }, message: { errorMessage: "overloaded_error: Overloaded" } });
    const refused = await parse(
      anthropicMessages,
      claude,
      sseBody([
        { event: "message_start", data: { type: "message_start", message: { id: "m", usage: {} } } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { explanation: "Not that." } } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]),
    );
    expect(last(refused)).toMatchObject({ type: "error", failure: { kind: "fatal" }, message: { errorMessage: "Not that." } });
    // A stream cut off midway may pass when asked again.
    const cut = await parse(anthropicMessages, claude, sseBody([{ event: "message_start", data: { type: "message_start", message: { id: "m", usage: {} } } }]));
    expect(last(cut)).toMatchObject({
      type: "error",
      failure: { kind: "transient" },
      message: { errorMessage: "The provider's stream ended before the message did" },
    });
  });
});

describe("openai-responses", () => {
  const gpt = model({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", id: "gpt", reasoning: true });
  const thinking = { kind: "effort" as const, levels: ["off", "low", "high"] as const, values: { off: "none" } };

  it("sends history statelessly: its own reasoning items and message ids back, paired with their calls", () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
    const built = openaiResponses.build(
      call(
        { ...gpt, thinking } as Model,
        {
          system: "Be brief",
          sessionId: "s".repeat(80),
          messages: [
            user("look"),
            answer(gpt, [
              { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
              { type: "text", text: "Reading", textSignature: '{"v":1,"id":"msg_1","phase":"commentary"}' },
              { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a" } },
            ]),
            result("call_1|fc_1", "A"),
          ],
          tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
          providerOptions: { temperature: 0.3 },
        },
        { level: "high", cacheRetention: "long" },
      ),
    );
    expect(built.url).toBe("https://api.openai.com/v1/responses");
    expect(built.headers.authorization).toBe("Bearer sk");
    expect(built.body).toEqual({
      model: "gpt",
      stream: true,
      store: false,
      prompt_cache_key: "s".repeat(64),
      prompt_cache_retention: "24h",
      max_output_tokens: 32_000,
      temperature: 0.3,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }],
      input: [
        { role: "developer", content: "Be brief" },
        { role: "user", content: [{ type: "input_text", text: "look" }] },
        reasoning,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Reading", annotations: [] }],
          status: "completed",
          id: "msg_1",
          phase: "commentary",
        },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
        { type: "function_call_output", call_id: "call_1", output: "A" },
      ],
    });
  });

  it("leaves out what a ChatGPT sign-in refuses, and sends off as the model names it", () => {
    const body = openaiResponses.build(
      call(
        { ...gpt, thinking } as Model,
        { providerOptions: { temperature: 0.3 } },
        { level: "off", auth: { key: "tok", oauth: true }, cacheRetention: "long" },
      ),
    ).body;
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.include).toBeUndefined();
    for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention"]) expect(body[field]).toBeUndefined();
  });

  it("drops another model's item ids, and makes a foreign call's id one the API takes", () => {
    const sibling = { ...gpt, id: "gpt-old" };
    const input = openaiResponses.build(
      call(gpt, {
        messages: [
          user("go"),
          answer(sibling, [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} }]),
          result("call_1|fc_1", "A"),
          answer({ provider: "anthropic", api: "anthropic-messages", id: "claude" }, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: {} }]),
          result("toolu_1", "B"),
        ],
      }),
    ).body.input as Record<string, unknown>[];
    expect(input.filter((item) => item.type === "function_call")).toEqual([
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call", call_id: "toolu_1", name: "read", arguments: "{}" },
    ]);
  });

  it("reads reasoning, text with its signature, and calls, its usage net of the cache", async () => {
    const item = (outputIndex: number, value: Record<string, unknown>, done = false) => ({
      type: done ? "response.output_item.done" : "response.output_item.added",
      output_index: outputIndex,
      item: value,
    });
    const events = await parse(
      openaiResponses,
      gpt,
      sseBody([
        { type: "response.created", response: { id: "resp_1" } },
        item(0, { type: "reasoning", id: "rs_1" }),
        { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Think" },
        item(0, { type: "reasoning", id: "rs_1", summary: [{ text: "Think" }] }, true),
        item(1, { type: "message", id: "msg_1" }),
        { type: "response.output_text.delta", output_index: 1, delta: "Hi" },
        item(1, { type: "message", id: "msg_1", phase: "final_answer", content: [{ type: "output_text", text: "Hi" }] }, true),
        item(2, { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" }),
        { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":' },
        item(2, { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' }, true),
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            output: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }],
            usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 5 } },
          },
        },
      ]),
    );
    expect(events.filter((event) => event.type === "toolcall-delta").map((event) => (event as { delta: string }).delta)).toEqual(['{"path":', '"a"}']);
    expect(last(events)).toMatchObject({
      type: "done",
      message: {
        responseId: "resp_1",
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking: "Think",
            thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [{ text: "Think" }], encrypted_content: "enc" }),
          },
          { type: "text", text: "Hi", textSignature: '{"v":1,"id":"msg_1","phase":"final_answer"}' },
          { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a" } },
        ],
        usage: { input: 200, cacheRead: 800, output: 20, reasoning: 5, totalTokens: 1020 },
      },
    });
  });

  it("ends an answer cut at its output limit as length, and fails a failed response with its code", async () => {
    const incomplete = await parse(
      openaiResponses,
      gpt,
      sseBody([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }]),
    );
    expect(last(incomplete)).toMatchObject({ type: "done", message: { stopReason: "length" } });
    const failed = await parse(
      openaiResponses,
      gpt,
      sseBody([{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The server had an error" } } }]),
    );
    expect(last(failed)).toMatchObject({ type: "error", failure: { kind: "transient" }, message: { errorMessage: "server_error: The server had an error" } });
    const unfinished = await parse(
      openaiResponses,
      gpt,
      sseBody([
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c", name: "read" } },
        { type: "response.completed", response: { status: "completed" } },
      ]),
    );
    expect(last(unfinished)).toMatchObject({ type: "error", message: { errorMessage: expect.stringContaining("unfinished tool call: read") } });
    const trailing = await parse(openaiResponses, gpt, sseBody([{ type: "response.completed", response: { status: "completed" } }, "[DONE]"]));
    expect(last(trailing)).toMatchObject({ type: "done", message: { stopReason: "stop" } });
  });
});

describe("openai-completions", () => {
  it("sends a reasoning model's system prompt as a developer message, results' images after them, and OpenAI's limits", () => {
    const o = model({ provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: true, thinking: { kind: "effort", levels: ["low", "high"] } });
    const built = openaiCompletions.build(
      call(
        o,
        {
          system: "Be brief",
          sessionId: "s1",
          messages: [
            user("look"),
            answer(o, [
              { type: "text", text: "ok" },
              { type: "toolCall", id: "t1", name: "read", arguments: {} },
            ]),
            result("t1", "A", true),
          ],
        },
        { level: "high" },
      ),
    );
    expect(built.body).toEqual({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: 32_000,
      prompt_cache_key: "s1",
      reasoning_effort: "high",
      messages: [
        { role: "developer", content: "Be brief" },
        { role: "user", content: "look" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", content: "A", tool_call_id: "t1" },
        {
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          ],
        },
      ],
    });
  });

  it("speaks DeepSeek's thinking switch and takes its reasoning back as reasoning_content", () => {
    const deepseek = model({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      id: "deepseek-v4",
      reasoning: true,
      thinking: { kind: "effort", levels: ["low", "high"] },
    });
    const body = openaiCompletions.build(
      call(deepseek, { messages: [user("q"), answer(deepseek, [{ type: "text", text: "a" }], "stop"), user("again")] }, { level: "high" }),
    ).body;
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 32_000 });
    expect(body.store).toBeUndefined();
    expect((body.messages as Record<string, unknown>[])[1]).toEqual({ role: "assistant", content: "a", reasoning_content: "" });
  });

  it("sends reasoning_content back to DeepSeek and Kimi K2.6 behind OpenRouter", () => {
    for (const id of ["deepseek/deepseek-v4-pro", "~deepseek/deepseek-v4.1-flash", "moonshotai/kimi-k2.6"]) {
      const routed = model({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", id, reasoning: true });
      const messages = openaiCompletions.build(
        call(routed, { messages: [user("q"), answer(routed, [{ type: "toolCall", id: "t", name: "read", arguments: {} }]), result("t", "A")] }),
      ).body.messages as Record<string, unknown>[];
      expect(messages[1]).toMatchObject({ role: "assistant", reasoning_content: "" });
    }
  });

  it("speaks OpenRouter's reasoning object, and marks an Anthropic model's cache breakpoints", () => {
    const routed = model({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      id: "anthropic/claude",
      reasoning: true,
      thinking: { kind: "toggle", levels: ["off", "high"] },
    });
    const built = openaiCompletions.build(
      call(routed, { system: "Be brief", sessionId: "s1", tools: [{ name: "read", description: "Read", parameters: {} }] }, { level: "high" }),
    );
    expect(built.headers["x-session-id"]).toBe("s1");
    expect(built.body).toMatchObject({
      reasoning: { enabled: true },
      messages: [
        { role: "developer", content: [{ type: "text", text: "Be brief", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      ],
      tools: [{ type: "function", cache_control: { type: "ephemeral" } }],
    });
  });

  it("takes a server's compat over what it detects", () => {
    const local = model({
      baseUrl: "http://localhost:11434/v1",
      reasoning: true,
      thinking: { kind: "effort", levels: ["low"] },
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsStore: false },
    });
    const body = openaiCompletions.build(call(local, { system: "s" }, { level: "low" })).body;
    expect(body).toMatchObject({
      max_tokens: 32_000,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body.store).toBeUndefined();
  });

  it("sends back the reasoning field and details a model streamed, as it streamed them", () => {
    const routed = model({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", id: "openai/gpt" });
    const details = [{ type: "reasoning.encrypted", data: "enc", id: "r1" }];
    const messages = openaiCompletions.build(
      call(routed, {
        messages: [
          user("q"),
          answer(
            routed,
            [
              { type: "thinking", thinking: "why", thinkingSignature: JSON.stringify(details) },
              { type: "text", text: "a" },
            ],
            "stop",
          ),
          user("q2"),
          answer(
            routed,
            [
              { type: "thinking", thinking: "how", thinkingSignature: "reasoning" },
              { type: "text", text: "b" },
            ],
            "stop",
          ),
        ],
      }),
    ).body.messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({ role: "assistant", content: "a", reasoning_details: details });
    expect(messages[3]).toEqual({ role: "assistant", content: "b", reasoning: "how" });
  });

  it("reads reasoning, text, and calls split across chunks, and usage net of the cache", async () => {
    const events = await parse(
      openaiCompletions,
      model(),
      sseBody([
        { id: "c1", choices: [{ delta: { reasoning: "hm" } }] },
        { id: "c1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a" }] } }] },
        { id: "c1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "b", signature: "s" }] } }] },
        { id: "c1", choices: [{ delta: { content: "Hi" } }] },
        { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read", arguments: '{"path"' } }] } }] },
        { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] } }] },
        { id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { id: "c1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } } },
        "[DONE]",
      ]),
    );
    expect(last(events)).toMatchObject({
      type: "done",
      message: {
        responseId: "c1",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "hm", thinkingSignature: JSON.stringify([{ type: "reasoning.text", text: "ab", signature: "s" }]) },
          { type: "text", text: "Hi" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
        ],
        usage: { input: 40, cacheRead: 60, output: 10, totalTokens: 110 },
      },
    });
  });

  it("fails mid-answer as the provider says, by the status it names", async () => {
    const failed = await parse(
      openaiCompletions,
      model(),
      sseBody([{ choices: [{ delta: { content: "half" } }] }, { error: { code: 502, message: "Provider returned error" } }]),
    );
    expect(last(failed)).toMatchObject({
      type: "error",
      failure: { kind: "transient" },
      message: { content: [{ type: "text", text: "half" }], errorMessage: "502: Provider returned error" },
    });
  });

  it("fails a stream that never finished, and one that says why it stopped", async () => {
    expect(last(await parse(openaiCompletions, model(), sseBody([{ choices: [{ delta: { content: "half" } }] }])))).toMatchObject({
      type: "error",
      failure: { kind: "transient" },
      message: { content: [{ type: "text", text: "half" }], errorMessage: "The provider's stream ended without a finish reason" },
    });
    expect(last(await parse(openaiCompletions, model(), sseBody([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }, "[DONE]"])))).toMatchObject({
      type: "error",
      message: { errorMessage: "The provider stopped: content_filter" },
    });
  });
});

describe("failures", () => {
  const classify = (message: string, status?: number, retryAfterMs?: number) =>
    classifyFailure(
      status === undefined && retryAfterMs === undefined
        ? new Error(message)
        : new ProviderError(message, { ...(status === undefined ? {} : { status }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }),
      message,
    );

  it("tells a caller whether asking again can help", () => {
    expect(classify("529 overloaded_error: Overloaded", 529)).toEqual({ kind: "transient" });
    expect(classify("overloaded_error: Overloaded")).toEqual({ kind: "transient" });
    expect(classify("fetch failed (ECONNREFUSED)")).toEqual({ kind: "transient" });
    expect(classify("read ECONNRESET")).toEqual({ kind: "transient" });
    expect(classify("terminated")).toEqual({ kind: "transient" });
    expect(classify("429 Too Many Requests", 429)).toEqual({ kind: "rate-limit" });
    expect(classify("429 rate_limit_error: Rate limit reached", 429, 120_000)).toEqual({ kind: "rate-limit", retryAfterMs: 120_000 });
    expect(classify("400 prompt is too long: 210000 tokens > 200000 maximum", 400)).toEqual({ kind: "overflow" });
    expect(classify("context_length_exceeded: Your input exceeds the context window of this model")).toEqual({ kind: "overflow" });
    expect(classify("413 request_too_large", 413)).toEqual({ kind: "overflow" });
    expect(classify("401 Invalid API key", 401)).toEqual({ kind: "fatal" });
    expect(classify("429 insufficient_quota: You exceeded your current quota", 429)).toEqual({ kind: "fatal" });
    expect(classify("429 Request too large for gpt-4o on tokens per min (TPM)", 429)).toEqual({ kind: "fatal" });
    expect(classify("400 invalid_request_error: request body of 5500123 bytes is too large", 400)).toEqual({ kind: "fatal" });
    expect(classify("The provider stopped: content_filter")).toEqual({ kind: "fatal" });
    // pi's retryable wordings: a server too busy now, and a gateway's provider failing without a status.
    expect(classify("server_busy: The server is busy")).toEqual({ kind: "transient" });
    expect(classify("The model is at capacity")).toEqual({ kind: "transient" });
    expect(classify("Provider returned error")).toEqual({ kind: "transient" });
  });

  it("keeps what the provider behind a gateway said, so an overflow there is one", () => {
    const raw = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } });
    const message = `400 ${errorText(JSON.stringify({ error: { code: 400, message: "Provider returned error", metadata: { raw } } }))}`;
    expect(message).toContain("prompt is too long");
    expect(classify(message, 400)).toEqual({ kind: "overflow" });
  });

  it("fails an answer cut off at its limit having said nothing, its input filling the context window, as an overflow", () => {
    const end = (input: number, output: number, text = "") => {
      const events: StreamEvent[] = [];
      const out = new Output(model({ contextWindow: 1000 }), (more) => events.push(...more));
      out.start();
      if (text !== "") out.text(out.addText(), text);
      out.usage = { ...emptyUsage, input, output };
      out.stopReason = "length";
      out.finish();
      return last(events);
    };
    expect(end(1000, 0)).toMatchObject({ type: "error", message: { stopReason: "error" }, failure: { kind: "overflow" } });
    // An answer cut off at its output limit is still an answer.
    expect(end(500, 400, "half an answer")).toMatchObject({ type: "done", message: { stopReason: "length" } });
  });
});

describe("sse", () => {
  it("reads events split anywhere, in any line ending, skipping comments", async () => {
    const text = ': comment\r\nevent: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\ndata: two\r\rdata: three\n\ndata: last';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 3) controller.enqueue(bytes.slice(at, at + 3));
        controller.close();
      },
    });
    const events = [];
    for await (const event of sse(body)) events.push(event);
    expect(events).toEqual([
      { event: "a", data: '{"x":\n1}' },
      { event: undefined, data: "two" },
      { event: undefined, data: "three" },
      { event: undefined, data: "last" },
    ]);
  });
});
