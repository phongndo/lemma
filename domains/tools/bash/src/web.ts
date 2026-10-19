import { ToolViews } from "@lemma/threads";
import { HostPlugins, Notify, Slots, defineWebPlugin } from "@lemma/web";
import { addSettings } from "./settings.tsx";
import { bashView } from "./view.ts";

/**
 * The web half of `tools.bash`: how its calls show in the chat and the trajectory, and its default timeout in
 * General › Agent. It runs while the tool does.
 */
export default defineWebPlugin({
  id: "tools.bash",
  requires: { slots: Slots, host: HostPlugins, notify: Notify },
  setup: ({ slots, host, notify }, plugin) => {
    slots.add(ToolViews, { id: "bash", ...bashView });
    addSettings(slots, host, notify, plugin.id);
  },
});
