import { displayPath } from "@lemma/ui/format";

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
