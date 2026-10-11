import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { writeView } from "./view.ts";

/** The web half of `tools.write`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.write",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "write", ...writeView });
  },
});
