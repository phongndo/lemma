import { ToolViews } from "@lemma/threads";
import { Slots, defineUiPlugin } from "@lemma/ui";
import { editView } from "./view.ts";

/** The web half of `tools.edit`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineUiPlugin({
  id: "tools.edit",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "edit", ...editView });
  },
});
