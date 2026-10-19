import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { patchView } from "./view.ts";

/** The web half of `tools.patch`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.patch",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "apply_patch", ...patchView });
  },
});
