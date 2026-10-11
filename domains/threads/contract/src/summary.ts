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
