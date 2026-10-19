import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { patchTool } from "./patch.ts";

export { patchTool, PatchInput } from "./patch.ts";
export type { PatchDetails, PatchedFile } from "./patch.ts";

/** The `apply_patch` tool. */
export default definePlugin({
  id: "tools.patch",
  version: "0.1.0",
  setup: function* (_, owner) {
    yield* owner.add(Tools, patchTool);
  },
});
