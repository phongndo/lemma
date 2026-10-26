import type { SessionInfo, SessionMarks } from "@lemma/sessions";

/**
 * The sidebar's list of threads, as plain data: which are pinned, active, and archived, and in what order, and how a
 * drag rearranges them. Pinned first, in the order they were dragged or pinned into (a new pin on top); then the
 * active, new and unarchived ones on top, newest first, above those dragged into an order; archived below, the latest
 * archived first. A running thread does not move.
 */

/**
 * How long ago `at` was, shortly: `now`, `36m`, `3h`, `2d`. Rounded to the nearest, as `relativeTime` (`@lemma/web/format`)
 * rounds, so a thread is as old here as in the palette (`4h` and `4h ago`); past a week it goes on counting days.
 */
export const shortAge = (at: number, now: number): string => {
  const seconds = Math.round((now - at) / 1_000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

/** How long a turn has run, shortly: `12s`, `3m`, `1h 5m`. */
export const runTime = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** What orders the list beyond when each thread was made, kept by id. */
export interface Marks {
  /** When threads were archived and unarchived here. */
  readonly archivedAt: Readonly<Record<string, number>>;
  readonly unarchivedAt: Readonly<Record<string, number>>;
  /** The pinned threads' order, as dragged or pinned; one pinned elsewhere and not yet in it follows them, newest first. */
  readonly pinnedOrder: readonly string[];
  /** The active threads dragged into an order; one not in it (new, unpinned, or unarchived) goes above them, newest first. */
  readonly activeOrder: readonly string[];
}

export const noMarks: Marks = { archivedAt: {}, unarchivedAt: {}, pinnedOrder: [], activeOrder: [] };

export interface Sections {
  readonly pinned: readonly SessionInfo[];
  readonly active: readonly SessionInfo[];
  /** The latest archived first. */
  readonly archived: readonly SessionInfo[];
}

/** A thread with nothing sent yet is a new thread being written: not listed until it has a prompt (`draftRows`). */
const listed = (session: SessionInfo) => session.lastSeq > 0;

/**
 * The thread an agent is listed under (`SessionInfo.parent`), rather than on its own: the one that started it, while
 * it is there and neither is archived. An agent whose thread is gone, or archived apart from it, is a thread of its own.
 */
export const nestedUnder = (session: SessionInfo, byId: ReadonlyMap<string, SessionInfo>): string | undefined => {
  const parent = session.parent === undefined ? undefined : byId.get(session.parent.sessionId);
  return parent === undefined || parent.id === session.id || parent.archived === true || session.archived === true ? undefined : parent.id;
};

/** An agent listed under a thread: its session, and how far down (1 for one the thread started, 2 for that one's). */
export interface NestedAgent {
  readonly session: SessionInfo;
  readonly level: number;
}

/**
 * The agents listed under each thread listed on its own, by the thread's id: those it started (`nestedUnder`), and
 * theirs in turn, since an agent has no row of its own to list them under; each after the agent that started it,
 * oldest first among those one started.
 */
export const nestedAgents = (sessions: readonly SessionInfo[]): ReadonlyMap<string, readonly NestedAgent[]> => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const started = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const under = listed(session) ? nestedUnder(session, byId) : undefined;
    if (under === undefined) continue;
    const agents = started.get(under) ?? [];
    agents.push(session);
    started.set(under, agents);
  }
  for (const agents of started.values()) agents.sort((a, b) => a.createdAt - b.createdAt);
  const out = new Map<string, NestedAgent[]>();
  for (const session of sessions) {
    if (!started.has(session.id) || !listed(session) || nestedUnder(session, byId) !== undefined) continue;
    const rows: NestedAgent[] = [];
    const seen = new Set([session.id]);
    const visit = (id: string, level: number) => {
      for (const agent of started.get(id) ?? []) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        rows.push({ session: agent, level });
        visit(agent.id, level + 1);
      }
    };
    visit(session.id, 1);
    out.set(session.id, rows);
  }
  return out;
};

const ranks = (order: readonly string[]) => new Map(order.map((id, at) => [id, at]));

/** The threads in their sections and order. */
export const sections = (sessions: readonly SessionInfo[], marks: Marks): Sections => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // An agent is listed under its thread (`nestedAgents`), not on its own.
  const shown = sessions.filter((session) => listed(session) && nestedUnder(session, byId) === undefined);
  const newest = (session: SessionInfo) => Math.max(session.createdAt, marks.unarchivedAt[session.id] ?? 0);
  const archivedAt = (session: SessionInfo) => marks.archivedAt[session.id] ?? session.updatedAt;
  /** Those `order` ranks in its order, and the rest newest first: `unranked` before or after them. */
  const ordered = (order: readonly string[], unranked: "first" | "last") => {
    const rank = ranks(order);
    const away = unranked === "first" ? -1 : Number.MAX_SAFE_INTEGER;
    return (a: SessionInfo, b: SessionInfo) => (rank.get(a.id) ?? away) - (rank.get(b.id) ?? away) || newest(b) - newest(a);
  };
  return {
    pinned: shown.filter((session) => session.pinned === true && session.archived !== true).sort(ordered(marks.pinnedOrder, "last")),
    active: shown.filter((session) => session.pinned !== true && session.archived !== true).sort(ordered(marks.activeOrder, "first")),
    archived: shown.filter((session) => session.archived === true).sort((a, b) => archivedAt(b) - archivedAt(a)),
  };
};

/**
 * The new threads left mid-prompt, newest first: nothing sent in them and a prompt written (`drafted`). Not the one
 * `shown`, whose composer shows its prompt, unless it was one of them when it was opened (`held`), so opening one does
 * not take it out of the list.
 */
export const draftRows = (
  sessions: readonly SessionInfo[],
  drafted: (id: string) => boolean,
  shown: string | undefined,
  held: string | undefined,
): readonly SessionInfo[] =>
  sessions
    .filter((session) => !listed(session) && session.archived !== true && drafted(session.id) && (session.id !== shown || session.id === held))
    .sort((a, b) => b.createdAt - a.createdAt);

/** Pinned or archived, as a thread was and is: what `transitioned` compares. */
export interface Flags {
  readonly pinned: boolean;
  readonly archived: boolean;
}

export const flagsOf = (sessions: readonly SessionInfo[]): ReadonlyMap<string, Flags> =>
  new Map(sessions.map((session) => [session.id, { pinned: session.pinned === true, archived: session.archived === true }]));

/**
 * `marks` once threads were pinned, unpinned, archived, or unarchived (`was` to `now`), wherever that was done: a new
 * pin goes first among the pinned (one dragged in already has its place), an unpinned one leaves their order, an
 * archived one leaves the active order (so it comes back on top) and is dated, and an unarchived one is dated. Threads
 * gone from `now` leave every mark. The same `marks` when nothing changed.
 */
export const transitioned = (marks: Marks, was: ReadonlyMap<string, Flags>, now: ReadonlyMap<string, Flags>, at: number): Marks => {
  // Not by whether each is pinned now: one dropped among the pinned has its place there before it is pinned.
  let pinnedOrder = marks.pinnedOrder.filter((id) => now.has(id) && !(was.get(id)?.pinned === true && now.get(id)?.pinned === false));
  let activeOrder = marks.activeOrder.filter((id) => now.has(id));
  const archivedAt: Record<string, number> = Object.fromEntries(Object.entries(marks.archivedAt).filter(([id]) => now.has(id)));
  const unarchivedAt: Record<string, number> = Object.fromEntries(Object.entries(marks.unarchivedAt).filter(([id]) => now.has(id)));
  const pinned: string[] = [];
  for (const [id, flags] of now) {
    const before = was.get(id);
    if (before === undefined) continue;
    if (flags.pinned && !before.pinned && !pinnedOrder.includes(id)) pinned.unshift(id);
    if (flags.archived && !before.archived) {
      archivedAt[id] ??= at;
      delete unarchivedAt[id];
      activeOrder = activeOrder.filter((other) => other !== id);
    } else if (!flags.archived && before.archived) {
      delete archivedAt[id];
      unarchivedAt[id] = at;
    }
  }
  if (pinned.length > 0) {
    pinnedOrder = [...pinned, ...pinnedOrder];
    activeOrder = activeOrder.filter((id) => !pinned.includes(id));
  }
  const next = { archivedAt, unarchivedAt, pinnedOrder, activeOrder };
  return JSON.stringify(next) === JSON.stringify(marks) ? marks : next;
};

export type Section = "pinned" | "active" | "archived";

/** The heads in the list as dragged: each starts its section, the pinned one the list. */
export const Heads = { pinned: "head:pinned", active: "head:active", archived: "head:archived" } as const;

/** The list as drag and drop arranges it, by id: each section's head, then its threads (the archived ones shown). */
export const dragItems = (pinned: readonly SessionInfo[], active: readonly SessionInfo[], archived: readonly SessionInfo[]): readonly string[] => [
  Heads.pinned,
  ...pinned.map((session) => session.id),
  Heads.active,
  ...active.map((session) => session.id),
  Heads.archived,
  ...archived.map((session) => session.id),
];

/** The section `id` is in, among `items`. */
export const sectionIn = (items: readonly string[], id: string): Section | undefined => {
  let section: Section = "pinned";
  for (const item of items) {
    if (item === Heads.active) section = "active";
    else if (item === Heads.archived) section = "archived";
    else if (item === id) return section;
  }
  return undefined;
};

/** The threads in `section` of `items`, in order. */
export const inSection = (items: readonly string[], section: Section): string[] =>
  items.filter((item) => !Object.values<string>(Heads).includes(item) && sectionIn(items, item) === section);

/**
 * `items` with the thread `id` dragged onto `over` (a thread or a head), as a sortable list moves it: past `over`,
 * after it going down and before it going up; nothing goes above the pinned head. Among the archived it goes first,
 * where archiving puts it, and one archived to begin with (`initial`) goes back where it was: their order is when they
 * were archived. `items` itself when nothing moves.
 */
export const dragTo = (items: readonly string[], initial: readonly string[], id: string, over: string): readonly string[] => {
  const from = items.indexOf(id);
  const to = items.indexOf(over);
  if (from === -1 || to === -1 || from === to) return items;
  let next = items.filter((item) => item !== id);
  next.splice(to, 0, id);
  if (next[0] !== Heads.pinned) next = [Heads.pinned, ...next.filter((item) => item !== Heads.pinned)];
  if (sectionIn(next, id) === "archived") {
    if (sectionIn(initial, id) === "archived") next = [...initial];
    else {
      next = next.filter((item) => item !== id);
      next.splice(next.indexOf(Heads.archived) + 1, 0, id);
    }
  }
  return next.length === items.length && next.every((item, at) => item === items[at]) ? items : next;
};

/** What dropping a thread from one section in another does: shown on it while it is dragged. */
export type DropVerb = "pin" | "unpin" | "archive" | "unarchive";

export const dropVerb = (from: Section | undefined, to: Section | undefined): DropVerb | undefined =>
  from === undefined || to === undefined || from === to
    ? undefined
    : to === "pinned"
      ? "pin"
      : to === "archived"
        ? "archive"
        : from === "pinned"
          ? "unpin"
          : "unarchive";

/**
 * What dropping thread `id` where `items` has it does: the marks with its section's new order (dropped among the
 * pinned, their order is the pinned shown; among the active, every active one shown takes its place, so new ones go
 * above them), and the change to the thread when it moved section (`pinned`: it is pinned now).
 */
export const dropped = (
  marks: Marks,
  initial: readonly string[],
  items: readonly string[],
  id: string,
  pinned: boolean,
): { readonly marks: Marks; readonly change?: SessionMarks } => {
  const from = sectionIn(initial, id);
  const to = sectionIn(items, id);
  if (from === undefined || to === undefined) return { marks };
  const without = (order: readonly string[]) => order.filter((other) => other !== id);
  if (to === "pinned")
    return {
      marks: { ...marks, pinnedOrder: inSection(items, "pinned"), activeOrder: without(marks.activeOrder) },
      ...(from === "pinned" ? {} : { change: { pinned: true, ...(from === "archived" ? { archived: false } : {}) } }),
    };
  if (to === "active") {
    const change: SessionMarks = { ...(pinned ? { pinned: false } : {}), ...(from === "archived" ? { archived: false } : {}) };
    return {
      marks: { ...marks, activeOrder: inSection(items, "active"), pinnedOrder: without(marks.pinnedOrder) },
      ...(Object.keys(change).length === 0 ? {} : { change }),
    };
  }
  return from === "archived" ? { marks } : { marks, change: { archived: true } };
};

/** The thread `step` places from `id` in `order`, not going past either end; the first or last from none. */
export const stepFrom = (order: readonly SessionInfo[], id: string | undefined, step: number): string | undefined => {
  if (order.length === 0) return undefined;
  const at = order.findIndex((session) => session.id === id);
  if (at === -1) return (step > 0 ? order[0] : order.at(-1))?.id;
  return order[Math.max(0, Math.min(order.length - 1, at + step))]?.id;
};

/**
 * The next thread after `id` in `order` that `needs` the person, going round past the end (`step` -1: the one before
 * it, round past the start); from none, the first or the last that does. Never `id` itself: none when no other does.
 */
export const nextNeeding = (
  order: readonly SessionInfo[],
  id: string | undefined,
  step: 1 | -1,
  needs: (session: SessionInfo) => boolean,
): string | undefined => {
  const count = order.length;
  const at = order.findIndex((session) => session.id === id);
  const from = at !== -1 ? at : step > 0 ? -1 : count;
  for (let moved = 1; moved <= count; moved++) {
    const session = order[(((from + step * moved) % count) + count) % count]!;
    if (session.id !== id && needs(session)) return session.id;
  }
  return undefined;
};

/** Where to go once `id`, shown, is archived: the thread after it in `order`, else the one before it; none when it was the last. */
export const afterArchiving = (order: readonly SessionInfo[], id: string): string | undefined => {
  const at = order.findIndex((session) => session.id === id);
  const rest = order.filter((session) => session.id !== id);
  if (rest.length === 0) return undefined;
  return rest[at === -1 ? 0 : Math.min(at, rest.length - 1)]?.id;
};
