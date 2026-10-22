import type { ModelInfo, ThinkingLevel } from "./llm.ts";

/** The levels from least reasoning to most. */
const ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Levels offered for `model`; empty when it cannot reason or offers no choice. */
export const thinkingLevels = (model: ModelInfo | undefined): readonly ThinkingLevel[] =>
  model === undefined || !model.reasoning || model.thinkingLevels.length < 2 ? [] : model.thinkingLevels;

/**
 * The level to send: the preferred one if the model supports it, else the
 * nearest supported level above it, else the highest below (pi's rule).
 */
export const clampThinking = (model: ModelInfo | undefined, preferred: ThinkingLevel | undefined): ThinkingLevel | undefined => {
  const levels = thinkingLevels(model);
  if (levels.length === 0 || preferred === undefined) return undefined;
  if (levels.includes(preferred)) return preferred;
  const rank = ORDER.indexOf(preferred);
  return levels.find((level) => ORDER.indexOf(level) > rank) ?? levels.filter((level) => ORDER.indexOf(level) < rank).at(-1);
};

/** The least reasoning `model` offers; undefined when it offers no choice. */
export const lowestThinking = (model: ModelInfo | undefined): ThinkingLevel | undefined =>
  thinkingLevels(model).reduce<ThinkingLevel | undefined>(
    (low, level) => (low === undefined || ORDER.indexOf(level) < ORDER.indexOf(low) ? level : low),
    undefined,
  );
