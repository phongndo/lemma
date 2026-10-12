import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { findView, grepView } from "./view.ts";

/** The web half of `tools.search-fff`: how `grep` and `find` calls show in the chat and the trajectory. It runs while the tools do. */
export default defineWebPlugin({
  id: "tools.search-fff",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "grep", ...grepView });
    slots.add(ToolViews, { id: "find", ...findView });
  },
});
