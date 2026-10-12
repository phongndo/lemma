import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { bashView } from "./view.ts";

/** The web half of `tools.bash`: how its calls show in the chat and the trajectory. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.bash",
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "bash", ...bashView });
  },
});
