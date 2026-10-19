import type { AssistantMessage, ImageContent, TextContent } from "@lemma/llm";
import type { SseEvent } from "./http.ts";
import { socketError } from "./socket.ts";
import { effortOf } from "./model.ts";
import { stopFailure } from "./failure.ts";
import { priced } from "./output.ts";
import type { Output } from "./output.ts";
import { history, maxTokens, passedOn, sanitize, shortHash } from "./transform.ts";
import { json, merged } from "./wire.ts";
import type { Wire, WireCall } from "./wire.ts";

/**
 * OpenAI's Responses API, stateless (`store: false`): reasoning goes back as the encrypted items it came as. A tool
 * call's id is `<call_id>|<item_id>`, and a text block's signature its message item's id and phase, so both go back
 * paired as the API requires.
 */

/** The Responses API refuses `max_output_tokens` below 16. */
const MIN_OUTPUT_TOKENS = 16;
const PROMPT_CACHE_KEY_MAX = 64;

const idPart = (part: string) =>
  part
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64)
    .replace(/_+$/, "");

/** A text block's signature: its message item's id and phase (`{"v":1,"id":…}`), or a bare id as older logs hold. */
function textSignature(signature: string | undefined): { readonly id: string; readonly phase?: string } | undefined {
  if (signature === undefined || signature === "") return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return { id: parsed.id, ...(parsed.phase === "commentary" || parsed.phase === "final_answer" ? { phase: parsed.phase } : {}) };
      }
    } catch {
      // A bare id.
    }
  }
  return { id: signature };
}

function resultOutput(call: WireCall, content: readonly (TextContent | ImageContent)[]): string | Record<string, unknown>[] {
  const text = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const images = content.filter((block): block is ImageContent => block.type === "image");
  if (images.length === 0 || !call.model.input.includes("image")) return sanitize(text || (images.length > 0 ? "(see attached image)" : "(no tool output)"));
  return [
    ...(text === "" ? [] : [{ type: "input_text", text: sanitize(text) }]),
    ...images.map((image) => ({ type: "input_image", detail: "auto", image_url: `data:${image.mimeType};base64,${image.data}` })),
  ];
}

function input(call: WireCall): Record<string, unknown>[] {
  const { model } = call;
  /** Another model's call ids: the call's part kept, its item id one the API takes (`fc_`, hashed). */
  const normalizeId = (id: string, source: AssistantMessage) => {
    const [callId = "", itemId] = id.split("|");
    if (itemId === undefined) return idPart(callId);
    const foreign = source.provider !== model.provider || source.api !== model.api;
    const item = foreign ? `fc_${shortHash(itemId)}` : idPart(itemId);
    return `${idPart(callId)}|${item.startsWith("fc_") ? item : idPart(`fc_${item}`)}`;
  };
  const items: Record<string, unknown>[] = [];
  if (call.request.system !== undefined && call.request.system !== "") {
    items.push({ role: model.reasoning && model.compat?.supportsDeveloperRole !== false ? "developer" : "system", content: sanitize(call.request.system) });
  }
  for (const [at, message] of history(call.request, model, normalizeId).entries()) {
    if (message.role === "user") {
      const content = message.content.map((block) =>
        block.type === "text"
          ? { type: "input_text", text: sanitize(block.text) }
          : { type: "input_image", detail: "auto", image_url: `data:${block.mimeType};base64,${block.data}` },
      );
      if (content.length > 0) items.push({ role: "user", content });
    } else if (message.role === "toolResult") {
      items.push({ type: "function_call_output", call_id: message.toolCallId.split("|")[0], output: resultOutput(call, message.content) });
    } else items.push(...assistantItems(message, model, at));
  }
  return items;
}

/** An answer as the input items it goes back as; `at` is its place in the history, for a text block with no id. */
function assistantItems(
  message: Pick<AssistantMessage, "content" | "provider" | "api" | "model">,
  model: WireCall["model"],
  at: number,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const same = message.provider === model.provider && message.api === model.api && message.model === model.id;
  // Another model of the same provider made it: its item ids are its own, and would be refused paired with ours.
  const otherModel = !same && message.provider === model.provider && message.api === model.api;
  let texts = 0;
  for (const block of message.content) {
    if (block.type === "thinking") {
      if (block.thinkingSignature === undefined) continue;
      try {
        const item = JSON.parse(block.thinkingSignature) as Record<string, unknown>;
        // With `store: false` the provider keeps nothing to find one by its id: one without its content is refused.
        if (item.encrypted_content != null) items.push(item);
      } catch {
        // Not a reasoning item: nothing to send back.
      }
    } else if (block.type === "text") {
      const signature = textSignature(block.textSignature);
      let id = signature?.id ?? `msg_${at}_${texts}`;
      if (id.length > 64) id = `msg_${shortHash(id)}`;
      texts++;
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: sanitize(block.text), annotations: [] }],
        status: "completed",
        id,
        ...(signature?.phase === undefined ? {} : { phase: signature.phase }),
      });
    } else {
      const [callId, itemId] = block.id.split("|");
      items.push({
        type: "function_call",
        ...(otherModel || !itemId?.startsWith("fc_") ? {} : { id: itemId }),
        call_id: callId,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
        ...(same && block.namespace !== undefined ? { namespace: block.namespace } : {}),
      });
    }
  }
  // A reasoning item goes back only before the item it led to: one with nothing after it (an answer stopped, or cut at
  // its limit, mid-thought) is refused.
  while (items.at(-1)?.type === "reasoning") items.pop();
  return items;
}

/**
 * An answer `model` just gave, as the next request sends it back: what a connection holding that answer already has
 * (`socket.ts`), after the request's own input.
 */
export const answerItems = (model: WireCall["model"], content: AssistantMessage["content"]): Record<string, unknown>[] =>
  assistantItems({ content, provider: model.provider, api: model.api, model: model.id }, model, -1);

function build(call: WireCall) {
  const { model, request, level, auth } = call;
  const options = passedOn(request.providerOptions);
  const body: Record<string, unknown> = { model: model.id, input: input(call), stream: true, store: false };
  if (request.sessionId !== undefined) body.prompt_cache_key = Array.from(request.sessionId).slice(0, PROMPT_CACHE_KEY_MAX).join("");
  // Signed in with ChatGPT, these fields are refused.
  if (!auth.oauth) {
    if (call.cacheRetention === "long") body.prompt_cache_retention = "24h";
    body.max_output_tokens = Math.max(maxTokens(model, request), MIN_OUTPUT_TOKENS);
    if (options.temperature !== undefined && model.temperature !== false) body.temperature = options.temperature;
  }
  const tools = request.tools ?? [];
  if (tools.length > 0) body.tools = tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
  const effort = model.thinking !== undefined && level !== undefined ? effortOf(model, level) : undefined;
  // `none` is the API's word for no reasoning; at any other effort (an `off` a config maps to one too) the model reasons,
  // and its reasoning comes back encrypted, as `store: false` keeps nothing for it to go back as otherwise.
  if (effort === "none") body.reasoning = { effort };
  else if (effort !== undefined) {
    body.reasoning = { effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  return {
    url: `${model.baseUrl}/responses`,
    body: merged(body, options.samplingParams),
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${auth.key}` },
  };
}

interface Item {
  readonly type: string;
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly namespace?: string;
  readonly phase?: string | null;
  readonly summary?: readonly { readonly text?: string }[];
  readonly content?: readonly { readonly type?: string; readonly text?: string; readonly refusal?: string }[];
  readonly encrypted_content?: string | null;
}

interface Response {
  readonly id?: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string } | null;
  readonly error?: { readonly code?: string; readonly message?: string } | null;
  readonly output?: readonly Item[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number; readonly cache_write_tokens?: number };
    readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  };
}

async function read(events: AsyncIterable<SseEvent>, out: Output, call: WireCall, raw: (data: unknown) => void) {
  /** The answer's output items by their index, as the message's blocks. */
  const slots = new Map<number, number>();
  const reasoning = new Map<string, number>();
  /** The part of a reasoning block whose text streams now, by block: a new one is set apart from the last as the final text joins them. */
  const parts = new Map<number, string>();
  const reason = (at: number, part: string, delta: string) => {
    const last = parts.get(at);
    parts.set(at, part);
    out.thinking(at, last !== undefined && last !== part ? `\n\n${delta}` : delta);
  };
  let ended = false;
  const slot = (outputIndex: number, item: Item): number | undefined => {
    const known = slots.get(outputIndex);
    if (known !== undefined) return known;
    const at =
      item.type === "reasoning"
        ? out.addThinking()
        : item.type === "message"
          ? out.addText()
          : item.type === "function_call"
            ? out.addToolCall(`${item.call_id}|${item.id}`, item.name ?? "")
            : undefined;
    if (at !== undefined) slots.set(outputIndex, at);
    if (at !== undefined && item.type === "function_call" && item.arguments) out.toolCall(at, item.arguments);
    return at;
  };
  const finish = (response: Response) => {
    ended = true;
    // Some deployments send a reasoning item's encrypted content only in the final response.
    for (const item of response.output ?? []) {
      const at = item.type === "reasoning" && item.id !== undefined && item.encrypted_content != null ? reasoning.get(item.id) : undefined;
      const block = at === undefined ? undefined : out.content[at];
      if (block?.type !== "thinking" || block.thinkingSignature === undefined) continue;
      const stored = JSON.parse(block.thinkingSignature) as Item;
      if (stored.encrypted_content == null) block.thinkingSignature = JSON.stringify({ ...stored, encrypted_content: item.encrypted_content });
    }
    if (response.id !== undefined) out.responseId = response.id;
    const usage = response.usage;
    if (usage !== undefined) {
      const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
      const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
      out.usage = priced(call.model, {
        // Input counts the cached tokens too.
        input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite),
        output: usage.output_tokens ?? 0,
        cacheRead,
        cacheWrite,
        reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
      });
    }
    const reason = response.incomplete_details?.reason;
    if (response.status === "incomplete") {
      if (reason === "max_output_tokens") out.stopReason = "length";
      else
        out.stopWith(reason === undefined ? "The response is incomplete, with no reason given" : `The response is incomplete: ${reason}`, stopFailure(reason));
    } else if (response.status === "failed" || response.status === "cancelled") {
      out.stopReason = "error";
      const error = response.error;
      out.errorMessage =
        error?.message === undefined ? `The response ${response.status}` : error.code === undefined ? error.message : `${error.code}: ${error.message}`;
    } else {
      out.stopReason = "stop";
      // The agent runs every call of a finished answer: one whose arguments never finished arriving is not one to run.
      const open = out.content.find((block, index) => block.type === "toolCall" && out.open(index));
      if (open?.type === "toolCall") out.stopWith(`The response ended with an unfinished tool call: ${open.name} (${open.id})`, undefined);
    }
  };
  for await (const event of events) {
    // A gateway may end the stream as Chat Completions does.
    if (event.data === "[DONE]") continue;
    const data = json(event) as { type?: string; [key: string]: unknown };
    raw(data);
    const outputIndex = data.output_index as number;
    switch (data.type) {
      case "response.created":
        out.responseId = (data.response as Response).id;
        break;
      case "response.output_item.added":
        slot(outputIndex, data.item as Item);
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const at = slots.get(outputIndex);
        const kind =
          data.type === "response.reasoning_summary_text.delta" ? `summary ${String(data.summary_index ?? 0)}` : `text ${String(data.content_index ?? 0)}`;
        if (at !== undefined) reason(at, kind, data.delta as string);
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const at = slots.get(outputIndex);
        if (at !== undefined) out.text(at, data.delta as string);
        break;
      }
      case "response.function_call_arguments.delta": {
        const at = slots.get(outputIndex);
        if (at !== undefined) out.toolCall(at, data.delta as string);
        break;
      }
      case "response.output_item.done": {
        const item = data.item as Item;
        const at = slot(outputIndex, item);
        const block = at === undefined ? undefined : out.content[at];
        if (at === undefined || block === undefined) break;
        if (item.type === "reasoning" && block.type === "thinking") {
          const summary = item.summary?.map((part) => part.text ?? "").join("\n\n") ?? "";
          const content = item.content?.map((part) => part.text ?? "").join("\n\n") ?? "";
          out.complete(at, summary || content);
          block.thinkingSignature = JSON.stringify(item);
          if (item.id !== undefined) reasoning.set(item.id, at);
        } else if (item.type === "message" && block.type === "text") {
          out.complete(at, item.content?.map((part) => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? ""))).join("") ?? "");
          block.textSignature = JSON.stringify({ v: 1, id: item.id, ...(item.phase ? { phase: item.phase } : {}) });
        } else if (item.type === "function_call" && block.type === "toolCall") {
          if (item.namespace !== undefined) block.namespace = item.namespace;
          // A proxy may send the finished call's arguments empty: what streamed stands.
          out.endToolCall(at, item.arguments || out.toolCallJson(at));
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        finish(data.response as Response);
        break;
      // Over HTTP the event names its code and message; over the socket, its status and an error object.
      case "error":
        throw socketError(data);
    }
    // The response ended: what follows (a proxy holding the stream open) is not waited for.
    if (ended) break;
  }
  if (!ended) throw new Error("The provider's stream ended before the response did");
}

export const openaiResponses: Wire = { build, read };
