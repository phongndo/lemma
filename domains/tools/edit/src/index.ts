import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { editTool } from "./edit.ts";

export { editTool, EditInput } from "./edit.ts";
export { applyEditsToNormalizedContent } from "./edit-diff.ts";
export type { EditDetails } from "./edit.ts";

/** The `edit` tool. */
export default definePlugin({
  id: "tools.edit",
  version: "0.1.0",
  setup: function* (_, owner) {
    yield* owner.add(Tools, editTool);
  },
});
