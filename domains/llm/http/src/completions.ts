import type { AssistantMessage, ImageContent, TextContent } from "@lemma/llm";
import { ProviderError, withUpstream } from "./http.ts";
import type { SseEvent } from "./http.ts";
import type { Model } from "./model.ts";
import { stopFailure } from "./failure.ts";
import { priced } from "./output.ts";
import type { Output } from "./output.ts";
import { history, maxTokens, passedOn, sanitize, shortHash, textOf } from "./transform.ts";
import { json, merged } from "./wire.ts";
import type { Wire, WireCall } from "./wire.ts";

/**
 * OpenAI's Chat Completions API, as OpenAI and the many servers copying it speak it (OpenRouter, OpenCode, local
 * servers). They differ, so a model's `compat` (its provider's config, field by field) says how, over what this
 * plugin detects from where it is.
 */

/** How a server takes thinking: OpenAI's `reasoning_effort`, OpenRouter's `reasoning` object, DeepSeek's `thinking` switch. */
export type ThinkingFormat = "openai" | "openrouter" | "deepseek";

/** What a Chat Completions server takes, by pi's compat names, which configs written for it use. */
export interface Compat {
  /** The system prompt goes as a `developer` message to a reasoning model (`supportsDeveloperRole`). */
  readonly developerRole: boolean;
  /** It takes `store: false` (`supportsStore`). */
  readonly store: boolean;
  /** It takes a reasoning effort (`supportsReasoningEffort`). */
  readonly reasoningEffort: boolean;
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly thinkingFormat: ThinkingFormat;
  /** Every assistant message of a reasoning model carries `reasoning_content` (`requiresReasoningContentOnAssistantMessages`). */
  readonly reasoningContent: boolean;
  /** Anthropic's `cache_control` breakpoints, for its models behind OpenRouter (`cacheControlFormat: "anthropic"`). */
  readonly cacheControl: boolean;
  /** It reports usage when asked with `stream_options` (`supportsUsageInStreaming`). */
  readonly usageInStreaming: boolean;
}

const isOpenRouter = (model: Pick<Model, "provider" | "baseUrl">) => model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
const isOpenCode = (model: Pick<Model, "provider" | "baseUrl">) =>
  model.provider === "opencode" || model.provider === "opencode-go" || model.baseUrl.includes("opencode.ai");
const isDeepSeek = (model: Pick<Model, "provider" | "baseUrl" | "id">) =>
  model.provider === "deepseek" || model.baseUrl.toLowerCase().includes("deepseek.com") || (isOpenCode(model) && model.id.startsWith("deepseek"));

/** How a server at `baseUrl` of `provider` takes `id`'s thinking: as its `compat.thinkingFormat` says, else as detected. */
export function thinkingFormat(model: Pick<Model, "provider" | "baseUrl" | "id" | "compat">): ThinkingFormat {
  const given = model.compat?.thinkingFormat;
  if (given === "openai" || given === "openrouter" || given === "deepseek") return given;
  return isOpenRouter(model) ? "openrouter" : isDeepSeek(model) ? "deepseek" : "openai";
}

/** What `model`'s server takes: detected from where it is, then its `compat` field by field. */
export function compatOf(model: Model): Compat {
  const openrouter = isOpenRouter(model);
  const deepseek = isDeepSeek(model);
  const nonstandard = openrouter || isOpenCode(model) || deepseek;
  const detected: Compat = {
    developerRole: openrouter ? model.id.startsWith("anthropic/") || model.id.startsWith("openai/") : !nonstandard,
    store: !nonstandard,
    reasoningEffort: true,
    maxTokensField: isOpenCode(model) || deepseek ? "max_tokens" : "max_completion_tokens",
    thinkingFormat: thinkingFormat(model),
    // DeepSeek's thinking models, and Kimi K2.6, refuse an assistant message without it, behind OpenRouter as well.
    reasoningContent: deepseek || (openrouter && /^~?deepseek\/|^moonshotai\/kimi-k2\.6/.test(model.id)),
    cacheControl: openrouter && model.id.startsWith("anthropic/"),
    usageInStreaming: true,
  };
  const given = model.compat ?? {};
  const flag = (name: string, fallback: boolean) => (typeof given[name] === "boolean" ? (given[name] as boolean) : fallback);
  return {
    developerRole: flag("supportsDeveloperRole", detected.developerRole),
    store: flag("supportsStore", detected.store),
    reasoningEffort: flag("supportsReasoningEffort", detected.reasoningEffort),
    maxTokensField: given.maxTokensField === "max_tokens" || given.maxTokensField === "max_completion_tokens" ? given.maxTokensField : detected.maxTokensField,
    thinkingFormat: detected.thinkingFormat,
    reasoningContent: flag("requiresReasoningContentOnAssistantMessages", detected.reasoningContent),
    cacheControl: given.cacheControlFormat === undefined ? detected.cacheControl : given.cacheControlFormat === "anthropic",
    usageInStreaming: flag("supportsUsageInStreaming", detected.usageInStreaming),
  };
}

/** The fields a server streams reasoning in; a block's signature names the one it came in, to send it back in. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** A reasoning detail (OpenRouter's), as it streams: text and summaries in pieces, encrypted parts whole. */
interface Detail {
  type: string;
  text?: string | undefined;
  summary?: string | undefined;
  data?: string | undefined;
  signature?: string | null | undefined;
  id?: string | null | undefined;
  format?: string | undefined;
  index?: number | undefined;
}

const isDetail = (value: unknown): value is Detail => {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Detail;
  if (detail.type === "reasoning.text") return typeof detail.text === "string";
  if (detail.type === "reasoning.summary") return typeof detail.summary === "string";
  if (detail.type === "reasoning.encrypted") return typeof detail.data === "string";
  return false;
};

/** A thinking block's reasoning details, when its signature holds them. */
function detailsOf(signature: string | undefined): Detail[] | undefined {
  if (signature === undefined || !signature.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(signature) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isDetail) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Ids from the Responses API (`<call_id>|<item_id>`, hundreds of characters) as ids a Chat Completions server takes. */
function normalizeId(model: Model) {
  return (id: string) => {
    const bar = id.indexOf("|");
    if (bar === -1) return model.provider === "openai" ? id.slice(0, 40) : id;
    const callId = id.slice(0, bar).replace(/[^a-zA-Z0-9_-]/g, "_");
    const itemId = id.slice(bar + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
    const combined = itemId === "" ? callId : `${callId}_${itemId}`;
    if (combined.length <= 40) return combined;
    const hash = shortHash(id).slice(0, 8);
    return `${callId.slice(0, Math.max(1, 40 - hash.length - 1))}_${hash}`;
  };
}

const imagePart = (image: ImageContent) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });

function assistant(message: AssistantMessage, model: Model, compat: Compat): Record<string, unknown> | undefined {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text" && block.text.trim() !== "")
    .map((block) => sanitize(block.text))
    .join("");
  const thinking = message.content.filter((block) => block.type === "thinking");
  const calls = message.content.filter((block) => block.type === "toolCall");
  // Content as a string: an array of parts is not the standard, and some models answer by mirroring it.
  const out: Record<string, unknown> = { role: "assistant", content: text === "" ? null : text };
  const details = thinking.map((block) => detailsOf(block.thinkingSignature)).find((found) => found !== undefined);
  const spoken = thinking.filter((block) => block.thinking.trim() !== "");
  if (details !== undefined) out.reasoning_details = details;
  else if (spoken.length > 0) {
    const field = REASONING_FIELDS.find((name) => name === spoken[0]!.thinkingSignature);
    if (field !== undefined) out[field] = spoken.map((block) => block.thinking).join("\n");
  }
  if (calls.length > 0) {
    out.tool_calls = calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
  }
  if (compat.reasoningContent && model.reasoning && out.reasoning_content === undefined) out.reasoning_content = "";
  // A message with neither content nor calls is refused: an answer that produced nothing goes unsent.
  return out.content === null && calls.length === 0 ? undefined : out;
}

function messages(call: WireCall, compat: Compat): Record<string, unknown>[] {
  const { model } = call;
  const out: Record<string, unknown>[] = [];
  if (call.request.system !== undefined && call.request.system !== "") {
    out.push({ role: model.reasoning && compat.developerRole ? "developer" : "system", content: sanitize(call.request.system) });
  }
  const prepared = history(call.request, model, normalizeId(model));
  for (let i = 0; i < prepared.length; i++) {
    const message = prepared[i]!;
    if (message.role === "user") {
      const parts = message.content.filter((block) => block.type !== "text" || block.text !== "");
      if (parts.length === 0) continue;
      const textOnly = parts.every((block) => block.type === "text");
      out.push({
        role: "user",
        content: textOnly
          ? sanitize(textOf(parts))
          : parts.map((block) => (block.type === "text" ? { type: "text", text: sanitize(block.text) } : imagePart(block))),
      });
    } else if (message.role === "assistant") {
      const converted = assistant(message, model, compat);
      if (converted !== undefined) out.push(converted);
    } else {
      // A run of tool results; their images, which a tool message cannot carry, follow them as a user message.
      const images: Record<string, unknown>[] = [];
      for (; i < prepared.length && prepared[i]!.role === "toolResult"; i++) {
        const result = prepared[i] as Extract<(typeof prepared)[number], { role: "toolResult" }>;
        const text = textOf(result.content);
        const pictures = result.content.filter((block): block is ImageContent => block.type === "image");
        out.push({
          role: "tool",
          content: sanitize(text || (pictures.length > 0 ? "(see attached image)" : "(no tool output)")),
          tool_call_id: result.toolCallId,
        });
        if (model.input.includes("image")) images.push(...pictures.map(imagePart));
      }
      i--;
      if (images.length > 0) out.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images] });
    }
  }
  return out;
}

/** Anthropic's cache breakpoints, for its models behind OpenRouter: the system prompt, the last tool, the last message. */
function withCacheControl(messages: Record<string, unknown>[], tools: Record<string, unknown>[] | undefined, cache: Record<string, unknown>) {
  const mark = (message: Record<string, unknown> | undefined) => {
    if (message === undefined) return false;
    const content = message.content;
    if (typeof content === "string" && content !== "") {
      message.content = [{ type: "text", text: content, cache_control: cache }];
      return true;
    }
    if (!Array.isArray(content)) return false;
    for (let at = content.length - 1; at >= 0; at--) {
      const part = content[at] as Record<string, unknown>;
      if (part.type !== "text") continue;
      content[at] = { ...part, cache_control: cache };
      return true;
    }
    return false;
  };
  mark(messages.find((message) => message.role === "system" || message.role === "developer"));
  const lastTool = tools?.at(-1);
  if (lastTool !== undefined) lastTool.cache_control = cache;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role !== "system" && messages[i]!.role !== "developer" && mark(messages[i])) break;
}

function build(call: WireCall) {
  const { model, request, think, auth } = call;
  const compat = compatOf(model);
  const options = passedOn(request.providerOptions);
  const body: Record<string, unknown> = { model: model.id, messages: messages(call, compat), stream: true };
  if (compat.usageInStreaming) body.stream_options = { include_usage: true };
  if (compat.store) body.store = false;
  body[compat.maxTokensField] = maxTokens(model, request);
  if (options.temperature !== undefined && model.temperature !== false) body.temperature = options.temperature;
  if (request.sessionId !== undefined && model.baseUrl.includes("api.openai.com")) body.prompt_cache_key = Array.from(request.sessionId).slice(0, 64).join("");
  const tools = (request.tools ?? []).map((tool): Record<string, unknown> => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  if (tools.length > 0) body.tools = tools;
  if (compat.cacheControl) {
    withCacheControl(body.messages as Record<string, unknown>[], tools, { type: "ephemeral", ...(call.cacheRetention === "long" ? { ttl: "1h" } : {}) });
  }
  const thinking = model.thinking;
  if (thinking !== undefined && think !== undefined) {
    const { on, effort: value } = think;
    if (compat.thinkingFormat === "openrouter") {
      // Off goes as the model names it, else as the effort OpenRouter documents for no reasoning, `none`.
      if (on) body.reasoning = thinking.kind === "toggle" ? { enabled: true } : { effort: value };
      else body.reasoning = { effort: value ?? "none" };
    } else if (compat.thinkingFormat === "deepseek") {
      body.thinking = { type: on ? "enabled" : "disabled" };
      if (on && thinking.kind === "effort" && compat.reasoningEffort) body.reasoning_effort = value;
    } else if (thinking.kind === "effort" && compat.reasoningEffort && value !== undefined) body.reasoning_effort = value;
  }
  return {
    url: `${model.baseUrl}/chat/completions`,
    body: merged(body, options.samplingParams),
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${auth.key}`,
      // OpenRouter keeps a conversation on the provider holding its prompt cache.
      ...(isOpenRouter(model) && request.sessionId !== undefined ? { "x-session-id": request.sessionId } : {}),
    },
  };
}

const STOP: Readonly<Record<string, AssistantMessage["stopReason"]>> = {
  stop: "stop",
  end: "stop",
  length: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
};

interface Usage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly cached_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number; readonly cache_write_tokens?: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

interface Chunk {
  readonly id?: string;
  readonly usage?: Usage | null;
  readonly error?: unknown;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly usage?: Usage;
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: unknown;
      readonly reasoning?: unknown;
      readonly reasoning_text?: unknown;
      readonly reasoning_details?: unknown;
      readonly tool_calls?: readonly {
        readonly index?: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
}

async function read(events: AsyncIterable<SseEvent>, out: Output, call: WireCall, raw: (data: unknown) => void) {
  const { model } = call;
  let text: number | undefined;
  let thinking: number | undefined;
  let details: Detail[] | undefined;
  let finished = false;
  const calls = new Map<number | string, number>();
  out.settle(() => {
    const block = thinking === undefined ? undefined : out.content[thinking];
    if (details !== undefined && block?.type === "thinking") block.thinkingSignature = JSON.stringify(details);
  });
  const count = (usage: Usage) => {
    // Servers put the cache's hits in different places: OpenAI's details, DeepSeek's own field, Kimi's top level.
    const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
    const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
    out.usage = priced(model, {
      input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead - cacheWrite),
      output: usage.completion_tokens ?? 0,
      cacheRead,
      cacheWrite,
      reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    });
  };
  for await (const event of events) {
    if (event.data === "[DONE]") break;
    const chunk = json(event) as Chunk;
    raw(chunk);
    if (chunk.error !== undefined && chunk.error !== null) {
      const error = chunk.error as { message?: unknown; code?: unknown };
      const message = withUpstream(
        typeof error.message === "string" ? (error.code === undefined ? error.message : `${String(error.code)}: ${error.message}`) : JSON.stringify(error),
        error,
      );
      // OpenRouter names a failure mid-answer by the HTTP status it would have answered with (a 502, a 429).
      const status = typeof error.code === "number" && error.code >= 400 && error.code < 600 ? error.code : undefined;
      throw status === undefined ? new Error(message) : new ProviderError(message, { status });
    }
    out.responseId ??= chunk.id;
    if (chunk.usage) count(chunk.usage);
    const choice = chunk.choices?.[0];
    if (choice === undefined) continue;
    if (!chunk.usage && choice.usage) count(choice.usage);
    const delta = choice.delta;
    if (delta !== undefined) {
      // The first field a server streams reasoning in, as some send the same text in two.
      const field = REASONING_FIELDS.find((name) => typeof delta[name] === "string" && delta[name] !== "");
      if (field !== undefined) {
        if (thinking === undefined) {
          thinking = out.addThinking();
          const block = out.content[thinking];
          // OpenCode Go streams it as `reasoning` but takes it back only as `reasoning_content`.
          if (block?.type === "thinking") block.thinkingSignature = model.provider === "opencode-go" && field === "reasoning" ? "reasoning_content" : field;
        }
        out.thinking(thinking, delta[field] as string);
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        text ??= out.addText();
        out.text(text, delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const key = part.index ?? part.id ?? calls.size;
        let at = calls.get(key);
        if (at === undefined) {
          at = out.addToolCall(part.id ?? "", part.function?.name ?? "");
          calls.set(key, at);
        }
        const block = out.content[at];
        if (block?.type === "toolCall") {
          if (block.id === "" && part.id) block.id = part.id;
          if (block.name === "" && part.function?.name) block.name = part.function.name;
        }
        out.toolCall(at, part.function?.arguments ?? "");
      }
      // Replay data rather than text to show (OpenRouter's): text and summaries arrive in pieces, encrypted parts whole.
      if (Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) {
          if (!isDetail(detail)) continue;
          thinking ??= out.addThinking();
          details ??= [];
          const last = details.at(-1);
          if (last?.type === detail.type && (detail.type === "reasoning.text" || detail.type === "reasoning.summary")) {
            if (detail.type === "reasoning.text") last.text = (last.text ?? "") + detail.text;
            else last.summary = (last.summary ?? "") + detail.summary;
            // What a later piece names that the first did not (its signature, its id) belongs to the whole.
            last.signature ||= detail.signature;
            last.id ??= detail.id;
            last.format ||= detail.format;
            last.index ??= detail.index;
          } else details.push({ ...detail });
        }
      }
    }
    if (choice.finish_reason) {
      finished = true;
      const stop = STOP[choice.finish_reason];
      if (stop !== undefined) out.stopReason = stop;
      else out.stopWith(`The provider stopped: ${choice.finish_reason}`, stopFailure(choice.finish_reason));
    }
  }
  if (!finished) throw new Error("The provider's stream ended without a finish reason");
}

/** Thinking is turned off by OpenRouter's and DeepSeek's switches; OpenAI's format has none, only the effort `off` is sent as. */
export const openaiCompletions: Wire = {
  build,
  read,
  saysOff: (model) => thinkingFormat(model) !== "openai" || model.thinking?.values?.off !== undefined,
};
