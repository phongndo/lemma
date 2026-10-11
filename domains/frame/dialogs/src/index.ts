import { createSignal } from "solid-js";
import { Dialogs } from "@lemma/frame";
import { defineWebPlugin } from "@lemma/web";

/** Which dialog is open, by id; each dialog plugin shows itself when it is its turn. */
export default defineWebPlugin({
  id: "frame.dialogs",
  provides: { dialogs: Dialogs },
  setup: () => {
    const [current, setCurrent] = createSignal<string>();
    return { dialogs: { current, open: (id: string | undefined) => void setCurrent(id) } };
  },
});
