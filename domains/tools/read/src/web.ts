import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { readView } from "./view.ts";

/** The web half of `tools.read`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.read",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "read", ...readView });
  },
});
