import type { ModelInfo, ThinkingLevel } from "../llm.ts";
import { matchesQuery } from "@lemma/ui/match";

interface ModelGroup {
  readonly provider: string;
  readonly models: readonly ModelInfo[];
}

/** Models matching every word of `query` (in ref or name), grouped by provider in first-seen order. */
export const filterModels = (models: readonly ModelInfo[], query: string): ModelGroup[] => {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    if (!matchesQuery(query, `${model.ref} ${model.name}`)) continue;
    const group = groups.get(model.provider);
    if (group === undefined) groups.set(model.provider, [model]);
    else group.push(model);
  }
  return [...groups.entries()].map(([provider, list]) => ({ provider, models: list }));
};

/** Levels offered for `model`; empty when it cannot reason or offers no choice. */
export const thinkingLevels = (model: ModelInfo | undefined): readonly ThinkingLevel[] =>
  model === undefined || !model.reasoning || model.thinkingLevels.length < 2 ? [] : model.thinkingLevels;

/** Used for a model until the user picks a level for it. */
export const DEFAULT_THINKING: ThinkingLevel = "medium";

/**
 * The level to send: the preferred one if the model supports it, else the
 * nearest supported level above it, else the highest below (pi's rule).
 */
export const clampThinking = (model: ModelInfo | undefined, preferred: ThinkingLevel | undefined): ThinkingLevel | undefined => {
  const levels = thinkingLevels(model);
  if (levels.length === 0 || preferred === undefined) return undefined;
  if (levels.includes(preferred)) return preferred;
  const order: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const rank = order.indexOf(preferred);
  return levels.find((level) => order.indexOf(level) > rank) ?? levels.filter((level) => order.indexOf(level) < rank).at(-1);
};

/**
 * The stored model if still available; otherwise the first available one,
 * which is what the host runs a turn on when none is named (and no
 * `agent.defaultModel` is set), so the composer shows the model a turn will use.
 */
export const resolveModel = (models: readonly ModelInfo[], stored: string | undefined): ModelInfo | undefined =>
  (stored === undefined ? undefined : models.find((model) => model.ref === stored)) ?? models[0];
