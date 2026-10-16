import type { SessionInfo } from "@lemma/sessions";

export interface DayGroup {
  readonly label: string;
  readonly sessions: readonly SessionInfo[];
}

const DAY = 86_400_000;

/** Midnight before `at`, local time. */
const startOfDay = (at: number): number => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Which group a thread last used at `at` falls in, seen at `now`. */
export const dayLabel = (at: number, now: number): string => {
  const today = startOfDay(now);
  if (at >= today) return "Today";
  if (at >= today - DAY) return "Yesterday";
  if (at >= today - 7 * DAY) return "Previous 7 days";
  if (at >= today - 30 * DAY) return "Previous 30 days";
  const date = new Date(at);
  return date.toLocaleDateString(undefined, { month: "long", ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
};

/** Threads newest first, in runs by when they were last used. */
export const byDay = (sessions: readonly SessionInfo[], now: number): readonly DayGroup[] => {
  const groups: { label: string; sessions: SessionInfo[] }[] = [];
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const label = dayLabel(session.updatedAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.sessions.push(session);
    else groups.push({ label, sessions: [session] });
  }
  return groups;
};
