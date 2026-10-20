import { randomUUID } from "node:crypto";
import type { Effect } from "effect";
import { ThinkingLevel } from "@lemma/llm";
import type { CustomProviderSpec, LlmRequest, ProviderModelSpec, ProviderSpec } from "@lemma/llm";
import type { InteractionError, NoticePayload } from "@lemma/contracts";
import snapshot from "./catalog.json" with { type: "json" };
import { catalogOf } from "./catalog.ts";
import type { DevProvider, Nonchat } from "./catalog.ts";
import type { Classifier } from "./classify.ts";
import type { ImageModel } from "./images.ts";
import nonchatSnapshot from "./nonchat.json" with { type: "json" };
import { chatgpt } from "./chatgpt.ts";
import { copilot, copilotHeaders } from "./copilot.ts";
import { kimi } from "./kimi.ts";
import { meta } from "./meta.ts";
import { openrouter } from "./openrouter.ts";
import { xai } from "./xai.ts";
import { thinkingFormat } from "./completions.ts";
import type { ThinkingFormat } from "./completions.ts";
import { ENDPOINTS } from "./endpoints.ts";
import { WIRES } from "./request.ts";
import type { Endpoint } from "./endpoints.ts";
import { BUDGET_LEVELS, WIRE_APIS } from "./model.ts";
import type { CatalogModel, Model, Thinking, WireApi } from "./model.ts";
import type { Auth } from "./wire.ts";

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
  /** Which sign-in it is (`chatgpt`), for what only it does (a ChatGPT plan refuses some request fields). */
  readonly id: string;
  /** As `ProviderInfo.auth` names it: "Sign in with ChatGPT". */
  readonly name: string;
  /** Runs the flow; interrupting it withdraws its open question. */
  readonly login: (context: LoginContext) => Effect.Effect<OAuthCredential, unknown>;
  /** A new access token for `credential`, once it has expired. */
  readonly refresh: (credential: OAuthCredential, fetchImpl: typeof globalThis.fetch, signal: AbortSignal) => Promise<OAuthCredential>;
  /** Where its requests go, when the account names its own host (Copilot's token does): the provider's otherwise. */
  readonly baseUrl?: (credential: OAuthCredential) => string | undefined;
  /**
   * The models an account signed in this way may use, from the provider's catalog (`known`), asked with its access:
   * a ChatGPT plan's, a Copilot account's. Undefined when they cannot be read, and the list it had stands.
   */
  readonly models?: (known: readonly Model[], auth: Auth, fetchImpl: typeof globalThis.fetch, signal: AbortSignal) => Promise<readonly Model[] | undefined>;
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
  /** False: `/login` does not offer a key, as the provider takes none it can be given (Copilot signs in). */
  readonly login?: false;
}

/** A provider as this plugin serves it. Its `models` change as its catalog refreshes. */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly apiKey: ApiKeyMethod;
  readonly oauth?: OAuthMethod;
  /** Headers each of its requests sends beside the model's own, given the request. */
  readonly headers?: (request: LlmRequest) => Record<string, string>;
  /** The base URL of each wire API it serves its models on; a refresh leaves out a model on any other. */
  readonly apis: Readonly<Partial<Record<WireApi, string>>>;
  /** Its catalog is models.dev's provider of this id (or `catalog`), refreshed live. */
  readonly live: boolean;
  /** models.dev's id for it, where that is not its own. */
  readonly catalog?: string;
  /** Its Responses API also speaks OpenAI's WebSocket mode. */
  readonly webSocket?: boolean;
  models: readonly Model[];
  /** Its classifier models (`classify.ts`). */
  readonly classifiers: readonly Classifier[];
  /** Its image models (`images.ts`). */
  readonly images: readonly ImageModel[];
}

/** What a built-in provider is: its endpoints, how else it is signed in to, and its models in the snapshot. */
export interface BuiltinProvider extends Endpoint {
  readonly oauth?: OAuthMethod;
  /** Its Responses API also speaks OpenAI's WebSocket mode (`socket.ts`), which the `webSocket` config turns on. */
  readonly webSocket?: boolean;
  readonly headers?: (request: LlmRequest) => Record<string, string>;
  /** Its models before a live catalog is read. */
  readonly models: readonly CatalogModel[];
  /** The classifier and image models it lists, where it serves them (`nonchat.json`); `classifiers.models` are kept by hand. */
  readonly nonchat?: Nonchat;
}

const catalog = snapshot as unknown as Readonly<Record<string, readonly CatalogModel[]>>;
const nonchat = nonchatSnapshot as unknown as Readonly<Record<string, Nonchat>>;

/** OpenCode routes a conversation's requests by its session, and refuses a request without one. */
const opencodeSession = (request: LlmRequest) => ({ "x-opencode-session": request.sessionId ?? randomUUID() });

/** What each built-in provider adds to its endpoints: a sign-in, the headers its requests need. */
const extras: Readonly<Record<string, Pick<BuiltinProvider, "oauth" | "headers" | "webSocket">>> = {
  openai: { oauth: chatgpt, webSocket: true },
  openrouter: { oauth: openrouter },
  xai: { oauth: xai },
  "github-copilot": { oauth: copilot, headers: copilotHeaders },
  "kimi-coding": { oauth: kimi },
  meta: { oauth: meta },
  opencode: { headers: opencodeSession },
  "opencode-go": { headers: opencodeSession },
};

/** The providers this plugin knows, with this version's catalog of each. */
export const builtinProviders = (): BuiltinProvider[] =>
  ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    ...extras[endpoint.id],
    models: catalog[endpoint.id] ?? [],
    ...(nonchat[endpoint.id] === undefined ? {} : { nonchat: nonchat[endpoint.id] }),
  }));

/**
 * A catalog's `model` offering `off` only where its protocol can say it (`Wire.saysOff`), whatever made its levels:
 * asked at an `off` it cannot say, it would think while its user is told it does not. A model of the user's keeps
 * the `off` its config gives it, which on OpenAI's format with no value leaves thinking to the server, as pi's do.
 */
function sayable(model: Model): Model {
  const thinking = model.thinking;
  if (thinking === undefined || !thinking.levels.includes("off") || WIRES[model.api].saysOff(model)) return model;
  return { ...model, thinking: { ...thinking, levels: thinking.levels.filter((level) => level !== "off") } };
}

/** `models` placed at `provider`: each at the base URL of its protocol there, those on another left out. */
export const placed = (provider: Pick<Provider, "id" | "apis">, models: readonly CatalogModel[]): Model[] =>
  models.flatMap((model) => {
    const baseUrl = provider.apis[model.api];
    return baseUrl === undefined ? [] : [sayable({ ...model, provider: provider.id, baseUrl })];
  });

/** Classifier or image `models` at `provider`, on the protocol and base URL it serves them at (`where`); none where it serves none. */
const placedAt = <Api extends string, M extends object>(
  provider: string,
  where: { readonly api: Api; readonly baseUrl: string } | undefined,
  models: readonly M[] | undefined,
): (M & { readonly provider: string; readonly api: Api; readonly baseUrl: string })[] =>
  where === undefined ? [] : (models ?? []).map((model) => ({ ...model, provider, api: where.api, baseUrl: where.baseUrl }));

/** A built-in provider, served. */
export const builtin = (definition: BuiltinProvider): Provider => ({
  id: definition.id,
  name: definition.name,
  apiKey: { name: `${definition.name} API key`, env: definition.env, ...(definition.keyLogin === false ? { login: false as const } : {}) },
  ...(definition.catalog === undefined ? {} : { catalog: definition.catalog }),
  ...(definition.oauth === undefined ? {} : { oauth: definition.oauth }),
  ...(definition.headers === undefined ? {} : { headers: definition.headers }),
  apis: definition.apis,
  live: true,
  ...(definition.webSocket === true ? { webSocket: true } : {}),
  models: placed(definition, definition.models),
  classifiers: placedAt(definition.id, definition.classifiers, definition.classifiers?.models ?? definition.nonchat?.classifiers),
  images: placedAt(definition.id, definition.images, definition.nonchat?.images),
});

/** `provider`'s models as models.dev lists them now, at its base URLs; `mustThink` as its own list says. */
export const liveModels = (provider: Pick<Provider, "id" | "apis">, dev: DevProvider, mustThink?: ReadonlySet<string>): Model[] =>
  placed(provider, catalogOf(provider, dev, mustThink));

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

/** The catalog's models by wire API and id, the first provider's where several serve one: what a model of the user's that is one of them is. */
const known = new Map<string, CatalogModel>();
for (const models of Object.values(catalog))
  for (const model of models) if (!known.has(`${model.api} ${model.id}`)) known.set(`${model.api} ${model.id}`, model);

/** How a protocol's model thinks when nothing says otherwise: Anthropic's in a budget (adaptively with pi's `forceAdaptiveThinking`), the others by an effort. */
function protocolThinking(api: WireApi, compat: Readonly<Record<string, unknown>> | undefined): Thinking {
  if (api === "anthropic-messages")
    return compat?.forceAdaptiveThinking === true ? { kind: "effort", levels: ["low", "medium", "high"] } : { kind: "budget", levels: BUDGET_LEVELS };
  return { kind: "effort", levels: LEVELS_UP_TO_HIGH, ...(api === "openai-responses" ? { values: { off: "none" } } : {}) };
}

/**
 * How a model of the user's thinks: as the catalog says for a model it knows on the protocol (a proxy serving Claude
 * Sonnet 5.5 is asked as Anthropic would be), where its server can ask so, else as the protocol's do
 * (`protocolThinking`); its `thinkingLevelMap` then adjusts that, never replacing how it is asked: a level mapped to
 * `null` is one it lacks, one mapped to a value is one it takes, sent as that value. A Chat Completions server whose
 * config says it takes no reasoning effort has no level to set.
 */
function customThinking(
  api: WireApi,
  map: ProviderModelSpec["thinkingLevelMap"],
  compat: Readonly<Record<string, unknown>> | undefined,
  catalogued: CatalogModel | undefined,
  format: ThinkingFormat | undefined,
): Thinking | undefined {
  if (api === "openai-completions" && compat?.supportsReasoningEffort === false) return undefined;
  // The config's word that an Anthropic model thinks adaptively wins over the catalog's.
  const adaptive = api === "anthropic-messages" && compat?.forceAdaptiveThinking === true;
  const known = adaptive && catalogued?.thinking?.kind !== "effort" ? undefined : catalogued?.thinking;
  // A switch only where the server's format has one: OpenAI's `reasoning_effort` has none, so a model the catalog
  // has toggling behind OpenRouter is asked by an effort on such a server.
  const base = (known?.kind === "toggle" && format === "openai" ? undefined : known) ?? protocolThinking(api, compat);
  if (map === undefined) return base;
  const values: Partial<Record<ThinkingLevel, string>> = { ...base.values };
  for (const [level, value] of Object.entries(map)) if (typeof value === "string") values[level as ThinkingLevel] = value;
  const levels = ThinkingLevel.literals.filter((level) => map[level] !== null && (base.levels.includes(level) || typeof map[level] === "string"));
  return { kind: base.kind, levels, ...(Object.keys(values).length === 0 ? {} : { values }) };
}

/** Defaults follow pi's `models.json`, as configs written for it do: 128k context, 16k output, text only, free. */
function customModel(config: CustomProvider, model: ProviderModelSpec): Model {
  const compat = config.compat === undefined && model.compat === undefined ? undefined : { ...config.compat, ...model.compat };
  const reasoning = model.reasoning ?? false;
  const catalogued = known.get(`${config.api} ${model.id}`);
  const format =
    config.api === "openai-completions"
      ? thinkingFormat({ provider: config.id, baseUrl: config.baseUrl, id: model.id, ...(compat === undefined ? {} : { compat }) })
      : undefined;
  const thinking = reasoning ? customThinking(config.api, model.thinkingLevelMap, compat, catalogued, format) : undefined;
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
    // A model the catalog knows refuses a temperature there as here.
    ...(catalogued?.temperature === false ? { temperature: false } : {}),
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(compat === undefined ? {} : { compat }),
  };
}

/** A provider of the user's, or one a plugin adds: keyed as its config says, keyless without an `apiKey`. */
export function customProvider(entry: CustomProvider): Provider {
  // Its protocol's paths follow the base URL: `/v1/` and `/v1` are one server.
  const config = { ...entry, baseUrl: entry.baseUrl.replace(/\/+$/, "") };
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
    classifiers: [],
    images: [],
  };
}
