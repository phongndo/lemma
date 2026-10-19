import { randomUUID } from "node:crypto";
import type { Effect } from "effect";
import type { CustomProviderSpec, ProviderModelSpec, ProviderSpec, ThinkingLevel } from "@lemma/llm";
import type { InteractionError, NoticePayload } from "@lemma/contracts";
import snapshot from "./catalog.json" with { type: "json" };
import { catalogOf } from "./catalog.ts";
import type { DevProvider } from "./catalog.ts";
import { chatgpt } from "./chatgpt.ts";
import { ENDPOINTS } from "./endpoints.ts";
import type { Endpoint } from "./endpoints.ts";
import { BUDGET_LEVELS, WIRE_APIS } from "./model.ts";
import type { CatalogModel, Model, Thinking, WireApi } from "./model.ts";

/** A stored OAuth credential: the shape `Credentials` keeps, its provider's own fields (an issued client id) kept. */
export interface OAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  /** Epoch milliseconds, a little before the token really expires. */
  readonly expires: number;
  readonly [field: string]: unknown;
}

/** What a sign-in flow is given: ways to tell the person and ask them, under its login's origin. */
export interface LoginContext {
  /** Publishes a notice of the login's (a link to open, a code to enter, progress). */
  readonly notify: (notice: Omit<NoticePayload, "level" | "source" | "origin">) => Effect.Effect<void>;
  /** Asks the person something; dismissing it fails the login `Cancelled`. */
  readonly ask: (title: string, options: { readonly placeholder?: string; readonly kind?: "sign-in-code" }) => Effect.Effect<string, InteractionError>;
  /** This installation's stable id (`<home>/device-id`), for a provider that names installations. */
  readonly deviceId: () => string;
  readonly fetch: typeof globalThis.fetch;
}

/** Signing in with an account, as `/login <provider>` offers it beside an API key. */
export interface OAuthMethod {
  /** As `ProviderInfo.auth` names it: "Sign in with ChatGPT". */
  readonly name: string;
  /** Runs the flow; interrupting it withdraws its open question. */
  readonly login: (context: LoginContext) => Effect.Effect<OAuthCredential, unknown>;
  /** A new access token for `credential`, once it has expired. */
  readonly refresh: (credential: OAuthCredential, fetchImpl: typeof globalThis.fetch, signal: AbortSignal) => Promise<OAuthCredential>;
}

/** How a provider takes an API key: stored by `/login`, else from its config or environment. */
export interface ApiKeyMethod {
  /** As `ProviderInfo.auth` names it: "Anthropic API key". */
  readonly name: string;
  /** The environment variables it is read from, in order. */
  readonly env: readonly string[];
  /** A key the config gives itself. */
  readonly value?: string;
  /** It needs none (a local server): a placeholder is sent, since OpenAI-compatible servers refuse an empty key. */
  readonly keyless?: boolean;
}

/** A provider as this plugin serves it. Its `models` change as its catalog refreshes. */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly apiKey: ApiKeyMethod;
  readonly oauth?: OAuthMethod;
  /** Headers each of its requests sends beside the model's own, given the request's session. */
  readonly headers?: (sessionId: string | undefined) => Record<string, string>;
  /** The base URL of each wire API it serves its models on; a refresh leaves out a model on any other. */
  readonly apis: Readonly<Partial<Record<WireApi, string>>>;
  /** Its catalog is models.dev's provider of this id, refreshed live. */
  readonly live: boolean;
  /** Its Responses API also speaks OpenAI's WebSocket mode. */
  readonly webSocket?: boolean;
  models: readonly Model[];
}

/** What a built-in provider is: its endpoints, how else it is signed in to, and its models in the snapshot. */
export interface BuiltinProvider extends Endpoint {
  readonly oauth?: OAuthMethod;
  /** Its Responses API also speaks OpenAI's WebSocket mode (`socket.ts`), which the `webSocket` config turns on. */
  readonly webSocket?: boolean;
  readonly headers?: (sessionId: string | undefined) => Record<string, string>;
  /** Its models before a live catalog is read. */
  readonly models: readonly CatalogModel[];
}

const catalog = snapshot as unknown as Readonly<Record<string, readonly CatalogModel[]>>;

/** OpenCode routes a conversation's requests by its session, and refuses a request without one. */
const opencodeSession = (sessionId: string | undefined) => ({ "x-opencode-session": sessionId ?? randomUUID() });

/** What each built-in provider adds to its endpoints: a sign-in, the headers its requests need. */
const extras: Readonly<Record<string, Pick<BuiltinProvider, "oauth" | "headers" | "webSocket">>> = {
  openai: { oauth: chatgpt, webSocket: true },
  opencode: { headers: opencodeSession },
  "opencode-go": { headers: opencodeSession },
};

/** The providers this plugin knows, with this version's catalog of each. */
export const builtinProviders = (): BuiltinProvider[] =>
  ENDPOINTS.map((endpoint) => ({ ...endpoint, ...extras[endpoint.id], models: catalog[endpoint.id] ?? [] }));

/** `models` placed at `provider`: each at the base URL of its protocol there, those on another left out. */
export const placed = (provider: Pick<Provider, "id" | "apis">, models: readonly CatalogModel[]): Model[] =>
  models.flatMap((model) => {
    const baseUrl = provider.apis[model.api];
    return baseUrl === undefined ? [] : [{ ...model, provider: provider.id, baseUrl }];
  });

/** A built-in provider, served. */
export const builtin = (definition: BuiltinProvider): Provider => ({
  id: definition.id,
  name: definition.name,
  apiKey: { name: `${definition.name} API key`, env: definition.env },
  ...(definition.oauth === undefined ? {} : { oauth: definition.oauth }),
  ...(definition.headers === undefined ? {} : { headers: definition.headers }),
  apis: definition.apis,
  live: true,
  ...(definition.webSocket === true ? { webSocket: true } : {}),
  models: placed(definition, definition.models),
});

/** `provider`'s models as models.dev lists them now, at its base URLs. */
export const liveModels = (provider: Pick<Provider, "id" | "apis">, dev: DevProvider): Model[] => placed(provider, catalogOf(provider, dev));

/** A provider in this plugin's config, or one a plugin adds to `Providers`, on a protocol this plugin speaks. */
export type CustomProvider = ProviderSpec & { readonly api: WireApi };

/**
 * The config entry for a provider the user adds: its id from its name, unique among `taken`; its key, when it needs
 * one, asked for at login or read from `<ID>_API_KEY`. Undefined for a protocol this plugin does not speak.
 */
export function customEntry(spec: CustomProviderSpec, taken: ReadonlySet<string>): CustomProvider | undefined {
  const api = WIRE_APIS.find((known) => known === spec.api);
  if (api === undefined) return undefined;
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
    api,
    baseUrl: spec.baseUrl.trim().replace(/\/+$/, ""),
    models: [...new Set(spec.models)].map((model) => ({ id: model })),
    ...(spec.key === true ? { apiKey: { env: `${id.toUpperCase().replace(/-/g, "_")}_API_KEY` } } : {}),
  };
}

export function selectProviders<P extends { readonly id: string }>(
  providers: readonly P[],
  filter: { readonly include?: readonly string[] | undefined; readonly exclude?: readonly string[] | undefined },
): P[] {
  const include = filter.include === undefined ? undefined : new Set(filter.include);
  const exclude = new Set(filter.exclude ?? []);
  return providers.filter((provider) => (include === undefined || include.has(provider.id)) && !exclude.has(provider.id));
}

const LEVELS_UP_TO_HIGH: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/**
 * How a model of the user's thinks, from its `thinkingLevelMap` (a level's value, `null` for one it lacks): Anthropic's
 * protocol thinks in a budget, the others name an effort, `off` sent as `none` to the Responses API. A Chat Completions
 * server whose config says it takes no reasoning effort has no level to set.
 */
function customThinking(api: WireApi, map: ProviderModelSpec["thinkingLevelMap"], compat: Readonly<Record<string, unknown>> | undefined): Thinking | undefined {
  const kept = (levels: readonly ThinkingLevel[]) => levels.filter((level) => map?.[level] !== null);
  if (api === "anthropic-messages") return { kind: "budget", levels: kept(BUDGET_LEVELS) };
  if (api === "openai-completions" && compat?.supportsReasoningEffort === false) return undefined;
  const extended = (["xhigh", "max"] as const).filter((level) => typeof map?.[level] === "string");
  const values: Partial<Record<ThinkingLevel, string>> = {};
  for (const [level, value] of Object.entries(map ?? {})) if (typeof value === "string") values[level as ThinkingLevel] = value;
  if (api === "openai-responses" && map?.off === undefined) values.off = "none";
  return { kind: "effort", levels: kept([...LEVELS_UP_TO_HIGH, ...extended]), ...(Object.keys(values).length === 0 ? {} : { values }) };
}

/** Defaults follow pi's `models.json`, as configs written for it do: 128k context, 16k output, text only, free. */
function customModel(config: CustomProvider, model: ProviderModelSpec): Model {
  const compat = config.compat === undefined && model.compat === undefined ? undefined : { ...config.compat, ...model.compat };
  const reasoning = model.reasoning ?? false;
  const thinking = reasoning ? customThinking(config.api, model.thinkingLevelMap, compat) : undefined;
  return {
    provider: config.id,
    id: model.id,
    name: model.name ?? model.id,
    api: config.api,
    baseUrl: config.baseUrl,
    input: [...(model.input ?? ["text"])],
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    cost: model.cost === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { ...model.cost },
    reasoning,
    ...(thinking === undefined ? {} : { thinking }),
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(compat === undefined ? {} : { compat }),
  };
}

/** A provider of the user's, or one a plugin adds: keyed as its config says, keyless without an `apiKey`. */
export function customProvider(config: CustomProvider): Provider {
  const name = config.name ?? config.id;
  const { env, value } = config.apiKey ?? {};
  return {
    id: config.id,
    name,
    apiKey: {
      name: `${name} API key`,
      env: env === undefined ? [] : [env],
      ...(value === undefined ? {} : { value }),
      ...(config.apiKey === undefined ? { keyless: true } : {}),
    },
    apis: { [config.api]: config.baseUrl },
    live: false,
    models: config.models.map((model) => customModel(config, model)),
  };
}
