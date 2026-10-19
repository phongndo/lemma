import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { readTool } from "./read.ts";

export { readTool, ReadInput, ReadOutput } from "./read.ts";
export type { ReadDetails } from "./read.ts";

/** The `read` tool. */
export default definePlugin({
  id: "tools.read",
  version: "0.1.0",
  setup: function* (_, owner) {
    yield* owner.add(Tools, readTool);
  },
});
