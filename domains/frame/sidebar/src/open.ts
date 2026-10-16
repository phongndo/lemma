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

/** A closed thread and where it stood, for reopening it there. */
export interface Closed {
  readonly id: string;
  readonly index: number;
}

/** The most recently closed thread that can come back (still there, not archived, not open again), and the closed ones before it. */
export const lastClosed = (
  closed: readonly Closed[],
  open: readonly string[],
  sessions: readonly SessionInfo[],
): { readonly reopen: Closed | undefined; readonly rest: readonly Closed[] } => {
  const live = new Set(sessions.filter(listed).map((session) => session.id));
  const rest = closed.filter((entry) => live.has(entry.id) && !open.includes(entry.id));
  return { reopen: rest.at(-1), rest: rest.slice(0, -1) };
};

/** `id` opened back at `index`, or at the end when the list has since shrunk. */
export const withReopened = (open: readonly string[], { id, index }: Closed): readonly string[] =>
  open.includes(id) ? open : [...open.slice(0, index), id, ...open.slice(index)];

/** `id` moved to `index` among the open threads (added there when it was only in view, running); the rest keep their order. */
export const moved = (open: readonly string[], id: string, index: number): readonly string[] => {
  const rest = open.filter((other) => other !== id);
  const at = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
};
