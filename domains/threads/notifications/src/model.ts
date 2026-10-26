import type { AttentionState, ThreadAttention } from "@lemma/threads";

/** The states a thread tells the person of: it waits on them, or a turn failed or finished. At work, it tells nobody. */
export type Told = Exclude<AttentionState, "working">;
export const TOLD: readonly Told[] = ["waiting", "failed", "done"];

/**
 * How a state reaches the person: a notice in the app while they are looking at it, a system notification while they
 * are not, a count on the app's icon (and the page's title), a sound.
 */
export type Channel = "notice" | "system" | "badge" | "sound";
export const CHANNELS: readonly Channel[] = ["notice", "system", "badge", "sound"];

/** Where the app's notices stack. */
export type Corner = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export const CORNERS: readonly Corner[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

/** What the person chose: the channels each state reaches them by, and where notices stack. */
export interface Prefs {
  readonly channels: Readonly<Record<Told, readonly Channel[]>>;
  readonly corner: Corner;
}

/**
 * Everything for what needs the person; a finished turn makes no sound. Notices stack at the top right, under the
 * header and the toasts, clear of the composer and its send button.
 */
export const DEFAULT_PREFS: Prefs = {
  channels: {
    waiting: ["notice", "system", "badge", "sound"],
    failed: ["notice", "system", "badge", "sound"],
    done: ["notice", "system", "badge"],
  },
  corner: "top-right",
};

const isChannel = (value: unknown): value is Channel => typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
const isCorner = (value: unknown): value is Corner => typeof value === "string" && (CORNERS as readonly string[]).includes(value);

/** Prefs as stored, as far as they read: a state or field missing or of another shape keeps its default. */
export const readPrefs = (stored: unknown): Prefs => {
  if (typeof stored !== "object" || stored === null) return DEFAULT_PREFS;
  const { channels, corner } = stored as { readonly channels?: unknown; readonly corner?: unknown };
  const of = (state: Told): readonly Channel[] => {
    const value = typeof channels === "object" && channels !== null ? (channels as Record<string, unknown>)[state] : undefined;
    return Array.isArray(value) ? CHANNELS.filter((channel) => value.some((item) => isChannel(item) && item === channel)) : DEFAULT_PREFS.channels[state];
  };
  return { channels: { waiting: of("waiting"), failed: of("failed"), done: of("done") }, corner: isCorner(corner) ? corner : DEFAULT_PREFS.corner };
};

/** Prefs with `channel` on or off for `state`, the channels kept in their own order. */
export const withChannel = (prefs: Prefs, state: Told, channel: Channel, on: boolean): Prefs => {
  const now = new Set(prefs.channels[state]);
  if (on) now.add(channel);
  else now.delete(channel);
  return { ...prefs, channels: { ...prefs.channels, [state]: CHANNELS.filter((item) => now.has(item)) } };
};

export const tellsBy = (prefs: Prefs, state: Told, channel: Channel): boolean => prefs.channels[state].includes(channel);

/** A thread newly telling the person something: it began waiting (or waits on something new), or a turn failed or finished. */
export interface Arrival {
  readonly sessionId: string;
  readonly state: Told;
  readonly label: string;
  readonly since: number;
}

/**
 * What `after` tells that `before` did not: each thread now in a state it tells (`Told`) whose state, label, or time
 * changed, but those `quiet` keeps quiet (the thread the person is looking at; an agent's finished turn, which its
 * thread goes on with).
 */
export const arrivals = (
  before: ReadonlyMap<string, ThreadAttention>,
  after: ReadonlyMap<string, ThreadAttention>,
  quiet: (sessionId: string, state: Told) => boolean,
): Arrival[] => {
  const told: Arrival[] = [];
  for (const [sessionId, now] of after) {
    if (now.state === "working") continue;
    const was = before.get(sessionId);
    if (was !== undefined && was.state === now.state && was.label === now.label && was.since === now.since) continue;
    if (quiet(sessionId, now.state)) continue;
    told.push({ sessionId, state: now.state, label: now.label, since: now.since });
  }
  return told;
};

/**
 * How many threads the app's icon counts: those in a state whose badge is on, but an agent's finished or failed turn
 * (its thread counts what needs the person).
 */
export const badgeCount = (attention: ReadonlyMap<string, ThreadAttention>, prefs: Prefs, isAgent: (sessionId: string) => boolean): number => {
  let count = 0;
  for (const [sessionId, item] of attention) {
    if (item.state === "working" || !tellsBy(prefs, item.state, "badge")) continue;
    if (item.state !== "waiting" && isAgent(sessionId)) continue;
    count++;
  }
  return count;
};

/** The page's title with the count in front, as a browser tab shows it: `(2) lemma`; the title alone for none. */
export const countedTitle = (title: string, count: number): string => (count > 0 ? `(${count}) ${title}` : title);
