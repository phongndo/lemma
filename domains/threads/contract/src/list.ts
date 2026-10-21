import { HostError } from "@lemma/contracts";
import { branchOf, SessionChannels } from "@lemma/sessions";
import type { QueuedPrompt } from "@lemma/agent";
import type { SessionEvent, SessionInfo, SessionsChange } from "@lemma/sessions";

/** Nothing has gone into it yet: a blank thread, as a new tab is, which lists leave out until it has a prompt. */
export const isBlank = (session: SessionInfo): boolean => session.lastSeq === 0;

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
  // A new array, as what read the last one holds it: `concat` copies one of 100,000 events in half the time a spread takes.
  return fresh.length === 0 ? events : events.concat(fresh);
};

/**
 * What the open thread says when its `sessions.log` ends, or undefined when
 * following it carries on by itself: its plugin left (`Withdrawn`), the
 * channel is not served for now (`NotFound` or `Unavailable` naming the
 * channel: `sessions` being replaced, the host starting), or the connection
 * dropped (not a `HostError`). What names the session (it is gone, its log
 * unreadable) is said.
 */
export const logFailure = (error: unknown): string | undefined => {
  if (!(error instanceof HostError) || error.code === "Withdrawn") return undefined;
  if (error.subject === SessionChannels.log.id && (error.code === "NotFound" || error.code === "Unavailable")) return undefined;
  return error.message;
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
  if (leaf === undefined || !hasEvent(events, leaf)) return newest.id;
  if (leaf === newest.id || newest.seq <= lastSeq) return leaf;
  return (descends(events, newest.id, leaf) ?? branchOf(events, newest.id).some((event) => event.id === leaf)) ? newest.id : leaf;
};

/** A branch (`branchOf`), with the log and leaf it was read from. */
export interface WalkedBranch {
  readonly events: readonly SessionEvent[];
  readonly leaf: string | undefined;
  readonly branch: readonly SessionEvent[];
}

/**
 * The branch to `leaf` in `events`, carried on from `last` when `events` is `last`'s log grown at its end and the
 * events added lead from `last`'s leaf to `leaf`, read back from the leaf: `last`'s branch itself when the leaf is
 * unchanged. Undefined otherwise (a checkout, a branch of its own in what was added, another log), for `branchOf`,
 * which maps the whole log: a client following a log calls this on every event appended.
 */
export const growBranch = (last: WalkedBranch, events: readonly SessionEvent[], leaf: string | undefined): readonly SessionEvent[] | undefined => {
  const from = last.events.length;
  if (from === 0 || events.length < from || events[from - 1] !== last.events[from - 1]) return undefined;
  if (leaf === last.leaf) return last.branch;
  if (leaf === undefined || last.leaf === undefined) return undefined;
  const tail: SessionEvent[] = [];
  let wanted: string | null = leaf;
  for (let at = events.length - 1; at >= from && wanted !== null; at--) {
    const event = events[at]!;
    if (event.id !== wanted) continue;
    tail.push(event);
    if (event.parent === last.leaf) return last.branch.concat(tail.reverse());
    wanted = event.parent;
  }
  return undefined;
};

/** Whether the log has `id`, looked for from its end, where a leaf usually is. */
const hasEvent = (events: readonly SessionEvent[], id: string): boolean => {
  for (let at = events.length - 1; at >= 0; at--) if (events[at]!.id === id) return true;
  return false;
};

/**
 * Whether `ancestor` is on the branch ending at `from`, read back from the log's end without mapping it (this runs on
 * every event appended, and a log may hold a hundred thousand): in a log in order, a parent comes before its child.
 * Undefined when the log is not in that order, so the walk cannot tell.
 */
const descends = (events: readonly SessionEvent[], from: string, ancestor: string): boolean | undefined => {
  let wanted: string | null = from;
  for (let at = events.length - 1; at >= 0 && wanted !== null; at--) {
    const event = events[at]!;
    if (event.id !== wanted) continue;
    if (event.id === ancestor) return true;
    wanted = event.parent;
  }
  return wanted === null ? false : undefined;
};

export const sessionTitle = (session: SessionInfo | undefined): string => session?.title?.trim() || "Thread";

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
