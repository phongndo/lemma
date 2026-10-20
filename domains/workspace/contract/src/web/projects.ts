/**
 * Projects to offer: the projects of folders with sessions, most recently used first, then those of folders added by
 * hand. There are none until there is one of those. A folder counts as its project (`projectOf`: a worktree's is its
 * repository's), and one not yet placed (`projectOf` gives undefined) waits rather than show as a project of its own.
 * A `hidden` (removed) project returns once it has a session; the `standalone` folder, where threads with no project
 * run, is never one.
 */
export const knownProjects = (
  sessions: readonly { readonly cwd: string; readonly updatedAt: number }[],
  added: readonly string[],
  options: {
    readonly hidden?: readonly string[];
    readonly standalone?: string | undefined;
    readonly projectOf?: (cwd: string) => string | undefined;
  } = {},
): string[] => {
  const projectOf = options.projectOf ?? ((cwd: string) => cwd);
  const recency = new Map<string, number>();
  for (const session of sessions) {
    const project = projectOf(session.cwd);
    if (project !== undefined) recency.set(project, Math.max(recency.get(project) ?? 0, session.updatedAt));
  }
  const byRecency = [...recency.keys()].sort((a, b) => recency.get(b)! - recency.get(a)!);
  const hidden = new Set(options.hidden);
  const addedProjects = added.flatMap((folder) => projectOf(folder) ?? []).filter((project) => !hidden.has(project));
  return [...new Set([...byRecency, ...addedProjects])].filter((cwd) => cwd !== options.standalone);
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
