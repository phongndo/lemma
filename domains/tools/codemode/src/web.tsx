import { ToolViews } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { codemodeView } from "./view.tsx";
import styles from "./codemode.css?inline";

/** The web half of `tools.codemode`: how its calls show, their calls live as they run, and the pages they drew. It runs while the tool does. */
export default defineWebPlugin({
  id: "tools.codemode",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(ToolViews, { id: "codemode", ...codemodeView(slots) });
  },
});
