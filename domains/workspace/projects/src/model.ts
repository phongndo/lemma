import type { SessionInfo } from "@lemma/sessions";

/** What a project holds, for its row and its header: its threads, those archived and running, and when it was last used. */
export interface ProjectStats {
  readonly threads: number;
  readonly archived: number;
  readonly running: number;
  /** The latest `updatedAt` of its threads; undefined with none. */
  readonly lastActive: number | undefined;
}

/** A project's threads, archived ones included. */
export const threadsIn = (sessions: readonly SessionInfo[], cwd: string): SessionInfo[] => sessions.filter((session) => session.cwd === cwd);

export const projectStats = (sessions: readonly SessionInfo[], running: readonly string[], cwd: string): ProjectStats => {
  const mine = threadsIn(sessions, cwd);
  const busy = new Set(running);
  return {
    threads: mine.length,
    archived: mine.filter((session) => session.archived === true).length,
    running: mine.filter((session) => busy.has(session.id)).length,
    lastActive: mine.length === 0 ? undefined : Math.max(...mine.map((session) => session.updatedAt)),
  };
};

export const threadCount = (n: number): string => `${n} thread${n === 1 ? "" : "s"}`;

/** A project's mark: the first letter or digit of its name, upper-cased; `#` for a name with none. */
export const initialOf = (name: string): string => /[\p{L}\p{N}]/u.exec(name)?.[0]?.toLocaleUpperCase() ?? "#";
