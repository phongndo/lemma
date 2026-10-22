import type { ModelInfo, ThinkingLevel } from "../llm.ts";
import { matchesQuery } from "@lemma/web/match";

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

/** Used for a model until the user picks a level for it. */
export const DEFAULT_THINKING: ThinkingLevel = "medium";

// `@lemma/llm`'s, as the host's plugins choose levels too; here beside the other helpers a web half picks models with.
export { clampThinking, thinkingLevels } from "../thinking.ts";

/**
 * The stored model if still available; otherwise the first available one,
 * which is what the host runs a turn on when none is named (and no
 * `agent.defaultModel` is set), so the composer shows the model a turn will use.
 */
export const resolveModel = (models: readonly ModelInfo[], stored: string | undefined): ModelInfo | undefined =>
  (stored === undefined ? undefined : models.find((model) => model.ref === stored)) ?? models[0];
