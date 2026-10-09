import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Event, Hook } from "@lemma/core";
import type { Events } from "@lemma/core";
import { defineChannel, eventFeed, serveChannel } from "./channels.ts";
import type { Channel } from "./channels.ts";
import { InteractionOrigin } from "./interaction.ts";

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
});
export type ProviderInfo = typeof ProviderInfo.Type;

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
   * `message.stopReason` is `error` or `aborted`; `message.errorMessage` explains it, and `failure` classifies an error.
   * An error without `failure` is one the caller cannot tell will pass: the agent ends the turn rather than ask again.
   */
  Schema.Struct({ type: Schema.Literal("error"), message: AssistantMessage, failure: Schema.optional(LlmFailure) }),
]);
export type StreamEvent = typeof StreamEvent.Type;

/**
 * Why an `Llm` operation failed: a request that cannot start (an unknown model
 * or provider), or a login, logout, or custom provider change that did not
 * happen. A provider's failure to answer a request arrives as an `error` event
 * instead. Clients see `reason` as the error's code and `provider`, when it
 * names one, as its subject.
 */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly reason: "UnknownModel" | "UnknownProvider" | "LoginFailed" | "Cancelled" | "Busy" | "InvalidProvider" | "SaveFailed";
  readonly message: string;
  readonly provider?: string;
  readonly cause?: unknown;
}> {}

/** Wraps every model request: logging, retries, routing, and gates can be plugins. The terminal is the provider. */
export const LlmRequestHook = Hook.make<LlmRequest, Stream.Stream<StreamEvent, LlmError>, LlmError>("lemma/llm.request");

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
    /** Runs `LlmRequestHook`; interrupting the stream aborts the provider request. */
    readonly stream: (request: LlmRequest) => Stream.Stream<StreamEvent, LlmError>;
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
