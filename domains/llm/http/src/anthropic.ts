import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@lemma/llm";
import type { SseEvent } from "./http.ts";
import { levelValue, THINKING_BUDGETS } from "./model.ts";
import { priced } from "./output.ts";
import type { Output } from "./output.ts";
import { history, maxTokens, passedOn, sanitize } from "./transform.ts";
import { json } from "./wire.ts";
import type { Wire, WireCall } from "./wire.ts";

/** Anthropic's Messages API, as Anthropic and the services speaking its protocol (OpenCode's) serve it. */

/** Tokens always left for the answer when a thinking budget shares the response's limit. */
const ANSWER_ROOM = 1024;
const INTERLEAVED_THINKING = "interleaved-thinking-2025-05-14";

/** Anthropic's tool call ids are `[a-zA-Z0-9_-]{1,64}`. */
const normalizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

type Block = Record<string, unknown>;

const image = (block: ImageContent): Block => ({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });

/** A tool result's content: its text alone as a string, or blocks with its images. */
function resultContent(content: readonly (TextContent | ImageContent)[]): string | Block[] {
  if (!content.some((block) => block.type === "image")) return sanitize(content.map((block) => (block as TextContent).text).join("\n"));
  const blocks = content.map((block) => (block.type === "text" ? { type: "text", text: sanitize(block.text) } : image(block)));
  return blocks.some((block) => block.type === "text") ? blocks : [{ type: "text", text: "(see attached image)" }, ...blocks];
}

function assistantBlocks(message: AssistantMessage): Block[] {
  const blocks: Block[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim() !== "") blocks.push({ type: "text", text: sanitize(block.text) });
    } else if (block.type === "thinking") {
      if (block.redacted === true) blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
      else if (block.thinkingSignature !== undefined && block.thinkingSignature.trim() !== "") {
        blocks.push({ type: "thinking", thinking: sanitize(block.thinking), signature: block.thinkingSignature });
      }
      // Unsigned thinking (a stream cut off before its signature) cannot be sent back as thinking: as text it can.
      else if (block.thinking.trim() !== "") blocks.push({ type: "text", text: sanitize(block.thinking) });
    } else blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
  }
  return blocks;
}

function messages(call: WireCall, cache: Block | undefined): Block[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const results: ToolResultMessage[] = [];
  const flush = () => {
    if (results.length === 0) return;
    out.push({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: resultContent(result.content),
        is_error: result.isError,
      })),
    });
    results.length = 0;
  };
  for (const message of history(call.request, call.model, normalizeId)) {
    if (message.role === "toolResult") {
      results.push(message);
      continue;
    }
    flush();
    if (message.role === "user") {
      const content = message.content.flatMap((block) =>
        block.type === "image" ? [image(block)] : block.text.trim() === "" ? [] : [{ type: "text", text: sanitize(block.text) }],
      );
      if (content.length > 0) out.push({ role: "user", content });
    } else {
      const content = assistantBlocks(message);
      if (content.length > 0) out.push({ role: "assistant", content });
    }
  }
  flush();
  // The history so far is cached: the breakpoint goes on the last block of the last user turn.
  const last = out.at(-1);
  if (cache !== undefined && last?.role === "user" && last.content.length > 0) {
    last.content[last.content.length - 1] = { ...last.content[last.content.length - 1], cache_control: cache };
  }
  return out;
}

function build(call: WireCall) {
  const { model, request, level } = call;
  const options = passedOn(request.providerOptions);
  const cache = { type: "ephemeral", ...(call.cacheRetention === "long" ? { ttl: "1h" } : {}) };
  let limit = maxTokens(model, request);
  const body: Record<string, unknown> = { model: model.id, stream: true };
  const betas: string[] = [];
  const thinking = model.thinking;
  const on = level !== undefined && level !== "off";
  if (thinking !== undefined && level !== undefined) {
    if (thinking.kind === "effort") {
      // Adaptive thinking: the model decides how much, at the effort asked. Off, nothing is sent: a model that always
      // thinks would refuse it turned off.
      if (on) {
        body.thinking = { type: "adaptive", display: "summarized" };
        body.output_config = { effort: levelValue(model, level) };
      }
    } else if (on) {
      // The budget comes out of the response's limit: a request's own limit is for the answer, so it grows by it.
      const budget = THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
      if (request.maxTokens !== undefined) limit = maxTokens(model, request, Math.min(request.maxTokens + budget, model.maxTokens));
      body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(budget, limit - ANSWER_ROOM)) };
      betas.push(INTERLEAVED_THINKING);
    } else body.thinking = { type: "disabled" };
  }
  body.max_tokens = limit;
  if (request.system !== undefined && request.system !== "") body.system = [{ type: "text", text: sanitize(request.system), cache_control: cache }];
  body.messages = messages(call, cache);
  const tools = request.tools ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((tool, index) => {
      // A schema's own identity (an MCP server's tool may carry one) is not part of the input it describes, and
      // Anthropic refuses a union at the root: the union is left out, its object's own properties kept.
      const { $schema: _schema, $id: _id, anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...schema } = tool.parameters;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: { ...schema, type: "object", properties: schema.properties ?? {} },
        ...(index === tools.length - 1 ? { cache_control: cache } : {}),
      };
    });
  }
  // A temperature is refused with thinking on, and by models that set their own.
  if (options.temperature !== undefined && !on && model.temperature !== false) body.temperature = options.temperature;
  const userId = options.metadata?.user_id;
  if (typeof userId === "string") body.metadata = { user_id: userId };
  return {
    url: `${model.baseUrl}/v1/messages`,
    body,
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
      "x-api-key": call.auth.key,
      ...(betas.length === 0 ? {} : { "anthropic-beta": betas.join(",") }),
    },
  };
}

const STOP: Readonly<Record<string, AssistantMessage["stopReason"]>> = {
  end_turn: "stop",
  pause_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "toolUse",
};

/** Why Anthropic stopped, where it is an error: a refusal says why when it can. */
function stopError(reason: string, details: { explanation?: unknown } | undefined): string {
  if (reason === "refusal") return typeof details?.explanation === "string" ? details.explanation : "The model refused to complete the request";
  return `The provider stopped: ${reason}`;
}

interface Usage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly output_tokens_details?: { readonly thinking_tokens?: number | null } | null;
}

async function read(events: AsyncIterable<SseEvent>, out: Output, call: WireCall, raw: (data: unknown) => void) {
  /** Anthropic's block index to the message's. */
  const blocks = new Map<number, number>();
  const counts: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number } = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const count = (usage: Usage | undefined) => {
    if (usage === undefined) return;
    // A field left out (or null, as proxies send it) keeps what an earlier event said.
    if (usage.input_tokens != null) counts.input = usage.input_tokens;
    if (usage.output_tokens != null) counts.output = usage.output_tokens;
    if (usage.cache_read_input_tokens != null) counts.cacheRead = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) counts.cacheWrite = usage.cache_creation_input_tokens;
    if (usage.output_tokens_details?.thinking_tokens != null) counts.reasoning = usage.output_tokens_details.thinking_tokens;
    out.usage = priced(call.model, counts);
  };
  let stopped = false;
  for await (const event of events) {
    // A gateway may end the stream as OpenAI's does.
    if (event.event === "ping" || event.data === "[DONE]") continue;
    const data = json(event) as { type?: string; [key: string]: unknown };
    raw(data);
    switch (data.type) {
      case "error": {
        const error = data.error as { type?: string; message?: string } | undefined;
        throw new Error(`${error?.type ?? "error"}: ${error?.message ?? event.data}`);
      }
      case "message_start": {
        const message = data.message as { id?: string; usage?: Usage };
        if (message.id !== undefined) out.responseId = message.id;
        count(message.usage);
        break;
      }
      case "content_block_start": {
        const block = data.content_block as { type: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; name?: string };
        const index = data.index as number;
        if (block.type === "text") {
          blocks.set(index, out.addText());
          out.text(blocks.get(index)!, block.text ?? "");
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          const at = out.addThinking();
          blocks.set(index, at);
          const target = out.content[at];
          if (target?.type === "thinking" && block.type === "redacted_thinking") {
            target.thinking = "[Reasoning redacted]";
            target.thinkingSignature = block.data ?? "";
            target.redacted = true;
          } else {
            out.thinking(at, block.thinking ?? "");
            if (target?.type === "thinking" && block.signature) target.thinkingSignature = block.signature;
          }
        } else if (block.type === "tool_use") blocks.set(index, out.addToolCall(block.id ?? "", block.name ?? ""));
        break;
      }
      case "content_block_delta": {
        const at = blocks.get(data.index as number);
        const delta = data.delta as { type: string; text?: string; thinking?: string; partial_json?: string; signature?: string };
        if (at === undefined) break;
        if (delta.type === "text_delta") out.text(at, delta.text ?? "");
        else if (delta.type === "thinking_delta") out.thinking(at, delta.thinking ?? "");
        else if (delta.type === "input_json_delta") out.toolCall(at, delta.partial_json ?? "");
        else if (delta.type === "signature_delta") {
          const target = out.content[at];
          if (target?.type === "thinking") target.thinkingSignature = (target.thinkingSignature ?? "") + (delta.signature ?? "");
        }
        break;
      }
      case "content_block_stop": {
        const at = blocks.get(data.index as number);
        if (at !== undefined && out.open(at)) out.endToolCall(at);
        break;
      }
      case "message_delta": {
        const delta = data.delta as { stop_reason?: string | null; stop_details?: { explanation?: unknown } };
        count(data.usage as Usage | undefined);
        const reason = delta.stop_reason;
        if (typeof reason === "string") {
          out.stopReason = STOP[reason] ?? "error";
          if (STOP[reason] === undefined) out.errorMessage = stopError(reason, delta.stop_details);
        }
        break;
      }
      case "message_stop":
        stopped = true;
        break;
    }
  }
  if (!stopped && out.stopReason === undefined) throw new Error("The provider's stream ended before the message did");
}

export const anthropicMessages: Wire = { build, read };
