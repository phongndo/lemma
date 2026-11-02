import { fileSummary } from "@lemma/threads/summary";
import type { ToolView } from "@lemma/threads";

/** How the web app shows an `edit` call: the file changed. */
export const editView: ToolView = {
  icon: "pencil",
  summary: fileSummary,
  streaming: "path",
  action: ["changed", "file", "files"],
};
