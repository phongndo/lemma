import { displayPath } from "@lemma/ui/format";
import type { ToolView } from "@lemma/threads";

/** How the web app shows a `edit` call: the file changed. */
export const editView: ToolView = {
  icon: "pencil",
  summary: (args, context) => {
    const path = typeof args?.path === "string" && args.path !== "" ? displayPath(args.path, context.cwd, context.home) : undefined;
    return path === undefined ? {} : { primary: path, file: { path, kind: "file" } };
  },
  streaming: "path",
  action: ["changed", "file", "files"],
};
