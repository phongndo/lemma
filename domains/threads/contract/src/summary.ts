import { displayPath } from "@lemma/web/format";

/** The value of string field `key` in possibly incomplete JSON (streamed tool arguments). */
export const partialStringField = (json: string, key: string): string | undefined => {
  // The key comes from any plugin's `ToolView.streaming`: matched as text, not as a pattern.
  const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (match === null) return undefined;
  const raw = match[1]!.replace(/\\$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

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

/** A call's summary for a tool whose `path` argument names the file it acts on: the path as shown (`displayPath`), with its icon. */
export const fileSummary = (args: Record<string, unknown> | undefined, context: { readonly cwd?: string; readonly home?: string }): ToolSummary => {
  const path = typeof args?.path === "string" && args.path !== "" ? displayPath(args.path, context.cwd, context.home) : undefined;
  return path === undefined ? {} : { primary: path, file: { path, kind: "file" } };
};

/** A call's summary when its tool's view gives none: its first short, one-line string argument. */
export const summarizeArgs = (args: Record<string, unknown> | undefined): ToolSummary => {
  for (const value of Object.values(args ?? {})) {
    if (typeof value === "string" && value !== "" && value.length <= 200 && !value.includes("\n")) return { primary: value };
  }
  return {};
};

export const truncateLines = (text: string, max: number): { readonly text: string; readonly hidden: number } => {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
};
