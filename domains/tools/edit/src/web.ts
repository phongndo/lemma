import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { editView } from "./view.ts";

/** The web half of `tools.edit`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.edit",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "edit", ...editView });
  },
});
