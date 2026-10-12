import { Schema } from "effect";
import { bindsTyping, matchesKeys, typing } from "@lemma/web/keys";
import { KEYMAP_PLUGIN, keysFor, parseBindings, ActionIds, Actions } from "@lemma/actions";
import { Dialogs } from "@lemma/frame";
import { Interactions, Slots, defineWebPlugin } from "@lemma/web";

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
export default defineWebPlugin({
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
        // What an action throws is the fault of the plugin that added it, not the keymap's: it leaves the slot.
        const failed = (item: typeof action) => (error: unknown) => slots.fail(Actions, item, error);
        try {
          if (action.when !== undefined && !action.when()) continue;
        } catch (error) {
          failed(action)(error);
          continue;
        }
        event.preventDefault();
        // One that needs a value asks for it in the palette, as picking it there would.
        const palette = action.input === undefined ? undefined : slots.get(Actions, ActionIds.palette);
        const runs = palette ?? action;
        try {
          const result: unknown = palette !== undefined ? palette.run(action.id) : action.run();
          if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") (result as PromiseLike<unknown>).then(undefined, failed(runs));
        } catch (error) {
          failed(runs)(error);
        }
        return;
      }
    };
    plugin.listen(document, "keydown", onKey);
  },
});
