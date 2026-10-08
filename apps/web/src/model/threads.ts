import { branchOf } from "@lemma/contracts";
import type { QueuedPrompt, SessionEvent, SessionInfo, SessionsChange } from "@lemma/contracts";

interface SessionGroup {
  readonly cwd: string;
  /** Newest first. */
  readonly sessions: readonly SessionInfo[];
  readonly updatedAt: number;
}

/** Sessions grouped by working directory; groups and sessions newest first. */
export const groupSessions = (sessions: readonly SessionInfo[]): SessionGroup[] => {
  const byCwd = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const group = byCwd.get(session.cwd);
    if (group === undefined) byCwd.set(session.cwd, [session]);
    else group.push(session);
  }
  return [...byCwd.entries()]
    .map(([cwd, list]) => {
      const sorted = list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      return { cwd, sessions: sorted, updatedAt: sorted[0]!.updatedAt };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

/** The sidebar's filing: pinned sessions on their own, newest first, the rest by project, archived ones in neither. */
export const fileSessions = (sessions: readonly SessionInfo[]): { readonly pinned: SessionInfo[]; readonly groups: SessionGroup[] } => {
  const shown = sessions.filter((session) => session.archived !== true);
  return {
    pinned: shown.filter((session) => session.pinned === true).sort((a, b) => b.updatedAt - a.updatedAt),
    groups: groupSessions(shown.filter((session) => session.pinned !== true)),
  };
};

/** Replaces or inserts `info` by id. */
export const upsertSession = (sessions: readonly SessionInfo[], info: SessionInfo): SessionInfo[] => {
  const index = sessions.findIndex((session) => session.id === info.id);
  if (index === -1) return [info, ...sessions];
  const current = sessions[index]!;
  // Notifications can arrive out of order; never step back.
  if (current.lastSeq > info.lastSeq || current.updatedAt > info.updatedAt) return sessions.slice();
  const next = sessions.slice();
  next[index] = info;
  return next;
};

/** The sessions after a change `sessions.changes` reports. */
export const applySessionsChange = (sessions: readonly SessionInfo[], change: Exclude<SessionsChange, { type: "subscribed" }>): SessionInfo[] =>
  change.type === "session-removed" ? sessions.filter((session) => session.id !== change.sessionId) : upsertSession(sessions, change.info);

/**
 * A log with `incoming` added: those past its last event. `sessions.log`
 * sends each event once and in order, and a stream reopened after the last
 * event a reader has resumes there, so what it sends follows on; one at or
 * before the last (a log read just before) is already there.
 */
export const appendLog = (events: readonly SessionEvent[], incoming: readonly SessionEvent[]): readonly SessionEvent[] => {
  const last = events.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((event) => event.seq > last);
  return fresh.length === 0 ? events : [...events, ...fresh];
};

/**
 * The leaf to render. `SessionInfo.leaf` can lag the log while a turn appends
 * (the `session-changed` travels separately), so events newer than the info's
 * `lastSeq` that descend from its leaf win. Otherwise the reported leaf is
 * authoritative, including a checkout of an earlier event on the same branch.
 */
export const resolveLeaf = (events: readonly SessionEvent[], leaf: string | undefined, lastSeq = 0): string | undefined => {
  const newest = events.at(-1);
  if (newest === undefined) return undefined;
  if (leaf === undefined || !events.some((event) => event.id === leaf)) return newest.id;
  if (leaf === newest.id || newest.seq <= lastSeq) return leaf;
  return branchOf(events, newest.id).some((event) => event.id === leaf) ? newest.id : leaf;
};

export const sessionTitle = (session: SessionInfo | undefined): string => session?.title?.trim() || "New thread";

interface TurnTracking {
  /** Sessions with a turn in progress. */
  readonly running: readonly string[];
  /** The last ended turn per session. */
  readonly ended: Readonly<Record<string, string>>;
}

/**
 * Running sessions after a live turn event. The host delivers `turn-started`
 * and `turn-ended` on separate queues, so an end can overtake its own start;
 * a start for the turn that already ended is ignored.
 */
export const trackTurn = (
  tracking: TurnTracking,
  event: { readonly type: "turn-started" | "turn-ended"; readonly sessionId: string; readonly turnId: string },
): TurnTracking => {
  const { running, ended } = tracking;
  if (event.type === "turn-ended") {
    return { running: running.filter((id) => id !== event.sessionId), ended: { ...ended, [event.sessionId]: event.turnId } };
  }
  if (ended[event.sessionId] === event.turnId || running.includes(event.sessionId)) return tracking;
  return { running: [...running, event.sessionId], ended };
};

/** A session's queue as last reported, with its revision. */
export interface KnownQueue {
  readonly queue: readonly QueuedPrompt[];
  readonly revision: number;
}

/**
 * Whichever report of a queue is newer: a `queue-changed` event and a view
 * fetched alongside it can arrive in either order, and the older must not
 * bring back prompts since placed or withdrawn, or hide ones since queued.
 */
export const newerQueue = (known: KnownQueue | undefined, report: KnownQueue): KnownQueue =>
  known === undefined || report.revision >= known.revision ? report : known;
