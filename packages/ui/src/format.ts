export const relativeTime = (at: number, now: number = Date.now()): string => {
  const s = Math.round((now - at) / 1_000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d > 300 ? { year: "numeric" } : {}) });
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
