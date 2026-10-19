import { Cause, Context, Data, Deferred, Effect, Equal, Exit, Fiber, Predicate, Result, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Event, Hook, Registry } from "@lemma/core";
import type { Events, HandlerStep, Hooks } from "@lemma/core";
import { defineChannel, eventFeed, inChainOrder, ResultCredit, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { InteractionOrigin } from "@lemma/contracts";

// Message shapes follow pi-ai's provider-neutral format so opaque provider
// state (reasoning signatures, response ids) survives a round trip through the
// session log unchanged. The log stores these values verbatim.

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  /** Provider message metadata that must be echoed back (OpenAI Responses item ids). */
  textSignature: Schema.optional(Schema.String),
});
export type TextContent = typeof TextContent.Type;

export const ThinkingContent = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  /** Opaque reasoning replay data; echoed back unchanged. */
  thinkingSignature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.Boolean),
});
export type ThinkingContent = typeof ThinkingContent.Type;

export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  /** Base64 without a data: prefix. */
  data: Schema.String,
  mimeType: Schema.String,
});
export type ImageContent = typeof ImageContent.Type;

/** The image formats every provider accepts; another (SVG, HEIC, TIFF…) would fail every later request in its session. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The largest image to send: providers reject more than 5 MB of base64, and a rejected image fails every later request in its session. */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

export const ToolCall = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  thoughtSignature: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});
export type ToolCall = typeof ToolCall.Type;

export const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  /** Subset of `output`, when the provider reports it. */
  reasoning: Schema.optional(Schema.Number),
  totalTokens: Schema.Number,
  /** USD. */
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
});
export type Usage = typeof Usage.Type;

export const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  ...(a.reasoning === undefined && b.reasoning === undefined ? {} : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
  totalTokens: a.totalTokens + b.totalTokens,
  cost: {
    input: a.cost.input + b.cost.input,
    output: a.cost.output + b.cost.output,
    cacheRead: a.cost.cacheRead + b.cost.cacheRead,
    cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
    total: a.cost.total + b.cost.total,
  },
});

/** The share of a call's input the provider's cache served, 0 to 1; undefined for a call with no input. */
export const cacheHitRate = (usage: Usage): number | undefined => {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return input === 0 ? undefined : usage.cacheRead / input;
};

export const StopReason = Schema.Literals(["stop", "length", "toolUse", "error", "aborted"]);
export type StopReason = typeof StopReason.Type;

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(Schema.Union([TextContent, ImageContent])),
  timestamp: Schema.Number,
});
export type UserMessage = typeof UserMessage.Type;

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union([TextContent, ThinkingContent, ToolCall])),
  /** Wire API that produced the message, e.g. `openai-responses`. */
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseId: Schema.optional(Schema.String),
  usage: Usage,
  stopReason: StopReason,
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
});
export type AssistantMessage = typeof AssistantMessage.Type;

export const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([TextContent, ImageContent])),
  isError: Schema.Boolean,
  timestamp: Schema.Number,
});
export type ToolResultMessage = typeof ToolResultMessage.Type;

export const Message = Schema.Union([UserMessage, AssistantMessage, ToolResultMessage]);
export type Message = typeof Message.Type;

/** JSON Schema object describing a tool's input. */
export const JsonSchema = Schema.Record(Schema.String, Schema.Unknown);
export type JsonSchema = typeof JsonSchema.Type;

export const ToolSpec = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonSchema,
});
export type ToolSpec = typeof ToolSpec.Type;

export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

/**
 * `<provider>/<model>`. Provider ids never contain `/`; model ids may
 * (`openrouter/anthropic/claude-sonnet-4`), so split at the first slash.
 */
export const ModelRef = Schema.String;
export type ModelRef = string;

export const parseModelRef = (ref: ModelRef): { readonly provider: string; readonly model: string } | undefined => {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
};

export const ModelInfo = Schema.Struct({
  /** `<provider>/<model>` */
  ref: ModelRef,
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  api: Schema.String,
  reasoning: Schema.Boolean,
  thinkingLevels: Schema.Array(ThinkingLevel),
  input: Schema.Array(Schema.Literals(["text", "image"])),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  /** USD per million tokens. */
  cost: Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number }),
});
export type ModelInfo = typeof ModelInfo.Type;

/**
 * A classifier model: not one to chat with, but one that answers typed questions about JSON state (and, where `input`
 * includes `"image"`, images) with probabilities, such as TypeSafe's Jev. `Llm.classify` runs it.
 */
export const ClassifierInfo = Schema.Struct({
  /** `<provider>/<model>` */
  ref: ModelRef,
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  api: Schema.String,
  input: Schema.Array(Schema.Literals(["text", "image"])),
  contextWindow: Schema.Number,
  /** USD per million tokens. */
  cost: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
});
export type ClassifierInfo = typeof ClassifierInfo.Type;

export const ClassifierQuestion = Schema.Union([
  /** Pick one label; `criteria` maps each label to what it means. */
  Schema.Struct({ type: Schema.Literal("choice"), instructions: Schema.String, criteria: Schema.Record(Schema.String, Schema.String) }),
  /** Score on an ordered scale; `criteria` describes each level, lowest first. */
  Schema.Struct({ type: Schema.Literal("score"), instructions: Schema.String, criteria: Schema.Array(Schema.String) }),
  /** Yes or no. */
  Schema.Struct({ type: Schema.Literal("bool"), instructions: Schema.String, criteria: Schema.Struct({ true: Schema.String, false: Schema.String }) }),
]);
export type ClassifierQuestion = typeof ClassifierQuestion.Type;

/** What `Llm.classify` is asked: questions by id, all answered in one call, about `state`. */
export const ClassifierContext = Schema.Struct({
  /** The data to classify, as JSON. */
  state: Schema.Record(Schema.String, Schema.Unknown),
  /** Judged with `state`; only a model whose `input` includes `"image"` accepts them. */
  images: Schema.optional(Schema.Array(ImageContent)),
  questions: Schema.Record(Schema.String, ClassifierQuestion),
});
export type ClassifierContext = typeof ClassifierContext.Type;

export const ClassifierAnswer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Number),
    confidence: Schema.Number,
  }),
  /** `score` is the expected level index, from 0 to `criteria.length - 1`. */
  Schema.Struct({ type: Schema.Literal("score"), score: Schema.Number, confidence: Schema.Number }),
  /** The probability of `true`. */
  Schema.Struct({ type: Schema.Literal("bool"), probability: Schema.Number }),
]);
export type ClassifierAnswer = typeof ClassifierAnswer.Type;

/** A classifier's answers by question id. A provider's failure is `stopReason: "error"` with its `errorMessage`. */
export const ClassifierResult = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  answers: Schema.Record(Schema.String, ClassifierAnswer),
  /** When the service reports token counts, priced from the model's catalog entry. */
  usage: Schema.optional(Usage),
  stopReason: Schema.Literals(["stop", "error", "aborted"]),
  errorMessage: Schema.optional(Schema.String),
});
export type ClassifierResult = typeof ClassifierResult.Type;

/** An image model: one that makes images from text and images, such as Gemini's image models. `Llm.generateImages` runs it. */
export const ImageModelInfo = Schema.Struct({
  /** `<provider>/<model>` */
  ref: ModelRef,
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  api: Schema.String,
  input: Schema.Array(Schema.Literals(["text", "image"])),
  /** Always includes `"image"`; `"text"`: it may answer with text blocks too. */
  output: Schema.Array(Schema.Literals(["text", "image"])),
  /** USD per million tokens. */
  cost: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
});
export type ImageModelInfo = typeof ImageModelInfo.Type;

/** What `Llm.generateImages` is asked: the prompt as text blocks, and images to edit or work from. */
export const ImagesContext = Schema.Struct({
  input: Schema.Array(Schema.Union([TextContent, ImageContent])),
});
export type ImagesContext = typeof ImagesContext.Type;

/** What an image model made. A provider's failure is `stopReason: "error"` with its `errorMessage`. */
export const ImagesResult = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  /** The images, and text blocks from a model that answers with text too. */
  output: Schema.Array(Schema.Union([TextContent, ImageContent])),
  usage: Schema.optional(Usage),
  stopReason: Schema.Literals(["stop", "error", "aborted"]),
  errorMessage: Schema.optional(Schema.String),
});
export type ImagesResult = typeof ImagesResult.Type;

export const AuthType = Schema.Literals(["api_key", "oauth"]);
export type AuthType = typeof AuthType.Type;

export const ProviderInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Login methods this provider offers in `/login`, with display names. */
  auth: Schema.Array(Schema.Struct({ type: AuthType, name: Schema.String, interactive: Schema.Boolean })),
  /** Whether requests can authenticate now (stored credential, env var, ambient config). */
  configured: Schema.Boolean,
  /** Where the working auth comes from: `OPENAI_API_KEY`, `OAuth`, `auth.json`. */
  source: Schema.optional(Schema.String),
  /** Added by the user (`Llm.addCustom`) rather than built in, so it can be removed. */
  custom: Schema.optional(Schema.Boolean),
  /** A custom provider's own logo, as SVG markup (`Llm.setLogo`). */
  logo: Schema.optional(Schema.String),
  /** The plugin that added it to `Providers`; it leaves with that plugin. */
  from: Schema.optional(Schema.String),
});
export type ProviderInfo = typeof ProviderInfo.Type;

/** A model a provider in `Providers` serves; what it leaves out has pi's defaults (128k context, 16k output, text only, free). */
export const ProviderModelSpec = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  input: Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
  contextWindow: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  maxTokens: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** USD per million tokens. */
  cost: Schema.optional(Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number })),
  /** pi thinking level → provider value; `null` marks a level unsupported. */
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  /** pi-ai's per-API `compat` flags (`supportsDeveloperRole: false` for Ollama, say); passed through unchecked. */
  compat: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ProviderModelSpec = typeof ProviderModelSpec.Type;

/**
 * A provider an endpoint makes: one of the wire protocols the llm plugin knows (`openai-completions`, say), at
 * `baseUrl`, with the models it serves. A user adds one on the Providers page (`Llm.addCustom`), and a plugin adds one
 * to `Providers`.
 */
export const ProviderSpec = Schema.Struct({
  /** Unique among providers, and with no `/`: models are named `<provider>/<model>`. */
  id: Schema.String.check(Schema.isPattern(/^[^/]+$/)),
  name: Schema.optional(Schema.String),
  /** The wire protocol, by its id. */
  api: Schema.String,
  baseUrl: Schema.String,
  /** A literal key or an environment variable. Omit both for keyless local servers; a stored login wins. */
  apiKey: Schema.optional(Schema.Struct({ env: Schema.optional(Schema.String), value: Schema.optional(Schema.String) })),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Applied to every model; a model's own `compat` wins per field. */
  compat: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  models: Schema.Array(ProviderModelSpec),
  /** Its logo, as SVG markup, for clients to show. */
  logo: Schema.optional(Schema.String),
});
export type ProviderSpec = typeof ProviderSpec.Type;

const decodeProvider = Schema.decodeUnknownResult(ProviderSpec);

/**
 * The providers plugins add (`PluginContext.add(Providers, spec)`), beside the built-in ones and those the user adds:
 * a company gateway, a local server. A provider belongs to the plugin that added it and leaves with it; an id is one
 * plugin's at a time, and one a built-in or the user's provider has is left out, with a warning, as is one speaking a
 * protocol the llm plugin does not know.
 *
 * @composition all providers, one per id (another plugin adding an id fails `Conflict`); one whose id a built-in or
 * the user's provider has, or whose protocol the llm plugin does not know, is left out with a warning. Checked
 * against `ProviderSpec` when added.
 */
export const Providers = Registry.make<ProviderSpec>("lemma/llm.providers", {
  key: (provider) => provider.id,
  unique: true,
  check: (value) => {
    const decoded = decodeProvider(value);
    return Result.isSuccess(decoded) ? undefined : `Not a provider: ${decoded.failure.message}`;
  },
});

/**
 * A provider the user adds: an endpoint that speaks one of the wire protocols
 * the llm plugin knows (`openai-completions`, say), with the models to offer.
 * How it is stored is the llm plugin's business.
 */
export const CustomProviderSpec = Schema.Struct({
  name: Schema.NonEmptyString,
  /** The wire protocol, by its id. */
  api: Schema.String,
  baseUrl: Schema.String,
  /** Model ids the endpoint serves. */
  models: Schema.NonEmptyArray(Schema.String),
  /** It needs an API key, asked for at login; false for keyless local servers. */
  key: Schema.optional(Schema.Boolean),
});
export type CustomProviderSpec = typeof CustomProviderSpec.Type;

export class LlmRequest extends Schema.Class<LlmRequest>("lemma/LlmRequest")({
  model: ModelRef,
  system: Schema.optional(Schema.String),
  messages: Schema.Array(Message),
  tools: Schema.optional(Schema.Array(ToolSpec)),
  thinking: Schema.optional(ThinkingLevel),
  maxTokens: Schema.optional(Schema.Number),
  /** Lets providers key prompt caches and pooled connections. */
  sessionId: Schema.optional(Schema.String),
  /**
   * What the provider passes on as it is, as its plugin documents (`llm.pi-ai`: `temperature`, `samplingParams`,
   * `metadata`). Logged with the request, so a request rebuilt from the log carries them.
   */
  providerOptions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

/**
 * Why a model call failed, for a caller deciding whether to ask again:
 * `transient` (the provider or the connection failed, or the stream stalled)
 * and `rate-limit` may succeed when asked again, after `retryAfterMs` when the
 * provider named a delay; `overflow` needs a shorter request; `fatal` will not
 * succeed as asked (authentication, quota, an invalid request).
 */
export const LlmFailure = Schema.Struct({
  kind: Schema.Literals(["transient", "rate-limit", "overflow", "fatal"]),
  retryAfterMs: Schema.optional(Schema.Number),
});
export type LlmFailure = typeof LlmFailure.Type;

/**
 * Streamed by `Llm.stream`. Every stream that starts ends with exactly one
 * `done` or `error`; both carry the complete assistant message so a failed
 * attempt can be logged with whatever it produced. `index` is the content
 * block index in that message.
 */
export const StreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("text-delta"), index: Schema.Number, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking-delta"), index: Schema.Number, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall-start"), index: Schema.Number, id: Schema.String, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall-delta"), index: Schema.Number, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall-end"), index: Schema.Number, toolCall: ToolCall }),
  Schema.Struct({ type: Schema.Literal("done"), message: AssistantMessage }),
  /**
   * How the provider answered (sent after `start`, before the body): its HTTP status and its request id, when it
   * answered with a response it streams, and who shaped what was sent (`LlmProviderHeadersHook`'s handlers: the headers
   * each changed, never their values), however it went. Not model output. A request it refused, or that never reached
   * it, has no status: the `error` event after says why.
   */
  Schema.Struct({
    type: Schema.Literal("provider"),
    status: Schema.optional(Schema.Number),
    requestId: Schema.optional(Schema.String),
    credit: Schema.optional(ResultCredit),
  }),
  /**
   * `message.stopReason` is `error` or `aborted`; `message.errorMessage` explains it, and `failure` classifies an error.
   * An error without `failure` is one the caller cannot tell will pass: the agent ends the turn rather than ask again.
   */
  Schema.Struct({ type: Schema.Literal("error"), message: AssistantMessage, failure: Schema.optional(LlmFailure) }),
]);
export type StreamEvent = typeof StreamEvent.Type;

/**
 * Why an `Llm` operation failed: a request that cannot start (an unknown model
 * or provider, or one a handler of `LlmRequestHook` changed), or a login, logout, or custom provider change that did not
 * happen. A provider's failure to answer a request arrives as an `error` event
 * instead. Clients see `reason` as the error's code and `provider`, when it
 * names one, as its subject.
 */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly reason: "UnknownModel" | "UnknownProvider" | "LoginFailed" | "Cancelled" | "Busy" | "InvalidProvider" | "SaveFailed" | "Hook";
  readonly message: string;
  readonly provider?: string;
  readonly cause?: unknown;
}> {}

/**
 * Around every model request and its stream: a handler times or gates it, answers it itself, or wraps its stream
 * (retries, logging), handing `next` the request it was given. It cannot change the request: what the model is asked
 * is what its caller logged (the agent's `request` event, which `rebuildRequest` rebuilds), so a provider of `Llm`
 * fails one a handler changed, sending nothing (`streamThroughHook`). A change to the request, routing it to another
 * model among them, belongs where it is logged and credited: `AgentRequestHook` (`@lemma/agent`). The terminal is the
 * provider.
 *
 * @composition a chain around the model call: a handler times, gates, or answers it (returning a stream of its own
 * without `next`), or wraps the stream `next` returns. A handler that fails fails the call as a provider error would.
 * Checked: it returns a stream.
 */
export const LlmRequestHook = Hook.make<LlmRequest, Stream.Stream<StreamEvent, LlmError>, LlmError>("lemma/llm.request", {
  check: { output: (value) => (Stream.isStream(value) ? undefined : "expected the call's stream (an Effect Stream)") },
});

/**
 * `LlmRequestHook` around `terminal`, as a provider of `Llm` runs it in `stream`: `terminal` gets the request as it was
 * asked, and a handler that hands `next` another (one not `Equal`) fails the stream `Hook`, naming it. Hook misuse and a
 * closing core are defects: the stream's error is `LlmError`.
 */
export const streamThroughHook = (
  hooks: Context.Service.Shape<typeof Hooks>,
  request: LlmRequest,
  terminal: (request: LlmRequest) => Effect.Effect<Stream.Stream<StreamEvent, LlmError>, LlmError>,
): Stream.Stream<StreamEvent, LlmError> =>
  Stream.unwrap(
    Effect.suspend(() => {
      const steps: HandlerStep<LlmRequest, Stream.Stream<StreamEvent, LlmError>>[] = [];
      const same = (a: LlmRequest, b: LlmRequest) => a === b || Equal.equals(a, b);
      const changed = new LlmError({ reason: "Hook", message: "A handler of LlmRequestHook changed the request" });
      return hooks
        .invoke(LlmRequestHook, request, (handed) => (same(handed, request) ? terminal(request) : Effect.fail(changed)), {
          onStep: (step) => void steps.push(step),
        })
        .pipe(
          Effect.catch((error) => {
            if (error !== changed) return error._tag === "LlmError" ? Effect.fail(error) : Effect.die(error);
            const by = inChainOrder(steps).find((step) => step.next !== undefined && !same(step.next.input, step.input))?.pluginId ?? "unknown";
            return Effect.fail(
              new LlmError({
                reason: "Hook",
                message: `${by} changed the request in LlmRequestHook, which sends a request as its caller logged it: change it in AgentRequestHook`,
              }),
            );
          }),
        );
    }),
  );

/** The HTTP headers a provider is about to send a request with (a `null` value drops a default one), and for what. */
export interface ProviderHeaders {
  readonly request: LlmRequest;
  /** The provider's id. */
  readonly provider: string;
  readonly headers: Readonly<Record<string, string | null>>;
}

/**
 * Around the headers of every request a provider of `Llm` sends: a handler adds, changes, or drops headers (a
 * gateway's key, a trace id), returning what `next` gives it changed. It is handed what would be sent (the model's own
 * headers, and the provider's defaults); the terminal returns them as they are. Who changed which header is told back
 * as the stream's `provider` event, and logged with the answer or the failed attempt; values never are, as headers
 * carry credentials. So headers are the provider's transport, not part of the request the log rebuilds
 * (`rebuildRequest`): what changes the model's behavior goes in `LlmRequest` (its `providerOptions`).
 *
 * @composition a chain: each handler returns the headers `next` gave it, changed (`null` drops one). A handler that
 * fails fails the call before it is sent. Checked: it returns a record of strings and nulls.
 */
export const LlmProviderHeadersHook = Hook.make<ProviderHeaders, Readonly<Record<string, string | null>>>("lemma/llm.provider-headers", {
  check: {
    output: (value) =>
      Predicate.isObject(value) && Object.values(value).every((header) => header === null || typeof header === "string")
        ? undefined
        : "expected headers: { [name]: string | null }",
  },
  summary: { input: (input) => ({ provider: input.provider, headers: Object.keys(input.headers).length }) },
});

/** A provider answered a request with a response it streams: its status and headers, before its body. Published by a provider of `Llm`. */
export const LlmProviderResponse = Event.make<{
  readonly sessionId?: string;
  readonly provider: string;
  readonly model: ModelRef;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}>("lemma/llm.provider.response");

/**
 * Each event of a provider's stream as the provider sent it, before it is made a `StreamEvent`: for debugging an
 * adapter. Published only while its provider plugin is told to (`llm.pi-ai`'s `providerEvents`), as it is costly.
 */
export const LlmProviderStreamEvent = Event.make<{
  readonly sessionId?: string;
  readonly provider: string;
  readonly model: ModelRef;
  readonly data: unknown;
}>("lemma/llm.provider.stream-event");

/**
 * What `Llm.providers` and `Llm.models` list changed; clients list them
 * again. The provider of `Llm` publishes it when a catalog refresh changed
 * the models, and after every login and logout, which change what is
 * configured and available even when the models stay the same.
 */
export const ModelsChanged = Event.make<Record<string, never>>("lemma/llm.models.changed");

/** Models and their providers. Its provider serves them to clients too: it adds `serveLlm` to `Channels`. */
export class Llm extends Context.Service<
  Llm,
  {
    readonly providers: Effect.Effect<readonly ProviderInfo[]>;
    /** Every known model, or only those whose provider is configured. */
    readonly models: (options?: { readonly available?: boolean }) => Effect.Effect<readonly ModelInfo[]>;
    readonly model: (ref: ModelRef) => Effect.Effect<ModelInfo, LlmError>;
    /** Runs `LlmRequestHook` (`streamThroughHook`); interrupting the stream aborts the provider request. */
    readonly stream: (request: LlmRequest) => Stream.Stream<StreamEvent, LlmError>;
    /** Every known classifier model, or only those whose provider is configured. `models` lists chat models only. */
    readonly classifiers: (options?: { readonly available?: boolean }) => Effect.Effect<readonly ClassifierInfo[]>;
    /**
     * Answers `context.questions` with the classifier `ref` names; an unknown one fails `UnknownModel`. A provider's
     * failure, missing auth included, is the result's `error`. Interrupting it aborts the provider request. Not a
     * model request: it is not logged as one, and `LlmRequestHook` does not run around it.
     */
    readonly classify: (ref: ModelRef, context: ClassifierContext) => Effect.Effect<ClassifierResult, LlmError>;
    /** Every known image model, or only those whose provider is configured. */
    readonly imageModels: (options?: { readonly available?: boolean }) => Effect.Effect<readonly ImageModelInfo[]>;
    /**
     * Makes images with the image model `ref` names; an unknown one fails `UnknownModel`. A provider's failure, missing
     * auth included, is the result's `error`. It can take minutes; interrupting it aborts the provider request. Not a
     * model request, as `classify` is not.
     */
    readonly generateImages: (ref: ModelRef, context: ImagesContext) => Effect.Effect<ImagesResult, LlmError>;
    /** Runs the provider's login flow through `Interaction` and stores the credential. */
    readonly login: (provider: string, type: AuthType) => Effect.Effect<void, LlmError>;
    readonly logout: (provider: string) => Effect.Effect<void, LlmError>;
    /**
     * Adds a provider of the user's; resolves with its id. It is saved in the
     * llm plugin's config, whose reload may finish after this returns: it is
     * listed once `providers` does.
     */
    readonly addCustom: (spec: CustomProviderSpec) => Effect.Effect<string, LlmError>;
    /** Removes a provider `addCustom` added, with its logo. */
    readonly removeCustom: (provider: string) => Effect.Effect<void, LlmError>;
    /** Sets or clears a custom provider's logo (SVG markup; the caller checks it is safe to show). */
    readonly setLogo: (provider: string, svg: string | undefined) => Effect.Effect<void, LlmError>;
  }
>()("lemma/Llm") {}

/** What `llm.changes` sends: `subscribed` first, then a note to list again after each change. */
export const LlmChange = Schema.Union([
  /** First: from here on the stream hears every change; a client lists providers and models after it. */
  Schema.Struct({ type: Schema.Literal("subscribed") }),
  /** What `Llm.providers` and `Llm.models` list changed (`ModelsChanged`): list them again. */
  Schema.Struct({ type: Schema.Literal("models-changed") }),
]);
export type LlmChange = typeof LlmChange.Type;

const providerField = { provider: Schema.String };

/**
 * How clients reach `Llm`, served by its provider (`serveLlm`). A call that
 * fails with an `LlmError` reaches the client with its `reason` as the code
 * and its provider as the subject (the channel when it names none).
 */
export const LlmChannels = {
  providers: defineChannel({
    kind: "call",
    id: "llm.providers",
    title: "Providers",
    description: "Every model provider, with the logins it offers and whether requests can authenticate now",
    payload: Schema.Void,
    success: Schema.Array(ProviderInfo),
    repeatable: true,
  }),
  models: defineChannel({
    kind: "call",
    id: "llm.models",
    title: "Models",
    description: "Every known model; with available, only those whose provider is configured",
    payload: Schema.Struct({ available: Schema.optional(Schema.Boolean) }),
    success: Schema.Array(ModelInfo),
    repeatable: true,
  }),
  /**
   * Runs a provider's login flow, as `Llm.login`; its questions reach clients
   * as interactions and its progress as notices, under the origin
   * `login:<provider>`. The login belongs to the provider, not to the call: it
   * runs in the provider's scope, so a client that drops its connection leaves
   * it running, its question waiting for a client to answer, and a second call
   * for the same provider and type waits for the same login. Fails `Busy` while
   * a login of the other type to that provider runs, `Cancelled` when
   * `llm.cancel-login` stops it, and as `Llm.login` does (`UnknownProvider`,
   * `LoginFailed`, `Cancelled` when its question is dismissed). When the
   * provider stops or reloads, the call fails `Withdrawn` at once, and the login
   * ends with the provider: calling again starts one on the replacement. It is
   * not `repeatable`, since a new login asks the person again: whether to is
   * the client's to decide.
   */
  login: defineChannel({
    kind: "call",
    id: "llm.login",
    title: "Log in",
    description: "Runs a provider's login flow and stores the credential; its questions and progress reach clients as interactions and notices",
    payload: Schema.Struct({ ...providerField, type: AuthType }),
    success: Schema.Void,
  }),
  /** Stops a provider's running login, whoever started it, as dismissing its question would: every call waiting for it fails `Cancelled`. */
  cancelLogin: defineChannel({
    kind: "call",
    id: "llm.cancel-login",
    title: "Cancel a login",
    description: "Stops a provider's running login, whoever started it; false when none was running",
    payload: Schema.Struct(providerField),
    success: Schema.Boolean,
  }),
  logout: defineChannel({
    kind: "call",
    id: "llm.logout",
    title: "Log out",
    description: "Removes a provider's stored credential",
    payload: Schema.Struct(providerField),
    success: Schema.Void,
  }),
  /** As `Llm.addCustom`: resolves with the new provider's id, which `llm.providers` lists once the provider's config has reloaded. */
  addCustom: defineChannel({
    kind: "call",
    id: "llm.add-custom",
    title: "Add a provider",
    description: "Adds a provider of the user's on a known wire API; resolves with its id",
    payload: Schema.Struct({ spec: CustomProviderSpec }),
    success: Schema.String,
  }),
  removeCustom: defineChannel({
    kind: "call",
    id: "llm.remove-custom",
    title: "Remove a provider",
    description: "Removes a provider the user added, with its logo",
    payload: Schema.Struct(providerField),
    success: Schema.Void,
  }),
  setLogo: defineChannel({
    kind: "call",
    id: "llm.set-logo",
    title: "Set a provider's logo",
    description: "Sets or clears the logo, as SVG markup, of a provider the user added",
    payload: Schema.Struct({ ...providerField, svg: Schema.optional(Schema.String) }),
    success: Schema.Void,
  }),
  /**
   * Says when to list providers and models again: after `subscribed` (see
   * `eventFeed`), each time `ModelsChanged` reports a change. A client that
   * lists on every element, `subscribed` included, misses none, and one that
   * reopens it after reconnecting, or after it ends `Withdrawn` because its
   * provider stopped or reloaded (as a change to the custom providers reloads
   * it), is in sync again. A client that falls behind receives one
   * `models-changed` for all it missed: the provider never waits for it.
   */
  changes: defineChannel({
    kind: "stream",
    id: "llm.changes",
    title: "Changes",
    description: "Says it is subscribed, then each time the providers or models listed change: list both on each",
    payload: Schema.Void,
    success: LlmChange,
  }),
};

/**
 * Logins as `llm.login` runs them: in `scope`, one per provider. Admission
 * and the fork are uninterruptible, or a caller interrupted between them would
 * leave the provider busy forever. A caller awaits the login rather than
 * joining it, so one that goes away leaves it running. `cancel` interrupts it,
 * which withdraws its open question.
 */
const makeLogins = (llm: Context.Service.Shape<typeof Llm>, scope: Scope.Scope) => {
  const running = new Map<string, { readonly type: AuthType; readonly fiber: Deferred.Deferred<Fiber.Fiber<void, LlmError>> }>();
  const login = (provider: string, type: AuthType): Effect.Effect<void, LlmError> =>
    Effect.gen(function* () {
      const fiber = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const current = running.get(provider);
          if (current !== undefined) {
            if (current.type !== type)
              return yield* new LlmError({ reason: "Busy", provider, message: `A ${current.type} login to "${provider}" is in progress` });
            return current.fiber;
          }
          // Set before the fork, so the entry exists before the login can end.
          const entry = { type, fiber: yield* Deferred.make<Fiber.Fiber<void, LlmError>>() };
          running.set(provider, entry);
          const forked = yield* Effect.forkIn(
            Effect.interruptible(Effect.provideService(llm.login(provider, type), InteractionOrigin, `login:${provider}`)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (running.get(provider) === entry) running.delete(provider);
                }),
              ),
            ),
            scope,
          );
          yield* Deferred.succeed(entry.fiber, forked);
          return entry.fiber;
        }),
      );
      const exit = yield* Fiber.await(yield* Deferred.await(fiber));
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
        return yield* new LlmError({ reason: "Cancelled", provider, message: `The ${provider} login was cancelled` });
      }
      return yield* exit;
    });
  const cancel = (provider: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const current = running.get(provider);
      if (current === undefined) return false;
      yield* Fiber.interrupt(yield* Deferred.await(current.fiber));
      return true;
    });
  return { login, cancel };
};

const changed: LlmChange = { type: "models-changed" };

/**
 * `LlmChannels` served from `llm`: what a provider of `Llm` adds to
 * `Channels`, each with `PluginContext.add`. Its logins run in the scope this
 * runs in, its setup's, and so end with the provider.
 */
export const serveLlm = (
  llm: Context.Service.Shape<typeof Llm>,
  events: Context.Service.Shape<typeof Events>,
): Effect.Effect<readonly Channel[], never, Scope.Scope> =>
  Effect.map(Effect.scope, (scope) => {
    const logins = makeLogins(llm, scope);
    return [
      serveChannel(LlmChannels.providers, () => llm.providers),
      serveChannel(LlmChannels.models, ({ available }) => llm.models(available === undefined ? undefined : { available })),
      // The login ends only with the provider, so the call stops waiting when it leaves rather than hold that up.
      serveChannel(LlmChannels.login, ({ provider, type }, { left }) => Effect.raceFirst(logins.login(provider, type), left)),
      serveChannel(LlmChannels.cancelLogin, ({ provider }) => logins.cancel(provider)),
      serveChannel(LlmChannels.logout, ({ provider }) => llm.logout(provider)),
      serveChannel(LlmChannels.addCustom, ({ spec }) => llm.addCustom(spec)),
      serveChannel(LlmChannels.removeCustom, ({ provider }) => llm.removeCustom(provider)),
      serveChannel(LlmChannels.setLogo, ({ provider, svg }) => llm.setLogo(provider, svg)),
      // Holding one, at the source and the client: each element says only to list again, so one stands for any number.
      serveChannel(LlmChannels.changes, () =>
        eventFeed(Effect.succeed<LlmChange>({ type: "subscribed" }), [Stream.as(events.stream(ModelsChanged, { buffer: 1 }), changed)], 1),
      ),
    ];
  });

/** The text parts of `content`, one per line: what a message or a tool result says, without its images. */
export const contentText = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
