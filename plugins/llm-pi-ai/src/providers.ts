import type { CustomProviderSpec } from "@lemma/contracts";
import type { Api, AssistantMessageEventStream, Model, ProviderStreams, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { OPENCODE_MODELS } from "@earendil-works/pi-ai/providers/opencode.models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { Schema } from "effect";
import type { OAuthMethod, ProviderAuth } from "./auth.ts";
import { fixedCatalog, planCatalog } from "./catalog.ts";
import type { Catalog, LiveOptions, PlanSource } from "./catalog.ts";

/** Wire APIs a configured provider can speak. Implementations load on first request. */
export const apis = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
  "mistral-conversations": mistralConversationsApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "pi-messages": piMessagesApi,
} satisfies Record<string, () => ProviderStreams>;

export const ApiId = Schema.Literal(...(Object.keys(apis) as (keyof typeof apis)[]));
export type ApiId = typeof ApiId.Type;

const Cost = Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number });
/** pi-ai's per-API `compat` flags (e.g. `supportsDeveloperRole: false` for Ollama); passed through unchecked. */
const Compat = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const CustomModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  input: Schema.optional(Schema.Array(Schema.Literal("text", "image"))),
  contextWindow: Schema.optional(Schema.Number.pipe(Schema.positive())),
  maxTokens: Schema.optional(Schema.Number.pipe(Schema.positive())),
  /** USD per million tokens. */
  cost: Schema.optional(Cost),
  /** pi thinking level → provider value; `null` marks a level unsupported. */
  thinkingLevelMap: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.String) })),
  compat: Schema.optional(Compat),
});
export type CustomModel = typeof CustomModel.Type;

export const CustomProvider = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[^/]+$/)),
  name: Schema.optional(Schema.String),
  api: ApiId,
  baseUrl: Schema.String,
  /** A literal key or an environment variable. Omit both for keyless local servers. */
  apiKey: Schema.optional(Schema.Struct({ env: Schema.optional(Schema.String), value: Schema.optional(Schema.String) })),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Applied to every model; a model's own `compat` wins per field. */
  compat: Schema.optional(Compat),
  models: Schema.Array(CustomModel),
  /** Its logo, as SVG markup, for clients to show (`Llm.setLogo`). */
  logo: Schema.optional(Schema.String),
});

/**
 * The config entry for a provider the user adds: its id from its name, unique
 * among `taken`; its key, when it needs one, asked for at login or read from
 * `<ID>_API_KEY`. Undefined for an unknown wire API.
 */
export function customEntry(spec: CustomProviderSpec, taken: ReadonlySet<string>): CustomProvider | undefined {
  if (!Object.hasOwn(apis, spec.api)) return undefined;
  const base =
    spec.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return {
    id,
    name: spec.name.trim(),
    api: spec.api as ApiId,
    baseUrl: spec.baseUrl.trim().replace(/\/+$/, ""),
    models: [...new Set(spec.models)].map((model) => ({ id: model })),
    ...(spec.key === true ? { apiKey: { env: `${id.toUpperCase().replace(/-/g, "_")}_API_KEY` } } : {}),
  };
}
export type CustomProvider = typeof CustomProvider.Type;

/**
 * A provider Lemma offers: how it authenticates (Lemma's own logins), its models, and how a request is sent (pi-ai's
 * wire API for the model, by default).
 */
export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: ProviderAuth;
  readonly catalog: Catalog;
  /** Headers a request adds for a session (OpenCode routes a conversation by it). */
  readonly headers?: (sessionId: string | undefined) => Readonly<Record<string, string>> | undefined;
  /** Sends a request; by default through `apis[model.api]`. */
  readonly stream?: (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) => AssistantMessageEventStream;
  /** The user's entry, for a provider they added. */
  readonly custom?: CustomProvider;
  /** Its catalog follows models.dev (`withLiveCatalog`); absent for one that keeps its own list current, or none. */
  readonly live?: LiveOptions;
  /** The id pi-ai knows its models by, when it differs: pi-ai shapes OpenAI's requests for `openai` alone. */
  readonly piProvider?: string;
}

/** OpenCode routes the requests of one conversation together by this header. */
const openCodeSession = (sessionId: string | undefined) => (sessionId === undefined ? undefined : { "x-opencode-session": sessionId });

/** What ChatGPT plans serve, as pi-ai knows them: the OpenAI catalog until a plan's own list is read. */
const usualPlan = Object.values(OPENAI_CODEX_MODELS).map((model) => ({
  slug: model.id,
  display_name: model.name,
  visibility: "list",
  context_window: model.contextWindow,
}));

/**
 * The providers Lemma offers built in. OpenAI is two: `openai` signs in with a ChatGPT plan (`chatgpt`) and lists the
 * plan's models (from `plan`, when given), and `openai-api` uses an API key and lists the API's.
 */
export function builtinProviders(chatgpt: OAuthMethod, plan?: PlanSource): LlmProvider[] {
  const openai = Object.values(OPENAI_MODELS);
  return [
    {
      id: "openai",
      name: "OpenAI",
      auth: { oauth: chatgpt },
      catalog: planCatalog(openai, usualPlan, plan),
    },
    {
      id: "openai-api",
      name: "OpenAI API",
      auth: { apiKey: "OpenAI API key", env: ["OPENAI_API_KEY"] },
      catalog: fixedCatalog(openai.map((model) => ({ ...model, provider: "openai-api" }))),
      live: { devId: "openai", listUrl: "https://api.openai.com/v1", listComplete: true },
      piProvider: "openai",
    },
    {
      id: "opencode",
      name: "OpenCode Zen",
      auth: { apiKey: "OpenCode API key", env: ["OPENCODE_API_KEY"] },
      catalog: fixedCatalog(Object.values(OPENCODE_MODELS)),
      headers: openCodeSession,
      live: {},
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      auth: { apiKey: "OpenCode API key", env: ["OPENCODE_API_KEY"] },
      catalog: fixedCatalog(Object.values(OPENCODE_GO_MODELS)),
      headers: openCodeSession,
      live: {},
    },
  ];
}

/**
 * A request as pi-ai should see it for a provider it knows by another id (`piProvider`). pi-ai reuses an assistant
 * turn's reasoning and tool-call items only when the turn's provider is the model's: this provider's own turns are
 * relabelled as pi-ai's, and other turns under that id (a ChatGPT sign-in's, for `openai-api`) are kept apart, since
 * another credential was issued their reasoning.
 */
export function forPi(provider: LlmProvider, model: Model<Api>, context: TranscriptContext): { model: Model<Api>; context: TranscriptContext } {
  const as = provider.piProvider;
  if (as === undefined || as === provider.id) return { model, context };
  const messages = context.messages.map((message) =>
    message.role !== "assistant"
      ? message
      : message.provider === provider.id
        ? { ...message, provider: as }
        : message.provider === as
          ? { ...message, provider: `lemma:${as}` }
          : message,
  );
  return { model: { ...model, provider: as }, context: { ...context, messages } };
}

export function selectProviders<P extends { readonly id: string }>(
  providers: readonly P[],
  filter: { readonly include?: readonly string[] | undefined; readonly exclude?: readonly string[] | undefined },
): P[] {
  const include = filter.include === undefined ? undefined : new Set(filter.include);
  const exclude = new Set(filter.exclude ?? []);
  return providers.filter((provider) => (include === undefined || include.has(provider.id)) && !exclude.has(provider.id));
}

/**
 * A stored key first (from `/login`), then the configured one. Without a configured key the provider counts as
 * keyless: OpenAI-compatible SDKs refuse an empty key, so a placeholder is sent, which local servers ignore.
 */
function customAuth(config: CustomProvider, name: string): ProviderAuth {
  const { env, value } = config.apiKey ?? {};
  return {
    apiKey: `${name} API key`,
    ...(value !== undefined
      ? { key: { token: value, source: "config" } }
      : env !== undefined
        ? { env: [env] }
        : { key: { token: "unused", source: "no key required" } }),
  };
}

/** Defaults follow pi's models.json: 128k context, 16k output, text only, free. */
export function customModel(config: CustomProvider, model: CustomModel): Model<Api> {
  const compat = config.compat === undefined && model.compat === undefined ? undefined : { ...config.compat, ...model.compat };
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: config.api,
    provider: config.id,
    baseUrl: config.baseUrl,
    reasoning: model.reasoning ?? false,
    input: [...(model.input ?? ["text"])],
    cost: model.cost === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { ...model.cost },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    // pi-ai's wire APIs send a model's headers with each request.
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    ...(compat === undefined ? {} : { compat: compat as NonNullable<Model<Api>["compat"]> }),
  };
}

export function customProvider(config: CustomProvider): LlmProvider {
  const name = config.name ?? config.id;
  return {
    id: config.id,
    name,
    auth: customAuth(config, name),
    catalog: fixedCatalog(config.models.map((model) => customModel(config, model))),
    custom: config,
  };
}
