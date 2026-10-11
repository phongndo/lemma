import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { writeTool } from "./write.ts";

export { writeTool, WriteInput } from "./write.ts";

/** The `write` tool. */
export default definePlugin({
  id: "tools.write",
  version: "0.1.0",
  setup: function* (_, owner) {
    yield* owner.add(Tools, writeTool);
  },
});
