import { fileSummary } from "@lemma/threads/summary";
import type { ToolView } from "@lemma/threads";

/** How the web app shows a `write` call: the file written. */
export const writeView: ToolView = {
  icon: "pencil",
  summary: fileSummary,
  streaming: "path",
  action: ["changed", "file", "files"],
};
