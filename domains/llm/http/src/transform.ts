import type { AssistantMessage, LlmRequest, Message, ToolResultMessage } from "@lemma/llm";
import { bindsThinking } from "./model.ts";
import type { Model } from "./model.ts";

type Content = Message["content"][number];

const USER_IMAGE_OMITTED = "(image omitted: model does not support images)";
const TOOL_IMAGE_OMITTED = "(tool image omitted: model does not support images)";

/** `content` with each run of images as one placeholder, for a model that takes no images. */
function withoutImages<C extends Content>(content: readonly C[], placeholder: string): C[] {
  const out: C[] = [];
  for (const block of content) {
    if (block.type !== "image") out.push(block);
    else if (out.at(-1)?.type !== "text" || (out.at(-1) as { text?: string }).text !== placeholder) out.push({ type: "text", text: placeholder } as C);
  }
  return out;
}

/** Removes unpaired UTF-16 surrogates, which fail JSON encoding at many providers. */
export const sanitize = (text: string): string => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** A short stable hash of `text`, for ids made from longer ones. */
export function shortHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/** Whether `message` was made by `model` itself, so its signatures and opaque state can go back to it. */
export const sameModel = (message: AssistantMessage, model: Model): boolean =>
  message.provider === model.provider && message.api === model.api && message.model === model.id;

/**
 * The request's history as `model` can take it back:
 *
 * - Thinking made under another prefix (`thinkingFrom`) is left out for a model that binds thinking to it.
 * - An answer that failed or was stopped is left out: half a turn (reasoning with no reply, a cut-off call) fails the
 *   request, and the model goes on from the last whole one.
 * - Another model's thinking becomes text, its opaque parts (redacted thinking, signatures) are dropped, and its tool
 *   call ids become ones this protocol takes (`normalizeId`), their results following.
 * - A tool call left without a result gets one saying so, as every protocol requires one.
 * - Images go to a model that takes none as a placeholder.
 */
export function history(request: LlmRequest, model: Model, normalizeId: (id: string, source: AssistantMessage) => string): Message[] {
  const binds = request.thinkingFrom !== undefined && bindsThinking(model);
  const ids = new Map<string, string>();
  const images = model.input.includes("image");
  const out: Message[] = [];
  let pending: { readonly id: string; readonly name: string }[] = [];
  const answered = new Set<string>();
  const close = () => {
    for (const call of pending) {
      if (answered.has(call.id)) continue;
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      };
      out.push(result);
    }
    pending = [];
    answered.clear();
  };
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "user") {
      close();
      out.push(images ? message : { ...message, content: withoutImages(message.content, USER_IMAGE_OMITTED) });
    } else if (message.role === "toolResult") {
      const id = ids.get(message.toolCallId) ?? message.toolCallId;
      answered.add(id);
      const content = images ? message.content : withoutImages(message.content, TOOL_IMAGE_OMITTED);
      out.push({ ...message, toolCallId: id, content });
    } else {
      close();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const same = sameModel(message, model);
      const dropThinking = binds && index < request.thinkingFrom!;
      const content = message.content.flatMap((block): AssistantMessage["content"][number][] => {
        if (block.type === "thinking") {
          if (dropThinking || (block.redacted === true && !same)) return [];
          if (same) return block.thinkingSignature !== undefined || block.thinking.trim() !== "" ? [block] : [];
          return block.thinking.trim() === "" ? [] : [{ type: "text", text: block.thinking }];
        }
        if (block.type === "text") return [same ? block : { type: "text", text: block.text }];
        if (same) return [block];
        const id = normalizeId(block.id, message);
        if (id !== block.id) ids.set(block.id, id);
        const { thoughtSignature: _signature, ...call } = block;
        return [{ ...call, id }];
      });
      const calls = content.filter((block) => block.type === "toolCall");
      pending = calls.map((call) => ({ id: call.id, name: call.name }));
      out.push({ ...message, content });
    }
  }
  close();
  return out;
}

/** Characters a token holds, at least, in the prose, code, and JSON a request carries. */
const CHARS_PER_TOKEN = 3.5;
/** What an image counts as, in characters. */
const IMAGE_CHARS = 4800;

const messageChars = (message: Message): number => {
  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += JSON.stringify(block.arguments).length + block.name.length;
    else chars += IMAGE_CHARS;
  }
  return chars;
};

/**
 * The tokens a request takes, about: from the last answer's own count, which the provider measured on all that came
 * before it, plus an estimate of what came after. An answer older than a message before it (a compaction's summary)
 * counted another history, and one that failed counted nothing whole: without a usable count, all of it is estimated.
 */
function estimateTokens(request: LlmRequest): number {
  let anchor: { readonly index: number; readonly tokens: number } | undefined;
  let newest = Number.NEGATIVE_INFINITY;
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "assistant" && message.timestamp >= newest && message.stopReason !== "error" && message.stopReason !== "aborted") {
      const { usage } = message;
      const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (tokens > 0) anchor = { index, tokens };
    }
    newest = Math.max(newest, message.timestamp);
  }
  let chars = 0;
  for (const message of request.messages.slice(anchor === undefined ? 0 : anchor.index + 1)) chars += messageChars(message);
  if (anchor === undefined) {
    chars += request.system?.length ?? 0;
    for (const tool of request.tools ?? []) chars += tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
  }
  return (anchor?.tokens ?? 0) + Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Tokens kept free of an estimate's error. */
const CONTEXT_SAFETY = 4096;

/** The output tokens to ask for (`wanted`: the request's limit, else the model's), within what the context window leaves. */
export function maxTokens(model: Model, request: LlmRequest, wanted = request.maxTokens ?? model.maxTokens): number {
  if (model.contextWindow <= 0) return Math.max(1, wanted);
  return Math.min(wanted, Math.max(1, model.contextWindow - estimateTokens(request) - CONTEXT_SAFETY));
}

/** `providerOptions`' `temperature`, `samplingParams`, and `metadata`, as this plugin passes them on. */
export function passedOn(options: LlmRequest["providerOptions"]): {
  readonly temperature?: number;
  readonly samplingParams?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
} {
  if (options === undefined) return {};
  const record = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  const samplingParams = record(options.samplingParams);
  const metadata = record(options.metadata);
  return {
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** The text parts of `content`, one per line. */
export const textOf = (content: readonly Content[]): string =>
  content
    .filter((block): block is Extract<Content, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
