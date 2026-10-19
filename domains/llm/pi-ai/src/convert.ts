import { clampThinkingLevel, getSupportedThinkingLevels, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type * as Pi from "@earendil-works/pi-ai";
import { ThinkingLevel } from "@lemma/llm";
import type {
  AssistantMessage,
  ClassifierContext,
  ClassifierInfo,
  ClassifierResult,
  ImageModelInfo,
  ImagesContext,
  ImagesResult,
  LlmFailure,
  LlmRequest,
  ModelInfo,
  StreamEvent,
  ToolCall,
  Usage,
} from "@lemma/llm";

// Pure mappings between pi-ai values and the contract shapes. Contract messages
// are pi-ai-shaped, so requests pass through; results are rebuilt field by field
// so pi-only fields (diagnostics, responseModel, rawStopReason, ...) never reach
// the session log.

const contractLevels: ReadonlySet<string> = new Set(ThinkingLevel.literals);

const modelRef = (model: Pi.Model<Pi.Api>): string => `${model.provider}/${model.id}`;

export function toModelInfo(model: Pi.Model<Pi.Api>): ModelInfo {
  return {
    ref: modelRef(model),
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => contractLevels.has(level)),
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
}

export function toClassifierInfo(model: Pi.ClassifierModel<Pi.ClassifierApi>): ClassifierInfo {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    input: [...model.input],
    contextWindow: model.contextWindow,
    cost: { input: model.cost.input, output: model.cost.output },
  };
}

export function toImageModelInfo(model: Pi.ImageModel<Pi.ImageApi>): ImageModelInfo {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    input: [...model.input],
    output: [...model.output],
    cost: { input: model.cost.input, output: model.cost.output },
  };
}

const toUsage = (usage: Pi.Usage): Usage => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  totalTokens: usage.totalTokens,
  cost: { ...usage.cost },
});

/** The contract's context as pi-ai's: `state` is JSON, as a script or tool gave it. */
export const toClassifierContext = (context: ClassifierContext): Pi.ClassifierContext => context as AsPi<ClassifierContext> as Pi.ClassifierContext;

export const toImagesContext = (context: ImagesContext): Pi.ImagesContext => context as AsPi<ImagesContext> as Pi.ImagesContext;

/** Rebuilt field by field, so pi-only fields (`api`, `responseId`, `timestamp`) stay out. */
export const toImagesResult = (result: Pi.AssistantImages): ImagesResult => ({
  provider: result.provider,
  model: result.model,
  output: result.output.map((block) =>
    block.type === "text" ? { type: "text" as const, text: block.text } : { type: "image" as const, data: block.data, mimeType: block.mimeType },
  ),
  ...(result.usage === undefined ? {} : { usage: toUsage(result.usage) }),
  stopReason: result.stopReason,
  ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
});

/** Rebuilt field by field, so pi-only fields (`api`, `timestamp`) stay out. */
export const toClassifierResult = (result: Pi.ClassifierResult): ClassifierResult => ({
  provider: result.provider,
  model: result.model,
  answers: result.answers,
  ...(result.usage === undefined ? {} : { usage: toUsage(result.usage) }),
  stopReason: result.stopReason,
  ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
});

/**
 * A contract value as pi-ai types it, for what pi-ai only reads: its arrays and properties writable, all the way down;
 * an optional field without the `undefined` the contract's Schema allows it, as pi-ai reads an absent field and an
 * undefined one alike; and what the contract leaves `unknown` (a tool call's arguments) JSON, as it is what the session
 * log holds.
 */
type AsPi<T> = unknown extends T
  ? Pi.JsonValue
  : T extends readonly (infer E)[]
    ? AsPi<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: {} extends Pick<T, K> ? AsPi<Exclude<T[K], undefined>> : AsPi<T[K]> }
      : T;

/**
 * The contract's messages as pi-ai's, unchanged (pi-ai does not mutate its input). Only what `AsPi` says is assumed;
 * the compiler checks the rest, so a contract message pi-ai's type no longer accepts fails the build.
 */
const piMessages = (messages: LlmRequest["messages"]): Pi.Message[] => messages as AsPi<LlmRequest["messages"]>;

/**
 * Whether the model binds a reply's thinking to the request it answered: Anthropic's adaptive-thinking models
 * (directly and through Bedrock), which reject a thinking block, or drop it with every later one, once anything before
 * it changed. Leaving out the thinking of a tool round in flight is allowed in adaptive mode. Not its budget-thinking
 * models, which bind nothing and reject a request continuing a tool round whose thinking was left out. Not other
 * providers, which take reasoning back whatever came before it (OpenAI's needs it beside the reply it produced).
 *
 * pi-ai says which Claude models think adaptively only inside its providers; its thinking levels say the same: the
 * `max` effort is adaptive thinking's alone (every Claude model of pi-ai 1.2.0's catalogs agrees).
 */
export function bindsThinking(model: Pi.Model<Pi.Api>): boolean {
  if (model.api !== "anthropic-messages" && model.api !== "bedrock-converse-stream") return false;
  return getSupportedThinkingLevels(model).includes("max");
}

/** `messages`, without the thinking of those before `from` (`LlmRequest.thinkingFrom`). */
const withoutThinkingBefore = (messages: LlmRequest["messages"], from: number): LlmRequest["messages"] =>
  messages.map((message, index) =>
    index >= from || message.role !== "assistant" || !message.content.some((block) => block.type === "thinking")
      ? message
      : { ...message, content: message.content.filter((block) => block.type !== "thinking") },
  );

/** The request as pi-ai's context, for `model`. */
export function toContext(request: LlmRequest, model: Pi.Model<Pi.Api>): Pi.Context {
  const messages =
    request.thinkingFrom !== undefined && bindsThinking(model) ? withoutThinkingBefore(request.messages, request.thinkingFrom) : request.messages;
  return {
    ...(request.system === undefined ? {} : { systemPrompt: request.system }),
    messages: piMessages(messages),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            // A JSON Schema object, which is what pi-ai's (TypeBox's) `TSchema` is.
            parameters: tool.parameters,
          })),
        }),
  };
}

/** The pi reasoning level for a request: clamped to what the model supports, absent for "off". */
export function reasoningFor(model: Pi.Model<Pi.Api>, thinking: ThinkingLevel | undefined): Pi.ThinkingLevel | undefined {
  if (thinking === undefined || thinking === "off" || !model.reasoning) return undefined;
  const level = clampThinkingLevel(model, thinking);
  return level === "off" ? undefined : level;
}

function toToolCall(call: Pi.ToolCall): ToolCall {
  return {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    ...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature }),
    ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
  };
}

function toContent(block: Pi.AssistantMessage["content"][number]): AssistantMessage["content"][number] {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    case "toolCall":
      return toToolCall(block);
  }
}

/**
 * Terminal message in contract shape. `pending` (no final reason) and
 * `deferred` (a handle this plugin never requests) become `error`, so the
 * message can still be logged and replayed.
 */
function toAssistantMessage(message: Pi.AssistantMessage, errorMessage?: string): AssistantMessage {
  const { usage } = message;
  let stopReason: AssistantMessage["stopReason"];
  let error = errorMessage ?? message.errorMessage;
  switch (message.stopReason) {
    case "pending":
      stopReason = "error";
      error ??= "The provider ended the response without a stop reason";
      break;
    case "deferred":
      stopReason = "error";
      error ??= "The provider deferred the response, which is not supported";
      break;
    default:
      stopReason = message.stopReason;
  }
  return {
    role: "assistant",
    content: message.content.map(toContent),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    usage: toUsage(usage),
    stopReason,
    ...(error === undefined ? {} : { errorMessage: error }),
    timestamp: message.timestamp,
  };
}

/** Rewrites pi's terse auth failures into something a user can act on. */
function explainError(message: string | undefined, provider: { readonly id: string; readonly name: string }): string | undefined {
  if (message === undefined) return undefined;
  const login = `Run /login ${provider.id}`;
  if (message.startsWith("Provider is not configured:") || message.startsWith("No API key for provider:")) {
    return `${provider.name} is not authenticated. ${login} or set its API key environment variable.`;
  }
  if (message.startsWith("OAuth refresh failed") || message.startsWith("OAuth refresh returned")) {
    return `${message}. ${login} to sign in again.`;
  }
  return message;
}

const RATE_LIMIT = /rate.?limit|too many requests|\b429\b|resource.?exhausted/i;
/** pi-ai's wording when a provider asks for a longer wait than its SDK retries will sit through. */
const REQUESTED_DELAY = /Server requested (\d+)s retry delay/;
/** A request over a per-minute token limit: it never passes, however long the wait. */
const TOO_LARGE = /request too large/i;
/** The status a provider SDK puts first: a 4xx but a timeout, conflict, or rate limit is the request's own fault. */
const CLIENT_ERROR = /^\s*4(?!08|09|29)\d\d\b/;
/** Node's codes for a connection that failed, rather than the request. */
const NETWORK = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b/;

/**
 * Why a call failed, from pi-ai's own classifiers over the provider's wording
 * (pi reports failures as text): overflow first, as pi advises, then whether
 * asking again can help, and whether the provider is throttling. pi's test
 * for that finds a status anywhere in the text (`500` in a byte count) and
 * misses Node's connection errors, so a leading 4xx status and those codes
 * are read first.
 */
function classifyFailure(message: Pi.AssistantMessage, contextWindow: number): LlmFailure {
  if (isContextOverflow(message, contextWindow)) return { kind: "overflow" };
  const text = message.errorMessage ?? "";
  if (TOO_LARGE.test(text) || CLIENT_ERROR.test(text)) return { kind: "fatal" };
  if (!NETWORK.test(text) && !isRetryableAssistantError(message)) return { kind: "fatal" };
  const requested = REQUESTED_DELAY.exec(text);
  return { kind: RATE_LIMIT.test(text) ? "rate-limit" : "transient", ...(requested === null ? {} : { retryAfterMs: Number(requested[1]) * 1000 }) };
}

/** What a silent overflow (below) is logged as. */
const SILENT_OVERFLOW = "The request filled the model's context window, leaving no room to answer";

const emptyMessage = (model: Pi.Model<Pi.Api>): Pi.AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error",
  timestamp: Date.now(),
});

/**
 * Stateful translation of one pi-ai event stream into contract events. It
 * guarantees the `StreamEvent` protocol even when pi does not: a `start`
 * precedes everything (pi may fail setup without one), exactly one terminal
 * is emitted, and events after it are ignored.
 */
export function makeEventMapper(model: Pi.Model<Pi.Api>, provider: { readonly id: string; readonly name: string }) {
  let started = false;
  let finished = false;
  let latest: Pi.AssistantMessage | undefined;

  const begin = (): StreamEvent[] => {
    if (started) return [];
    started = true;
    return [{ type: "start" }];
  };
  const terminal = (message: Pi.AssistantMessage, fallback?: string, failure?: LlmFailure): StreamEvent[] => {
    finished = true;
    const mapped = toAssistantMessage(message, explainError(message.errorMessage ?? fallback, provider));
    if (mapped.stopReason === "aborted") return [...begin(), { type: "error", message: mapped }];
    // Cut off at its limit having said nothing, its input filling the context window: some providers cut a request
    // too long to fit rather than refuse it. (pi also counts a finished answer whose input exceeds the window, but
    // that one is kept: a wrong window in the model's metadata would turn good answers into failures.)
    if (mapped.stopReason === "length" && isContextOverflow(message, model.contextWindow)) {
      return [
        ...begin(),
        { type: "error", message: toAssistantMessage({ ...message, stopReason: "error", errorMessage: SILENT_OVERFLOW }), failure: { kind: "overflow" } },
      ];
    }
    if (mapped.stopReason !== "error") return [...begin(), { type: "done", message: mapped }];
    const classified =
      failure ?? classifyFailure({ ...message, stopReason: "error", errorMessage: message.errorMessage ?? fallback ?? "" }, model.contextWindow);
    return [...begin(), { type: "error", message: mapped, failure: classified }];
  };

  return {
    get finished() {
      return finished;
    },
    push(event: Pi.AssistantMessageEvent): StreamEvent[] {
      if (finished) return [];
      if ("partial" in event) latest = event.partial;
      switch (event.type) {
        case "start":
          return begin();
        case "text_delta":
          return [...begin(), { type: "text-delta", index: event.contentIndex, delta: event.delta }];
        case "thinking_delta":
          return [...begin(), { type: "thinking-delta", index: event.contentIndex, delta: event.delta }];
        case "toolcall_start": {
          const block = event.partial.content[event.contentIndex];
          const call = block?.type === "toolCall" ? block : undefined;
          return [...begin(), { type: "toolcall-start", index: event.contentIndex, id: call?.id ?? "", name: call?.name ?? "" }];
        }
        case "toolcall_delta":
          return [...begin(), { type: "toolcall-delta", index: event.contentIndex, delta: event.delta }];
        case "toolcall_end":
          return [...begin(), { type: "toolcall-end", index: event.contentIndex, toolCall: toToolCall(event.toolCall) }];
        case "done":
          return terminal(event.message);
        case "error":
          return terminal(event.error, event.reason === "aborted" ? "Request was aborted" : "Request failed");
        default:
          return [];
      }
    },
    /** Call when pi's stream ends or throws; closes a stream that ended without a terminal. `failure` overrides the classification. */
    end(cause?: unknown, failure?: LlmFailure): StreamEvent[] {
      if (finished) return [];
      const reason = cause === undefined ? "The provider stream ended without a result" : cause instanceof Error ? cause.message : String(cause);
      return terminal(
        { ...(latest ?? emptyMessage(model)), stopReason: "error", errorMessage: reason },
        undefined,
        failure ?? (cause === undefined ? { kind: "transient" } : undefined),
      );
    },
  };
}
