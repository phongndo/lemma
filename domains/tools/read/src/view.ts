import { displayPath } from "@lemma/web/format";
import type { ToolView } from "@lemma/threads";

/** How the web app shows a `read` call: the file and the lines read. */
export const readView: ToolView = {
  icon: "file",
  summary: (args, context) => {
    const path = typeof args?.path === "string" && args.path !== "" ? displayPath(args.path, context.cwd, context.home) : undefined;
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const limit = typeof args?.limit === "number" ? args.limit : undefined;
    const range =
      offset === undefined && limit === undefined ? undefined : `lines ${offset ?? 1}${limit === undefined ? "+" : `–${(offset ?? 1) + limit - 1}`}`;
    return { ...(path === undefined ? {} : { primary: path, file: { path, kind: "file" as const } }), ...(range === undefined ? {} : { secondary: range }) };
  },
  streaming: "path",
  action: ["read", "file", "files"],
};
