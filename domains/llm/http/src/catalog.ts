import { thinkingFormat } from "./completions.ts";
import { USER_AGENT } from "./identity.ts";
import { BUDGET_LEVELS, effortThinking } from "./model.ts";
import type { CatalogModel, Model, Thinking, WireApi } from "./model.ts";

/**
 * Model catalogs from [models.dev](https://models.dev): the committed snapshot (`catalog.json`, which
 * `scripts/catalog.ts` writes) and the live one each refresh reads. A built-in provider's models are models.dev's,
 * those on a wire API it serves this plugin speaks: their limits, prices, inputs, and how each is asked to think.
 */

/** The parts of a models.dev model this reads. */
export interface DevModel {
  readonly name?: string;
  readonly reasoning?: boolean;
  /** How it is asked to think: a named effort, a token budget, or on and off. */
  readonly reasoning_options?: readonly { readonly type?: string; readonly values?: readonly unknown[]; readonly min?: unknown }[];
  /** False: it refuses a temperature. */
  readonly temperature?: boolean;
  readonly tool_call?: boolean;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly cost?: { readonly input?: number; readonly output?: number; readonly cache_read?: number; readonly cache_write?: number };
  /** Per-model override of the provider's SDK package, which names its wire API. */
  readonly provider?: { readonly npm?: string };
}

/** The parts of a models.dev provider this reads. */
export interface DevProvider {
  readonly npm?: string;
  readonly models: Readonly<Record<string, DevModel>>;
}

export type DevCatalog = Readonly<Record<string, DevProvider>>;

/** models.dev names a model's wire API by the AI SDK package that speaks it. */
const API_OF_NPM: Readonly<Record<string, WireApi>> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-completions",
  "@openrouter/ai-sdk-provider": "openai-completions",
};

/**
 * How a model on `api` is asked to think, from models.dev's options. Anthropic's adaptive thinking is the one with a
 * `max` effort (every Claude model agrees); its other thinking models, and those speaking its protocol, think in a
 * token budget. A model that only turns thinking on and off has no level to pick where its protocol has no switch
 * (`toggles`: OpenAI's `reasoning_effort` has none). Off is a level only for a model that can stop thinking: one its
 * provider says must reason (`mustThink`) cannot, whatever models.dev says, nor can one whose least budget is more
 * than none.
 */
export function thinkingOf(api: WireApi, options: DevModel["reasoning_options"], toggles: boolean, mustThink = false): Thinking | undefined {
  const effort = options?.find((option) => option.type === "effort")?.values?.filter((value): value is string => typeof value === "string") ?? [];
  const toggle = options?.some((option) => option.type === "toggle") ?? false;
  const budgeted = options?.find((option) => option.type === "budget_tokens");
  const budget = budgeted !== undefined;
  if (api === "anthropic-messages") {
    // Off is a level only for a model that can stop thinking (one that also thinks in a budget, as Claude 4.6, or that
    // toggles): it is sent `disabled`, which the models that always think refuse.
    if (effort.includes("max")) return effortThinking(effort, toggle || budget);
    if (budget) return { kind: "budget", levels: BUDGET_LEVELS };
    return toggle ? { kind: "toggle", levels: ["off", "high"] } : undefined;
  }
  // Elsewhere it stops by its switch, or at a budget of none.
  const stops = !mustThink && (toggle || (budget && !(typeof budgeted.min === "number" && budgeted.min > 0)));
  if (effort.length > 0) return effortThinking(effort, toggle && stops);
  return (toggle || budget) && toggles ? { kind: "toggle", levels: stops ? ["off", "high"] : ["high"] } : undefined;
}

/**
 * models.dev's chat models of a provider, on the wire APIs it serves (`serves`), each as the catalog keeps it. A
 * model without tool calls, or making no text, is not one an agent can use.
 */
export function fromDev(
  dev: DevProvider,
  serves: (api: WireApi) => boolean,
  toggles: (api: WireApi, id: string) => boolean,
  mustThink: ReadonlySet<string> = new Set(),
): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const [id, info] of Object.entries(dev.models)) {
    const api = API_OF_NPM[info.provider?.npm ?? dev.npm ?? ""];
    if (api === undefined || !serves(api) || info.tool_call === false) continue;
    if (info.modalities?.output !== undefined && !info.modalities.output.includes("text")) continue;
    const reasoning = info.reasoning === true;
    const thinking = reasoning ? thinkingOf(api, info.reasoning_options, toggles(api, id), mustThink.has(id)) : undefined;
    models.push({
      id,
      name: info.name ?? id,
      api,
      input: info.modalities?.input?.includes("image") === true ? ["text", "image"] : ["text"],
      contextWindow: info.limit?.context ?? 128_000,
      maxTokens: info.limit?.output ?? 16_384,
      cost: { input: info.cost?.input ?? 0, output: info.cost?.output ?? 0, cacheRead: info.cost?.cache_read ?? 0, cacheWrite: info.cost?.cache_write ?? 0 },
      reasoning,
      ...(thinking === undefined ? {} : { thinking }),
      ...(info.temperature === false ? { temperature: false } : {}),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * `provider`'s models as models.dev lists them (`dev`), on the wire APIs it serves, those it says must reason
 * (`mustThink`, from `mustThinkSource`) never asked to stop. A model that only turns thinking on and off has a level
 * to pick where the protocol has a switch: OpenAI's Chat Completions has none, but OpenRouter's and DeepSeek's do.
 */
export const catalogOf = (
  provider: { readonly id: string; readonly apis: Readonly<Partial<Record<WireApi, string>>> },
  dev: DevProvider,
  mustThink?: ReadonlySet<string>,
): CatalogModel[] =>
  fromDev(
    dev,
    (api) => provider.apis[api] !== undefined,
    (api, id) => api !== "openai-completions" || thinkingFormat({ provider: provider.id, baseUrl: provider.apis[api] ?? "", id }) !== "openai",
    mustThink,
  );

/** `url`'s JSON, as Lemma asks for it, given up on after 20 seconds; rejects on an HTTP error. */
export const fetchJson = async (fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
  const response = await fetchImpl(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

export const MODELS_DEV = "https://models.dev/api.json";
/** How long one read of models.dev serves every provider's refresh. */
const DEV_TTL = 60 * 60 * 1000;

/** models.dev over the network, read at most once an hour for every provider; undefined while out of reach. */
export function devSource(fetchImpl: typeof fetch): (signal: AbortSignal) => Promise<DevCatalog | undefined> {
  let cached: { at: number; catalog: Promise<DevCatalog | undefined> } | undefined;
  return (signal) => {
    if (cached === undefined || Date.now() - cached.at > DEV_TTL) {
      const catalog = fetchJson(fetchImpl, MODELS_DEV, {}, signal).then(
        (value) => (typeof value === "object" && value !== null ? (value as DevCatalog) : undefined),
        () => undefined,
      );
      cached = { at: Date.now(), catalog };
      // A failed read is tried again on the next refresh.
      void catalog.then((value) => {
        if (value === undefined && cached?.catalog === catalog) cached = undefined;
      });
    }
    return cached.catalog;
  };
}

/**
 * Where a provider lists which of its models must reason, refusing a request that turns reasoning off: OpenRouter's
 * list says so (`reasoning.mandatory`) of models models.dev has switching it off.
 */
export const MUST_THINK_LISTS: Readonly<Record<string, string>> = { openrouter: "https://openrouter.ai/api/v1/models" };

/** The ids of the models a provider's list says must reason; undefined for a list that is not one. */
export function mustThinkOf(list: unknown): ReadonlySet<string> | undefined {
  const data = (list as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const ids = data.flatMap((entry: { id?: unknown; reasoning?: { mandatory?: unknown } } | null) =>
    typeof entry?.id === "string" && entry.reasoning?.mandatory === true ? [entry.id] : [],
  );
  return new Set(ids);
}

/** Each provider's `MUST_THINK_LISTS` list over the network, read at most once an hour; undefined for none, or out of reach. */
export function mustThinkSource(fetchImpl: typeof fetch): (provider: string, signal: AbortSignal) => Promise<ReadonlySet<string> | undefined> {
  const cached = new Map<string, { at: number; ids: Promise<ReadonlySet<string> | undefined> }>();
  return (provider, signal) => {
    const url = MUST_THINK_LISTS[provider];
    if (url === undefined) return Promise.resolve(undefined);
    const known = cached.get(provider);
    if (known !== undefined && Date.now() - known.at <= DEV_TTL) return known.ids;
    const ids = fetchJson(fetchImpl, url, {}, signal).then(mustThinkOf, () => undefined);
    cached.set(provider, { at: Date.now(), ids });
    // A failed read is tried again on the next refresh.
    void ids.then((value) => {
      if (value === undefined && cached.get(provider)?.ids === ids) cached.delete(provider);
    });
    return ids;
  };
}

/** The parts of a model this reads from the list `GET /v1/models` answers a ChatGPT sign-in with. */
export interface PlanModel {
  readonly slug: string;
  readonly display_name?: string;
  /** `list` for the models the Codex CLI and app offer; `hide` for the ones they keep out of their pickers. */
  readonly visibility?: string;
  readonly supported_in_api?: boolean;
  readonly context_window?: number;
  readonly input_modalities?: readonly string[];
  readonly supported_reasoning_levels?: readonly unknown[];
}

const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * A ChatGPT plan's models: the ones its list offers, in its order, as the Codex CLI and app show them. A model the
 * API's catalog has keeps its entry; one it does not is served like the known model with the nearest id, described
 * by the list.
 */
export function planModels(known: readonly Model[], listed: readonly PlanModel[]): Model[] {
  if (known.length === 0) return [];
  return listed
    .filter((entry) => entry.visibility === "list" && entry.supported_in_api !== false)
    .map((entry) => {
      const own = known.find((model) => model.id === entry.slug);
      if (own !== undefined) return own;
      const donor = known.reduce((best, model) => (commonPrefix(model.id, entry.slug) > commonPrefix(best.id, entry.slug) ? model : best), known[0]!);
      const levels = entry.supported_reasoning_levels;
      return {
        ...donor,
        id: entry.slug,
        name: entry.display_name ?? entry.slug,
        input: entry.input_modalities === undefined ? donor.input : entry.input_modalities.includes("image") ? ["text", "image"] : ["text"],
        contextWindow: entry.context_window ?? donor.contextWindow,
        reasoning: levels === undefined ? donor.reasoning : levels.length > 0,
      };
    });
}

/**
 * The plan's list leaves out models newer than the Codex client it is told of (Codex's versions, 0.x). Lemma speaks
 * the Responses API, which serves them all, so it asks as a client newer than any.
 */
const PLAN_CLIENT_VERSION = "999.0.0";

/** What a ChatGPT sign-in's plan offers, asked with its access token; undefined when it cannot be read. */
export function planSource(fetchImpl: typeof fetch): (accessToken: string, signal: AbortSignal) => Promise<readonly PlanModel[] | undefined> {
  return async (accessToken, signal) => {
    const url = `https://api.openai.com/v1/models?client_version=${PLAN_CLIENT_VERSION}`;
    const body = (await fetchJson(fetchImpl, url, { authorization: `Bearer ${accessToken}` }, signal).catch(() => undefined)) as
      | { models?: readonly PlanModel[] }
      | undefined;
    return Array.isArray(body?.models) ? body.models.filter((entry) => typeof entry.slug === "string") : undefined;
  };
}
