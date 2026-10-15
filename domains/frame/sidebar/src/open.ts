import type { SessionInfo } from "@lemma/sessions";

/**
 * The threads kept open, as a browser keeps tabs: opening one adds it, closing
 * it takes it away without touching the thread. Pinned threads are always
 * open, and one with a turn running stays in view though closed, so work in
 * the background is never out of sight.
 */
export interface Shown {
  /** Pinned, newest first. */
  readonly pinned: readonly SessionInfo[];
  /** Open, in the order they were opened, then any closed one still running. */
  readonly open: readonly SessionInfo[];
}

const listed = (session: SessionInfo | undefined): session is SessionInfo => session !== undefined && session.archived !== true;

export const shownThreads = (sessions: readonly SessionInfo[], open: readonly string[], running: readonly string[]): Shown => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const pinned = sessions.filter((session) => listed(session) && session.pinned === true).sort((a, b) => b.updatedAt - a.updatedAt);
  const unpinned = (id: string) => {
    const session = byId.get(id);
    return listed(session) && session.pinned !== true ? session : undefined;
  };
  const opened = open.map(unpinned).filter(listed);
  const background = running
    .filter((id) => !open.includes(id))
    .map(unpinned)
    .filter(listed);
  return { pinned, open: [...opened, ...background] };
};

export const withOpened = (open: readonly string[], id: string): readonly string[] => (open.includes(id) ? open : [...open, id]);

export const withClosed = (open: readonly string[], id: string): readonly string[] => open.filter((other) => other !== id);

/** Without the ids of threads that are gone or archived. */
export const pruned = (open: readonly string[], sessions: readonly SessionInfo[]): readonly string[] => {
  const live = new Set(sessions.filter(listed).map((session) => session.id));
  return open.filter((id) => live.has(id));
};

/** What a first visit starts with: the few most recently used threads. */
export const seedOpen = (sessions: readonly SessionInfo[], count = 5): readonly string[] =>
  sessions
    .filter((session) => listed(session) && session.pinned !== true)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, count)
    .map((session) => session.id);

/** Where focus goes when `id` closes: the thread below it, else the one above, else none. */
export const afterClose = (order: readonly SessionInfo[], id: string): string | undefined => {
  const at = order.findIndex((session) => session.id === id);
  if (at === -1) return undefined;
  return (order[at + 1] ?? order[at - 1])?.id;
};

/** The thread `step` places from `id` in `order`, wrapping; the first when `id` is not in it. */
export const neighborOf = (order: readonly SessionInfo[], id: string | undefined, step: number): string | undefined => {
  if (order.length === 0) return undefined;
  const at = order.findIndex((session) => session.id === id);
  return order[at === -1 ? 0 : (at + step + order.length) % order.length]?.id;
};
