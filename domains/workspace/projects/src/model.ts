import type { SessionInfo } from "@lemma/sessions";
import type { Place, Worktree } from "@lemma/workspace";

/** What a project holds, for its row and its header: its threads, those archived and running, and when it was last used. */
export interface ProjectStats {
  readonly threads: number;
  readonly archived: number;
  readonly running: number;
  /** The latest `updatedAt` of its threads; undefined with none. */
  readonly lastActive: number | undefined;
}

/** A project's threads, archived ones included: those in its folder, and in its worktrees (`projectOf`). */
export const threadsIn = (sessions: readonly SessionInfo[], project: string, projectOf: (cwd: string) => string = (cwd) => cwd): SessionInfo[] =>
  sessions.filter((session) => projectOf(session.cwd) === project);

export const projectStats = (
  sessions: readonly SessionInfo[],
  running: readonly string[],
  project: string,
  projectOf: (cwd: string) => string = (cwd) => cwd,
): ProjectStats => {
  const mine = threadsIn(sessions, project, projectOf);
  const busy = new Set(running);
  return {
    threads: mine.length,
    archived: mine.filter((session) => session.archived === true).length,
    running: mine.filter((session) => busy.has(session.id)).length,
    lastActive: mine.length === 0 ? undefined : Math.max(...mine.map((session) => session.updatedAt)),
  };
};

/** A project's mark: the first letter or digit of its name, upper-cased; `#` for a name with none. */
export const initialOf = (name: string): string => /[\p{L}\p{N}]/u.exec(name)?.[0]?.toLocaleUpperCase() ?? "#";

/** A worktree as the projects page lists it: where it is, its branch, how many threads work in it, and whether it is gone. */
export interface WorktreeRow {
  readonly path: string;
  readonly branch: string | null;
  readonly threads: number;
  /** Its folder is gone: removed, and its threads can make it again. */
  readonly removed: boolean;
}

/**
 * A project's worktrees: those git lists (a folder gone too), and those its threads worked in that were removed since,
 * which git no longer lists; with how many threads each has (not archived, and with something in them), the busiest
 * first, then by path.
 */
export const worktreeRows = (
  listed: readonly Worktree[],
  sessions: readonly SessionInfo[],
  placeOf: (cwd: string) => Place | undefined,
  project: string,
): WorktreeRow[] => {
  const rows = new Map<string, WorktreeRow>();
  for (const tree of listed) rows.set(tree.path, { path: tree.path, branch: tree.branch, threads: 0, removed: tree.missing === true });
  for (const session of sessions) {
    const place = placeOf(session.cwd);
    if (place === undefined || !place.worktree || place.project !== project) continue;
    const row = rows.get(session.cwd) ?? { path: session.cwd, branch: place.branch ?? null, threads: 0, removed: !place.exists };
    rows.set(session.cwd, session.archived === true || session.lastSeq === 0 ? row : { ...row, threads: row.threads + 1 });
  }
  return [...rows.values()].sort((a, b) => b.threads - a.threads || a.path.localeCompare(b.path));
};
