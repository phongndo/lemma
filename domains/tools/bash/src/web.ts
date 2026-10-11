import { ToolViews } from "@lemma/threads";
import { Slots, defineUiPlugin } from "@lemma/ui";
import { bashView } from "./view.ts";

/** The web half of `tools.bash`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineUiPlugin({
  id: "tools.bash",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "bash", ...bashView });
  },
});
