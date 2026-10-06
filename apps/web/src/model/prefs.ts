import type { ModelInfo, ThinkingLevel } from "@lemma/contracts";
import { matchesQuery } from "./palette.ts";

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

/**
 * Projects to offer: folders with sessions, most recently used first, then ones added by hand.
 * There are none until there is one of those. A `hidden` (removed) project returns once it has
 * a session; the `standalone` folder, where threads with no project run, is never one.
 */
export const knownProjects = (
  sessions: readonly { readonly cwd: string; readonly updatedAt: number }[],
  added: readonly string[],
  options: { readonly hidden?: readonly string[]; readonly standalone?: string | undefined } = {},
): string[] => {
  const recency = new Map<string, number>();
  for (const session of sessions) recency.set(session.cwd, Math.max(recency.get(session.cwd) ?? 0, session.updatedAt));
  const byRecency = [...recency.keys()].sort((a, b) => recency.get(b)! - recency.get(a)!);
  const hidden = new Set(options.hidden);
  return [...new Set([...byRecency, ...added.filter((cwd) => !hidden.has(cwd))])].filter((cwd) => cwd !== options.standalone);
};

/** How one project shows and starts threads, remembered in the browser. An absent field follows the default. */
export interface ProjectSettings {
  /** Shown instead of the folder's name. */
  readonly name?: string;
  /** Whether a new thread in it starts in its own worktree, over the global setting. */
  readonly worktree?: boolean;
}

/** The last part of a path: `lemma` for `/home/me/code/lemma/`. */
export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** A project's display name: the one set for it, else its folder's name. */
export const projectName = (cwd: string, settings: ProjectSettings | undefined): string => settings?.name ?? folderName(cwd);

/**
 * Applies `patch` to one project's settings. An undefined field, or a blank
 * name, returns that field to its default; a project left with none is dropped.
 */
export const patchProjectSettings = (
  all: Readonly<Record<string, ProjectSettings>>,
  cwd: string,
  patch: { readonly [K in keyof ProjectSettings]?: ProjectSettings[K] | undefined },
): Record<string, ProjectSettings> => {
  const merged: Record<string, unknown> = { ...all[cwd], ...patch };
  if (typeof merged.name === "string") merged.name = merged.name.trim() || undefined;
  const kept = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as ProjectSettings;
  const { [cwd]: _old, ...rest } = all;
  return Object.keys(kept).length === 0 ? rest : { ...rest, [cwd]: kept };
};
