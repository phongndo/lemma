import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { htmlRenderView } from "./view.tsx";
import styles from "./html.css?inline";

/** The web half of `tools.html`: `html_render`'s pages, drawn in the chat, and how its calls show. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.html",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "html_render", ...htmlRenderView });
  },
});
