/**
 * How long ago `at` was (epoch ms), in the largest unit it counts, rounded to the nearest: `{ count: 4, unit: "h" }`.
 * Undefined under 45 seconds, which is just now. Every age Lemma shows counts from this, so a thread is as old in one
 * place as in another.
 */
export const ageOf = (at: number, now: number = Date.now()): { readonly count: number; readonly unit: "m" | "h" | "d" } | undefined => {
  const s = Math.round((now - at) / 1_000);
  if (s < 45) return undefined;
  const m = Math.round(s / 60);
  if (m < 60) return { count: m, unit: "m" };
  const h = Math.round(m / 60);
  if (h < 24) return { count: h, unit: "h" };
  return { count: Math.round(h / 24), unit: "d" };
};

/** How long ago `at` was, in words: `just now`, `36m ago`, `4h ago`, `2d ago`; from a week, its date. */
export const relativeTime = (at: number, now: number = Date.now()): string => {
  const age = ageOf(at, now);
  if (age === undefined) return "just now";
  if (age.unit !== "d" || age.count < 7) return `${age.count}${age.unit} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(age.count > 300 ? { year: "numeric" } : {}) });
};

/** The time of day of `at` (epoch ms) to the millisecond: `14:03:07.042`. */
export const clockTime = (at: number): string => {
  const date = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

/** `/home/me/code/x` → `~/code/x`. */
export const tildePath = (path: string, home: string | undefined): string => {
  if (home === undefined || home === "" || home === "/") return path;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
};

/** Relative to `cwd` when inside it; otherwise tilde-shortened. */
export const displayPath = (path: string, cwd: string | undefined, home: string | undefined): string => {
  if (cwd !== undefined && cwd !== "") {
    const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
    if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  }
  return tildePath(path, home);
};
