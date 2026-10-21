import type { SessionInfo } from "@lemma/sessions";
import { matchesQuery } from "@lemma/web/match";

/** Archived threads under one heading: a project, or a stretch of days. */
export interface ArchivedGroup {
  /** What `keyOf` gave its threads: the project's folder, or the days' label. */
  readonly key: string;
  readonly sessions: readonly SessionInfo[];
}

/** How the page groups the threads: by when they were last used, as a browser's history does, or by project. */
export type Grouping = "date" | "project";

/** The archived threads, the most recently used first: archiving a thread is not using it, so this is when it was last worked in. */
export const archivedOf = (sessions: readonly SessionInfo[]): SessionInfo[] =>
  sessions.filter((session) => session.archived === true).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

/** What the page shows: threads in one project (`projectOf` their folder; any while undefined), whose `text` holds every word of `query`. */
export interface ArchivedFilter {
  readonly query: string;
  readonly project: string | undefined;
}

/** The archived threads `filter` keeps, the most recently used first. */
export const filterArchived = (
  sessions: readonly SessionInfo[],
  filter: ArchivedFilter,
  projectOf: (cwd: string) => string,
  text: (session: SessionInfo) => string,
): SessionInfo[] =>
  archivedOf(sessions).filter(
    (session) => (filter.project === undefined || projectOf(session.cwd) === filter.project) && matchesQuery(filter.query, text(session)),
  );

/** Threads in their order, under the key each gives, the keys in the order of their first thread. */
export const groupBy = (sessions: readonly SessionInfo[], keyOf: (session: SessionInfo) => string): ArchivedGroup[] => {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = keyOf(session);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [session]);
    else group.push(session);
  }
  return [...groups].map(([key, mine]) => ({ key, sessions: mine }));
};

const DAY = 86_400_000;

/** Midnight before `at`, local time. */
const startOfDay = (at: number): number => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** The stretch of days `at` falls in, seen at `now`, as a browser's history heads them: Today, Yesterday, Previous 7 days, then months. */
export const dayLabel = (at: number, now: number): string => {
  const today = startOfDay(now);
  if (at >= today) return "Today";
  if (at >= today - DAY) return "Yesterday";
  if (at >= today - 7 * DAY) return "Previous 7 days";
  if (at >= today - 30 * DAY) return "Previous 30 days";
  const date = new Date(at);
  return date.toLocaleDateString(undefined, { month: "long", ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
};

/** The ids from `anchor` to `id` in `order`, both included, as a shift-click selects them; just `id` once the anchor is not shown. */
export const rangeOf = (order: readonly string[], anchor: string | undefined, id: string): string[] => {
  const from = anchor === undefined ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from === -1 || to === -1) return [id];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
};

/** `selected` with `ids` added (`on`) or taken out. */
export const withSelection = (selected: ReadonlySet<string>, ids: readonly string[], on: boolean): ReadonlySet<string> => {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
};

/**
 * What a Shift-click (or Shift with an arrow) on `id` selects, as a file manager's list does: the selection as it was
 * when the anchor was picked (`base`), with the run from the anchor to `id` set as the anchor is, selected or not. A
 * second Shift-click from the same anchor so grows or shrinks the run rather than adding to it. Without an anchor in
 * `order`, it selects `id`.
 */
export const extendSelection = (base: ReadonlySet<string>, order: readonly string[], anchor: string | undefined, id: string): ReadonlySet<string> =>
  anchor === undefined || !order.includes(anchor) ? withSelection(base, [id], true) : withSelection(base, rangeOf(order, anchor, id), base.has(anchor));

/** How many of `ids` are selected, as a checkbox over them says it: all, some, or none (an empty list is none). */
export const selectionOf = (selected: ReadonlySet<string>, ids: readonly string[]): "all" | "some" | "none" => {
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? "none" : count === ids.length ? "all" : "some";
};

/** `1 thread`, `3 threads`. */
export const threadCount = (count: number): string => `${count} ${count === 1 ? "thread" : "threads"}`;
