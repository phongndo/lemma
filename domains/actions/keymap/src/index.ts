import { Schema } from "effect";
import { typing } from "@lemma/web/keys";
import { Actions, ACTIONS_CONTRACT, KEYMAP_PLUGIN, parseBindings } from "@lemma/actions";
import { Dialogs } from "@lemma/frame";
import { Interactions, Slots, defineWebPlugin } from "@lemma/web";
import { createKeymap } from "./keymap.ts";

const KeymapConfig = Schema.Struct({
  bindings: Schema.optional(Schema.Array(Schema.String)).annotate({
    title: "Shortcuts",
    description:
      "One line per action, replacing its own keys: `shell.toggle-sidebar = mod+b, mod+k` (nothing after = unbinds it). Settings › Keyboard writes these.",
  }),
});

/**
 * Keyboard shortcuts: every action's keys, the user's `bindings` over its own.
 * The first action in order whose keys match and whose `when` holds runs.
 * While a dialog or question is open only `global` actions do, and a key
 * without a modifier waits until focus leaves a text field unless the action
 * says `whileTyping`. Modifiers held down a moment tell the actions one
 * more key would run (`onHold`).
 */
export default defineWebPlugin({
  id: KEYMAP_PLUGIN,
  implements: [ACTIONS_CONTRACT],
  config: KeymapConfig,
  requires: { slots: Slots, dialogs: Dialogs, interactions: Interactions },
  setup: ({ slots, dialogs, interactions }, plugin) => {
    const keymap = createKeymap({
      actions: () => slots.list(Actions),
      overrides: parseBindings(plugin.config.bindings ?? []),
      placeOf: (event) => ({
        // A question some view shows itself (the palette's) is that view's; one the question dialog shows is a modal.
        modal: dialogs.current() !== undefined || interactions.open().some((request) => !interactions.claimed(request)),
        inField: typing(event.target),
      }),
      after: plugin.after,
      // What an action throws is the fault of the plugin that added it, not the keymap's: it leaves the slot.
      failed: (action, error) => slots.fail(Actions, action, error),
    });
    plugin.listen(document, "keydown", keymap.keydown);
    plugin.listen(document, "keyup", keymap.keyup);
    // Leaving the window, as switching apps does, lets go.
    plugin.listen(window, "blur", keymap.letGo);
    plugin.onCleanup(keymap.letGo);
  },
});
