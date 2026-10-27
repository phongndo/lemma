import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/tools";
import { FffIndexes } from "@lemma/workspace/fff";
import { findTool, grepTool } from "./tools.ts";

export { findTool, grepTool, FindInput, GrepInput, GREP_TIME_BUDGET_MS, SCAN_WAIT_MS } from "./tools.ts";
export type { SearchDetails } from "./tools.ts";

/** The `grep` and `find` tools, over the fff index of each directory searched, which `workspace.search-fff` keeps. */
export default definePlugin({
  id: "tools.search-fff",
  version: "0.1.0",
  requires: { indexes: FffIndexes },
  setup: function* ({ indexes }, owner) {
    yield* owner.add(Tools, grepTool(indexes));
    yield* owner.add(Tools, findTool(indexes));
  },
});
