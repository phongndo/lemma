import { Schema } from "effect";
import { bindsTyping, matchesKeys, typing } from "../lib/keys.ts";
import { KEYMAP_PLUGIN, keysFor, parseBindings } from "../model/keybindings.ts";
import { ActionIds, Actions, Dialogs, Interactions, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

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
 * says `whileTyping`.
 */
export default defineUiPlugin({
  id: KEYMAP_PLUGIN,
  config: KeymapConfig,
  requires: { slots: Slots, dialogs: Dialogs, interactions: Interactions },
  setup: ({ slots, dialogs, interactions }, plugin) => {
    const overrides = parseBindings(plugin.config.bindings ?? []);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // A question some view shows itself (the palette's) is that view's; one the question dialog shows is a modal.
      const modal = dialogs.current() !== undefined || interactions.open().some((request) => !interactions.claimed(request));
      const inField = typing(event.target);
      for (const action of slots.list(Actions)) {
        if (modal && !action.global) continue;
        const binding = keysFor(action.id, action.keys, overrides).find((candidate) => matchesKeys(candidate, event));
        if (binding === undefined || (inField && bindsTyping(binding) && !action.whileTyping)) continue;
        if (action.when !== undefined && !action.when()) continue;
        event.preventDefault();
        // One that needs a value asks for it in the palette, as picking it there would.
        const palette = action.input === undefined ? undefined : slots.get(Actions, ActionIds.palette);
        if (palette !== undefined) palette.run(action.id);
        else action.run();
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    plugin.onCleanup(() => document.removeEventListener("keydown", onKey));
  },
});
