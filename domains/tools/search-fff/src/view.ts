import { displayPath } from "@lemma/web/format";
import type { ToolSummary, ToolView } from "@lemma/threads";

const summary = (args: Record<string, unknown> | undefined, context: { readonly cwd?: string; readonly home?: string }): ToolSummary => {
  const pattern = typeof args?.pattern === "string" ? args.pattern : "";
  const path = typeof args?.path === "string" && args.path !== "" ? displayPath(args.path, context.cwd, context.home) : undefined;
  if (pattern === "") return path === undefined ? {} : { primary: path };
  return { primary: pattern, ...(path === undefined ? {} : { secondary: `in ${path}` }) };
};

/** How the web app shows a `grep` call: the pattern, and where it searched. */
export const grepView: ToolView = { icon: "search", summary, streaming: "pattern", action: ["searched for", "pattern", "patterns"] };

/** How the web app shows a `find` call: the query, and where it looked. */
export const findView: ToolView = { icon: "search", summary, streaming: "pattern", action: ["looked for", "file", "files"] };
