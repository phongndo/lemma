import type { CatalogClassifier } from "./classify.ts";
import { thinkingFormat } from "./completions.ts";
import type { CatalogImageModel } from "./images.ts";
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
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
    /** Higher prices from a size on: a `context` tier's apply to a request of more than `size` tokens. */
    readonly tiers?: readonly { readonly tier?: { readonly type?: string; readonly size?: unknown } }[];
  };
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
 * How a server is asked for thinking beyond the efforts a model names: `effort`, by those alone (OpenAI's formats have
 * no switch); `switch`, also by a switch every model there has (DeepSeek's `thinking`, whatever models.dev lists);
 * `any`, by any effort, which the server turns into a budget for a model thinking in one, and stopped at `none`
 * (OpenRouter's).
 */
export type Asking = "effort" | "switch" | "any";

/** The efforts a model asked by any (`any`) takes where models.dev names none: those every reasoning model takes (OpenAI's o-series refuses `minimal`). */
const ANY_EFFORTS: readonly string[] = ["low", "medium", "high"];

/**
 * How a model on `api` is asked to think, from models.dev's options. Anthropic's adaptive thinking is the one with a
 * `max` effort (every Claude model agrees); its other thinking models, and those speaking its protocol, think in a
 * token budget. A model that only turns thinking on and off has no level to pick where its server is asked by efforts
 * it names, and every effort where it takes any. Off is a level only for a model that can stop thinking: one its
 * provider says must reason (`mustThink`) cannot, whatever models.dev says, nor can one whose least budget is more
 * than none.
 */
export function thinkingOf(api: WireApi, options: DevModel["reasoning_options"], asking: Asking, mustThink = false): Thinking | undefined {
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
  const leastBudget = typeof budgeted?.min === "number" && budgeted.min > 0;
  // Elsewhere it stops by a switch, its own or its server's, or at a budget of none.
  const switched = toggle || asking === "switch";
  const stops = !mustThink && (switched || (budget && !leastBudget));
  // One that must reason has no `none` to stop at either.
  if (effort.length > 0) return effortThinking(mustThink ? effort.filter((value) => value !== "none") : effort, switched && stops);
  // Taking any effort, it stops unless it must reason: an `off` with no value, as models.dev names none, which OpenRouter's
  // requests say as its `none` (a server of another format borrowing the entry says nothing).
  if (asking === "any") return effortThinking(ANY_EFFORTS, !mustThink && !leastBudget);
  return asking === "switch" ? { kind: "toggle", levels: stops ? ["off", "high"] : ["high"] } : undefined;
}

/**
 * Claude models whose API takes `thinking: disabled` though models.dev lists no switch for them: Opus 4.7 and 4.8, and
 * Opus 5 at an effort of `high` or below, its default.
 */
const CLAUDE_STOPS: ReadonlySet<string> = new Set(["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5"]);

/** How a provider's models are placed in its catalog. */
export interface Placing {
  /** Whether it serves a wire API. */
  readonly serves: (api: WireApi) => boolean;
  /** How its server is asked for a model's thinking. */
  readonly asking: (api: WireApi, id: string) => Asking;
  /** The models it says must reason. */
  readonly mustThink?: ReadonlySet<string>;
  /** Its models fill their context window only up to the size at which their price rises (models.dev's `tiers`). */
  readonly windowAtPriceTier?: boolean;
}

/**
 * models.dev's chat models of a provider, on the wire APIs it serves, each as the catalog keeps it. A model without
 * tool calls, or making no text, is not one an agent can use.
 */
export function fromDev(dev: DevProvider, placing: Placing): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const [id, info] of Object.entries(dev.models)) {
    const api = API_OF_NPM[info.provider?.npm ?? dev.npm ?? ""];
    if (api === undefined || !placing.serves(api) || info.tool_call === false) continue;
    if (info.modalities?.output !== undefined && !info.modalities.output.includes("text")) continue;
    const reasoning = info.reasoning === true;
    const options = api === "anthropic-messages" && CLAUDE_STOPS.has(id) ? [...(info.reasoning_options ?? []), { type: "toggle" }] : info.reasoning_options;
    const thinking = reasoning ? thinkingOf(api, options, placing.asking(api, id), placing.mustThink?.has(id)) : undefined;
    const window = info.limit?.context ?? 128_000;
    const tiers =
      placing.windowAtPriceTier === true
        ? (info.cost?.tiers ?? []).flatMap((tier) => (tier.tier?.type === "context" && typeof tier.tier.size === "number" ? [tier.tier.size] : []))
        : [];
    models.push({
      id,
      name: info.name ?? id,
      api,
      input: info.modalities?.input?.includes("image") === true ? ["text", "image"] : ["text"],
      contextWindow: Math.min(window, ...tiers),
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
 * Providers whose models fill their context window only up to where their price rises: OpenAI's, which bills a request
 * over 272k tokens at double (the Codex CLI and pi keep to 272k too), so a session compacts before its requests cost
 * more.
 */
const WINDOW_AT_PRICE_TIER: ReadonlySet<string> = new Set(["openai"]);

/**
 * `provider`'s models as models.dev lists them (`dev`), on the wire APIs it serves, those it says must reason
 * (`mustThink`, from `mustThinkSource`) never asked to stop. A model that only turns thinking on and off has a level
 * to pick where the protocol has a switch (DeepSeek's) or takes any effort (OpenRouter's); OpenAI's Chat Completions
 * format has neither.
 */
export const catalogOf = (
  provider: { readonly id: string; readonly apis: Readonly<Partial<Record<WireApi, string>>> },
  dev: DevProvider,
  mustThink?: ReadonlySet<string>,
): CatalogModel[] =>
  fromDev(dev, {
    serves: (api) => provider.apis[api] !== undefined,
    asking: (api, id) => {
      if (api !== "openai-completions") return "effort";
      const format = thinkingFormat({ provider: provider.id, baseUrl: provider.apis[api] ?? "", id });
      return format === "openrouter" ? "any" : format === "deepseek" ? "switch" : "effort";
    },
    ...(mustThink === undefined ? {} : { mustThink }),
    windowAtPriceTier: WINDOW_AT_PRICE_TIER.has(provider.id),
  });

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

/**
 * Each provider's `MUST_THINK_LISTS` list over the network, read at most once an hour: none for a provider without
 * one, and undefined while it is out of reach, as a catalog read without it would ask its models to stop.
 */
export function mustThinkSource(fetchImpl: typeof fetch): (provider: string, signal: AbortSignal) => Promise<ReadonlySet<string> | undefined> {
  const cached = new Map<string, { at: number; ids: Promise<ReadonlySet<string> | undefined> }>();
  return (provider, signal) => {
    const url = MUST_THINK_LISTS[provider];
    if (url === undefined) return Promise.resolve(new Set());
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

/** OpenRouter's list of its models answering in any modality, not only text: its classifiers and image models among them. */
export const OPENROUTER_ALL = "https://openrouter.ai/api/v1/models?output_modalities=all";

/** A provider's classifier and image models, as `nonchat.json` keeps them. */
export interface Nonchat {
  readonly classifiers: readonly CatalogClassifier[];
  readonly images: readonly CatalogImageModel[];
}

/** The parts of an OpenRouter model this reads. */
interface RouterModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly context_length?: unknown;
  readonly architecture?: { readonly input_modalities?: unknown; readonly output_modalities?: unknown };
  readonly pricing?: Readonly<Record<string, unknown>>;
}

/**
 * OpenRouter's classifiers (the models answering in `decisions`) and image models, from its list (`OPENROUTER_ALL`);
 * undefined for a list that is not one. Its prices are USD a token, as strings, and -1 for a router's that vary.
 */
export function openrouterNonchat(list: unknown): Nonchat | undefined {
  const data = (list as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const modalities = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const perMillion = (value: unknown) => {
    const perToken = typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
    return Number.isFinite(perToken) && perToken > 0 ? Math.round(perToken * 1e12) / 1e6 : 0;
  };
  const classifiers: CatalogClassifier[] = [];
  const images: CatalogImageModel[] = [];
  for (const entry of data as readonly (RouterModel | null)[]) {
    if (typeof entry?.id !== "string") continue;
    const name = typeof entry.name === "string" ? entry.name : entry.id;
    const output = modalities(entry.architecture?.output_modalities);
    const cost = { input: perMillion(entry.pricing?.prompt), output: perMillion(entry.pricing?.completion) };
    if (output.includes("decisions")) {
      // System One, as OpenRouter serves it, takes no images, whatever the model would. A context of 0 is one its
      // listing does not name.
      const context = typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : 0;
      classifiers.push({ id: entry.id, name, input: ["text"], contextWindow: context, cost });
    } else if (output.includes("image")) {
      const input = modalities(entry.architecture?.input_modalities).filter((item) => item === "text" || item === "image");
      images.push({
        id: entry.id,
        name,
        input: input.includes("text") ? input : ["text", ...input],
        output: output.includes("text") ? ["image", "text"] : ["image"],
        cost: { ...cost, cacheRead: perMillion(entry.pricing?.input_cache_read), cacheWrite: perMillion(entry.pricing?.input_cache_write) },
      });
    }
  }
  const byId = (a: { readonly id: string }, b: { readonly id: string }) => a.id.localeCompare(b.id);
  return { classifiers: classifiers.sort(byId), images: images.sort(byId) };
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
