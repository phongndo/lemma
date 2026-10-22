import { Context } from "effect";
import type { Effect } from "effect";
import type { ModelInfo, ModelRef, ThinkingLevel } from "./llm.ts";
import { clampThinking, lowestThinking } from "./thinking.ts";

/** What a small task runs on: a model, and the reasoning to ask of it (none for a model that offers no choice). */
export interface SmallModelChoice {
  readonly model: ModelInfo;
  readonly thinking?: ThinkingLevel;
}

/** The person's choice for small tasks: a model and its reasoning, each unset until chosen. */
export interface SmallModelPreference {
  readonly model?: ModelRef | undefined;
  readonly thinking?: ThinkingLevel | undefined;
}

/**
 * Families of small models, as the words of a model's id: OpenAI's Luna, Gemini's Flash-Lite and then Flash, Claude's
 * Haiku. OpenCode prefers the same families for its titles (`Model.small`, read 2026-10-22). A provider's model is of a
 * family when its id has every word of it, however the provider spells the rest: `gpt-6-luna`,
 * `anthropic/claude-haiku-5.5`, `anthropic.claude-haiku-5-5`.
 */
const FAMILIES: readonly (readonly string[])[] = [
  ["gpt", "luna"],
  ["gemini", "flash", "lite"],
  ["gemini", "flash"],
  ["claude", "haiku"],
];

/** Words of an id that say nothing of which model it is: a vendor's name, and an alias for the newest. */
const PLAIN = new Set(["anthropic", "openai", "google", "latest"]);
const NUMBER = /^v?\d+$/;

const wordsOf = (id: string): readonly string[] =>
  id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A year, or a whole date (`20251001`): a snapshot's, not part of the version. */
const DATE = /^(?:19|20)\d{2}(?:\d{4})?$/;

/**
 * An id's numbers in order, its version, and apart from them the date of a snapshot: `gemini-3.5-flash` is [3, 5];
 * `gpt-6-luna-2026-01-15` is [6], of [2026, 1, 15].
 */
const versionOf = (words: readonly string[]): { readonly version: readonly number[]; readonly date: readonly number[] } => {
  const version: number[] = [];
  const date: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!NUMBER.test(word)) continue;
    if (!DATE.test(word)) {
      version.push(Number(word.replace(/^v/, "")));
      continue;
    }
    date.push(Number(word));
    // A year's month and day follow it.
    while (word.length === 4 && date.length < 3 && /^\d{1,2}$/.test(words[i + 1] ?? "")) date.push(Number(words[++i]));
  }
  return { version, date };
};

const newer = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? -1) - (b[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The small model of `thread`'s provider, for a task of a thread on `thread`: of the families above, the first the
 * provider has, those of `thread`'s own line first (Haiku for a Claude thread on a provider serving several); within a
 * family, the model whose id says least else (no region, batch, preview, or image variant), then the newest version,
 * its plain id before its dated snapshots. Undefined when the provider has none of them: a task then runs on `thread`
 * itself.
 */
export const smallModel = (models: readonly ModelInfo[], thread: ModelInfo): ModelInfo | undefined => {
  const line = new Set(wordsOf(thread.id));
  const families = [...FAMILIES].sort((a, b) => Number(line.has(b[0]!)) - Number(line.has(a[0]!)));
  const offered = models.filter((model) => model.provider === thread.provider).map((model) => ({ model, words: wordsOf(model.id) }));
  for (const family of families) {
    const ranked = offered
      .filter(({ words }) => family.every((word) => words.includes(word)))
      .map(({ model, words }) => ({
        model,
        extra: words.filter((word) => !family.includes(word) && !PLAIN.has(word) && !NUMBER.test(word)).length,
        ...versionOf(words),
      }))
      // Of one version, the plain id first, as it names the newest snapshot; then the latest snapshot.
      .sort((a, b) => a.extra - b.extra || newer(b.version, a.version) || Number(a.date.length > 0) - Number(b.date.length > 0) || newer(b.date, a.date));
    if (ranked[0] !== undefined) return ranked[0].model;
  }
  return undefined;
};

/**
 * What a small task of a thread on `near` runs on, of the available `models`: the model `preference` names while it is
 * available, otherwise the small model of `near`'s provider (`smallModel`), else `near` itself; at the level
 * `preference` names as far as that model offers it (`clampThinking`), else the least it offers. `near` defaults to the
 * first model, as a turn's does. Undefined when no model is available.
 */
export const chooseSmallModel = (models: readonly ModelInfo[], preference: SmallModelPreference, near?: ModelRef): SmallModelChoice | undefined => {
  const chosen = preference.model === undefined ? undefined : models.find((model) => model.ref === preference.model);
  const thread = models.find((model) => model.ref === near) ?? models[0];
  const model = chosen ?? (thread === undefined ? undefined : (smallModel(models, thread) ?? thread));
  if (model === undefined) return undefined;
  const thinking = clampThinking(model, preference.thinking) ?? lowestThinking(model);
  return thinking === undefined ? { model } : { model, thinking };
};

/**
 * The model small tasks run on: a thread's title, and whatever else a plugin asks a model in passing rather than in a
 * turn. One choice for all of them, the person's, so a plugin asking names no model of its own. `llm.small-model`
 * provides it, from its config.
 */
export class SmallModel extends Context.Service<
  SmallModel,
  {
    /** What a task of a thread on `near` (its model) runs on now: `chooseSmallModel` over the available models. */
    readonly choose: (near?: ModelRef) => Effect.Effect<SmallModelChoice | undefined>;
  }
>()("lemma/SmallModel") {}
