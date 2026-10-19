import { ThinkingLevel } from "@lemma/llm";
import type { ModelInfo } from "@lemma/llm";

/** The wire protocols this plugin speaks, by the ids `ProviderSpec.api` names them with. */
export const WIRE_APIS = ["anthropic-messages", "openai-responses", "openai-completions"] as const;
export type WireApi = (typeof WIRE_APIS)[number];

/** Whether this plugin speaks `api`. */
export const isWireApi = (api: string): api is WireApi => (WIRE_APIS as readonly string[]).includes(api);

/** USD per million tokens. */
export interface Cost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * How a model is asked to think. `effort` names a level (OpenAI's reasoning effort, Anthropic's adaptive thinking);
 * `budget` gives it tokens to think in (Anthropic's earlier models, and those speaking its protocol); `toggle` only
 * turns it on or off.
 */
export interface Thinking {
  readonly kind: "effort" | "budget" | "toggle";
  /** The levels it takes, lowest first, `off` among them when it can stop thinking. */
  readonly levels: readonly ThinkingLevel[];
  /** What a level is sent as where the provider names it otherwise (`off` as `none`). */
  readonly values?: Readonly<Partial<Record<ThinkingLevel, string>>>;
}

/** A chat model as this plugin serves it: where it is, how it is asked, and what it costs. */
export interface Model {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: WireApi;
  readonly baseUrl: string;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: Cost;
  readonly reasoning: boolean;
  readonly thinking?: Thinking;
  /** False: it refuses a `temperature`. */
  readonly temperature?: boolean;
  /** Sent with every request to it. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The wire protocol's settings for it (`openai-completions`'s, in `completions.ts`), as a provider's config gives them. */
  readonly compat?: Readonly<Record<string, unknown>>;
}

/** A model of the committed catalog: what a provider's own fields fill in left out. */
export type CatalogModel = Omit<Model, "provider" | "baseUrl" | "headers" | "compat">;

const LEVELS: readonly ThinkingLevel[] = ThinkingLevel.literals;

export const modelRef = (model: Pick<Model, "provider" | "id">): string => `${model.provider}/${model.id}`;

export function toModelInfo(model: Model): ModelInfo {
  return {
    ref: modelRef(model),
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevels: model.reasoning ? [...(model.thinking?.levels ?? [])] : [],
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { ...model.cost },
  };
}

/**
 * The level a request thinks at on `model`: the one it asks for (none is `off`), else the nearest the model takes,
 * looking up first. Undefined: the model has no thinking to set, and nothing about it is sent.
 */
export function levelFor(model: Model, asked: ThinkingLevel | undefined): ThinkingLevel | undefined {
  const levels = model.reasoning ? model.thinking?.levels : undefined;
  if (levels === undefined || levels.length === 0) return undefined;
  const wanted = asked ?? "off";
  if (levels.includes(wanted)) return wanted;
  const at = LEVELS.indexOf(wanted);
  return (
    LEVELS.slice(at).find((level) => levels.includes(level)) ??
    LEVELS.slice(0, at)
      .reverse()
      .find((level) => levels.includes(level))
  );
}

/** How a request asks its model to think (`thinkFor`): what every protocol asks by, so a level means one thing in all. */
export interface Think {
  /** The level asked for, clamped to the model's (`levelFor`). */
  readonly level: ThinkingLevel;
  /**
   * The effort it is sent as: its value where the model names it otherwise (OpenAI's `none` for `off`, a
   * `thinkingLevelMap`'s), else the level; none for `off` with no value.
   */
  readonly effort: string | undefined;
  /** Whether the model thinks: at an effort, but `none`, the OpenAI APIs' word for no reasoning. `off` mapped to one thinks. */
  readonly on: boolean;
}

/** How a request asking for `asked` asks `model` to think; undefined: the model has no thinking to set, and nothing about it is sent. */
export function thinkFor(model: Model, asked: ThinkingLevel | undefined): Think | undefined {
  const level = levelFor(model, asked);
  if (level === undefined) return undefined;
  const effort = model.thinking?.values?.[level] ?? (level === "off" ? undefined : level);
  return { level, effort, on: effort !== undefined && effort !== "none" };
}

/**
 * Whether the model binds a reply's thinking to the request it answered: Anthropic's adaptive-thinking models reject a
 * thinking block, or drop it with every later one, once anything before it changed. Leaving out the thinking of a tool
 * round in flight is allowed in adaptive mode. Not its budget-thinking models, which bind nothing and reject a request
 * continuing a tool round whose thinking was left out, nor other protocols, which take reasoning back whatever came
 * before it (OpenAI's needs it beside the reply it produced).
 */
export const bindsThinking = (model: Model): boolean => model.api === "anthropic-messages" && model.thinking?.kind === "effort";

/** The levels a budget-thinking model takes, and the tokens each thinks in. */
export const BUDGET_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
export const THINKING_BUDGETS: Readonly<Partial<Record<ThinkingLevel, number>>> = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

/** A model's `effort` options as levels: the contract's levels among `values`, `none` as `off`, lowest first. */
export function effortThinking(values: readonly string[], canStop: boolean): Thinking | undefined {
  const named = new Set(values);
  const levels = LEVELS.filter((level) => (level === "off" ? canStop || named.has("none") : named.has(level)));
  if (levels.filter((level) => level !== "off").length === 0) return undefined;
  return { kind: "effort", levels, ...(named.has("none") ? { values: { off: "none" } } : {}) };
}
