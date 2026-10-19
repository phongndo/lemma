import { patchPaths } from "@lemma/tools/patch";
import { displayPath } from "@lemma/web/format";
import type { ToolView } from "@lemma/threads";

/**
 * How the web app shows an `apply_patch` call: the files its patch names, the first with its icon. Opened, the chat
 * shows the diff of every file it changed (`details.patch`).
 */
export const patchView: ToolView = {
  icon: "pencil",
  summary: (args, context) => {
    const paths = typeof args?.input === "string" ? patchPaths(args.input).map((path) => displayPath(path, context.cwd, context.home)) : [];
    const [first] = paths;
    if (first === undefined) return {};
    return { primary: first, file: { path: first, kind: "file" }, ...(paths.length > 1 ? { secondary: `and ${paths.length - 1} more` } : {}) };
  },
  action: ["applied", "patch", "patches"],
};
