import type { CustomProviderSpec } from "@lemma/contracts";
import { createProvider } from "@earendil-works/pi-ai";
import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams } from "@earendil-works/pi-ai";
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
 * Anthropic's subscription OAuth (Claude Pro/Max) is excluded by policy; the
 * provider keeps its API-key auth. `createProvider` results are closures, so a
 * shallow copy with a new `auth` is a complete provider.
 */
export function withoutAnthropicOAuth(provider: Provider): Provider {
  if (provider.id !== "anthropic" || provider.auth.oauth === undefined) return provider;
  const { oauth: _oauth, ...auth } = provider.auth;
  return { ...provider, auth };
}

export function selectProviders(
  providers: readonly Provider[],
  filter: { readonly include?: readonly string[] | undefined; readonly exclude?: readonly string[] | undefined },
): Provider[] {
  const include = filter.include === undefined ? undefined : new Set(filter.include);
  const exclude = new Set(filter.exclude ?? []);
  return providers.filter((provider) => (include === undefined || include.has(provider.id)) && !exclude.has(provider.id));
}

/**
 * Stored credential first (from `/login`), then the configured key. Without a
 * configured key the provider counts as keyless: OpenAI-compatible SDKs refuse
 * an empty key, so a placeholder is sent, which local servers ignore.
 */
function customAuth(config: CustomProvider, name: string): ApiKeyAuth {
  return {
    name: `${name} API key`,
    login: async (interaction) => {
      const key = await interaction.prompt({ type: "secret", message: `Enter the ${name} API key` });
      return { type: "api_key", key };
    },
    resolve: async ({ ctx, credential }) => {
      if (credential?.key) {
        return { auth: { apiKey: credential.key }, ...(credential.env === undefined ? {} : { env: credential.env }), source: "stored credential" };
      }
      const { env, value } = config.apiKey ?? {};
      if (value !== undefined) return { auth: { apiKey: value }, source: "config" };
      if (env !== undefined) {
        const key = await ctx.env(env);
        return key ? { auth: { apiKey: key }, source: env } : undefined;
      }
      return { auth: { apiKey: "unused" }, source: "no key required" };
    },
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
    // Model headers are merged into request auth by pi-ai's Models.
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    ...(compat === undefined ? {} : { compat: compat as NonNullable<Model<Api>["compat"]> }),
  };
}

export function customProvider(config: CustomProvider): Provider {
  const name = config.name ?? config.id;
  return createProvider({
    id: config.id,
    name,
    baseUrl: config.baseUrl,
    auth: { apiKey: customAuth(config, name) },
    models: config.models.map((model) => customModel(config, model)),
    api: apis[config.api](),
  });
}
