import type { Usage } from "@lemma/contracts";

export const formatTokens = (n: number): string => {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
};

export const formatCost = (usd: number): string => {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

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

export interface UsageSummary {
  readonly input: string;
  readonly output: string;
  readonly cache?: string;
  readonly cost?: string;
  readonly title: string;
}

/** Compact footer text plus a detailed tooltip. Input includes cache reads/writes, as providers bill them. */
export const summarizeUsage = (usage: Usage): UsageSummary => {
  const cached = usage.cacheRead + usage.cacheWrite;
  const lines = [
    `Input ${(usage.input + cached).toLocaleString()} tokens`,
    `Output ${usage.output.toLocaleString()} tokens${usage.reasoning ? ` (${usage.reasoning.toLocaleString()} reasoning)` : ""}`,
    `Cache read ${usage.cacheRead.toLocaleString()}, write ${usage.cacheWrite.toLocaleString()}`,
    `Cost ${formatCost(usage.cost.total)} (in ${formatCost(usage.cost.input)}, out ${formatCost(usage.cost.output)}, cache ${formatCost(usage.cost.cacheRead + usage.cost.cacheWrite)})`,
  ];
  return {
    input: formatTokens(usage.input + cached),
    output: formatTokens(usage.output),
    ...(cached === 0 ? {} : { cache: `${formatTokens(usage.cacheRead)}${usage.cacheWrite ? ` +${formatTokens(usage.cacheWrite)}` : ""}` }),
    ...(usage.cost.total === 0 ? {} : { cost: formatCost(usage.cost.total) }),
    title: lines.join("\n"),
  };
};

/** The value of string field `key` in possibly incomplete JSON (streamed tool arguments). */
export const partialStringField = (json: string, key: string): string | undefined => {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (match === null) return undefined;
  const raw = match[1]!.replace(/\\$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export interface ToolSummary {
  /** Short primary argument: a command, a path, a pattern. */
  readonly primary?: string;
  /** Secondary detail, e.g. a line range or search root. */
  readonly secondary?: string;
  /** Primary is a shell command (render as `$ cmd`). */
  readonly shell?: boolean;
  /** The file or folder the call acts on, shown with its icon (the `file-icon` part). */
  readonly file?: { readonly path: string; readonly kind: "file" | "directory" };
}

/**
 * One-line summary of a tool call's arguments for pi's built-ins (read, write,
 * edit, bash, grep, find, ls) with a generic fallback: the first short string argument.
 */
export const summarizeToolArgs = (
  name: string,
  args: Record<string, unknown> | undefined,
  context: { readonly cwd?: string; readonly home?: string } = {},
): ToolSummary => {
  if (args === undefined) return {};
  const path = (value: unknown) => {
    const p = str(value);
    return p === undefined ? undefined : displayPath(p, context.cwd, context.home);
  };
  switch (name) {
    case "bash": {
      const command = str(args.command);
      return command === undefined ? {} : { primary: command, shell: true };
    }
    case "read": {
      const p = path(args.path ?? args.file_path);
      const offset = num(args.offset);
      const limit = num(args.limit);
      const range =
        offset !== undefined || limit !== undefined ? `lines ${offset ?? 1}${limit !== undefined ? `–${(offset ?? 1) + limit - 1}` : "+"}` : undefined;
      return { ...(p === undefined ? {} : { primary: p, file: { path: p, kind: "file" } }), ...(range === undefined ? {} : { secondary: range }) };
    }
    case "write":
    case "edit":
    case "ls": {
      const p = path(args.path ?? args.file_path);
      return p === undefined ? {} : { primary: p, file: { path: p, kind: name === "ls" ? "directory" : "file" } };
    }
    case "grep":
    case "find": {
      const pattern = str(args.pattern) ?? str(args.glob) ?? str(args.query);
      const p = path(args.path);
      return { ...(pattern === undefined ? {} : { primary: pattern }), ...(p === undefined ? {} : { secondary: `in ${p}` }) };
    }
    default: {
      for (const value of Object.values(args)) {
        const s = str(value);
        if (s !== undefined && s.length <= 200 && !s.includes("\n")) return { primary: s };
      }
      return {};
    }
  }
};

/** The primary argument while the call is still streaming. */
export const summarizePartialArgs = (name: string, json: string): string | undefined => {
  const key = name === "bash" ? "command" : name === "grep" || name === "find" ? "pattern" : "path";
  return partialStringField(json, key);
};

export const truncateLines = (text: string, max: number): { readonly text: string; readonly hidden: number } => {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
};

/** A branch name for a new worktree from the first message: `lemma/fix-login-redirect`. */
export const branchSlug = (text: string): string => {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const slug = words.join("-").replace(/-+/g, "-").slice(0, 40).replace(/-+$/, "");
  return `lemma/${slug === "" ? "task" : slug}`;
};

/** A context window for display: `1_000_000` → `1M`, `203_000` → `203K`. */
export const contextSize = (tokens: number): string => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
