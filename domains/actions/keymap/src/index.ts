import { Schema } from "effect";
import { bindingOf, bindsTyping, holdsKeys, matchesKeys, typing } from "@lemma/web/keys";
import { ActionIds, Actions, ACTIONS_CONTRACT, KEYMAP_PLUGIN, keysFor, parseBindings } from "@lemma/actions";
import type { Action } from "@lemma/actions";
import { Dialogs } from "@lemma/frame";
import { Interactions, Slots, defineWebPlugin } from "@lemma/web";
import type { SlotItem } from "@lemma/web";

/** How long modifiers are held down alone before the actions they would run hear it: a shortcut pressed at once (⌘C) passes first. */
const HOLD_DELAY = 200;

/** Where a key goes, as actions' keys care. */
interface Place {
  readonly modal: boolean;
  readonly inField: boolean;
}

type Item = SlotItem<Action>;

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
    const overrides = parseBindings(plugin.config.bindings ?? []);
    // What an action throws is the fault of the plugin that added it, not the keymap's: it leaves the slot.
    const failed = (item: Item) => (error: unknown) => slots.fail(Actions, item, error);
    /** Where a key goes, as actions' keys care: under a dialog or question, which holds them back, or into a text field. */
    const placeOf = (event: KeyboardEvent): Place => ({
      // A question some view shows itself (the palette's) is that view's; one the question dialog shows is a modal.
      modal: dialogs.current() !== undefined || interactions.open().some((request) => !interactions.claimed(request)),
      inField: typing(event.target),
    });
    /** The first of `action`'s keys that `matches`, while it would run on them at `place`: held back by nothing, and offered (`when`). */
    const runsOn = (action: Item, place: Place, matches: (binding: string) => boolean): string | undefined => {
      if (place.modal && !action.global) return undefined;
      const binding = keysFor(action.id, action.keys, overrides).find(matches);
      if (binding === undefined || (place.inField && bindsTyping(binding) && !action.whileTyping)) return undefined;
      try {
        return action.when === undefined || action.when() ? binding : undefined;
      } catch (error) {
        failed(action)(error);
        return undefined;
      }
    };
    /** Runs the first action `event` presses the keys of; whether one ran. */
    const onKey = (event: KeyboardEvent): boolean => {
      if (event.defaultPrevented || event.isComposing) return false;
      const place = placeOf(event);
      for (const action of slots.list(Actions)) {
        if (runsOn(action, place, (candidate) => matchesKeys(candidate, event)) === undefined) continue;
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
        return true;
      }
      return false;
    };

    // Modifiers held down a moment, with nothing else, tell the actions one more key would run (`onHold`), and they hear
    // again once that ends.
    let told: Item[] = [];
    let waiting: (() => void) | undefined;
    const tell = (action: Item, binding: string | undefined) => {
      try {
        action.onHold?.(binding);
      } catch (error) {
        failed(action)(error);
      }
    };
    const letGo = () => {
      waiting?.();
      waiting = undefined;
      for (const action of told) tell(action, undefined);
      told = [];
    };
    const hold = (event: KeyboardEvent) => {
      letGo();
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return;
      waiting = plugin.after(HOLD_DELAY, () => {
        waiting = undefined;
        const listening = slots.list(Actions).filter((action) => action.onHold !== undefined);
        // Only the bindings they listen for, and as a key would: each runs the first action it matches.
        const wanted = new Set(listening.flatMap((action) => keysFor(action.id, action.keys, overrides)).filter((binding) => holdsKeys(binding, event)));
        if (wanted.size === 0) return;
        const place = placeOf(event);
        const taken = new Set<string>();
        for (const action of slots.list(Actions)) {
          const binding = runsOn(action, place, (candidate) => wanted.has(candidate) && !taken.has(candidate));
          if (binding === undefined) continue;
          taken.add(binding);
          if (action.onHold === undefined) continue;
          told.push(action);
          tell(action, binding);
        }
      });
    };

    plugin.listen(document, "keydown", (event) => {
      const ran = onKey(event);
      // A modifier pressed or let go changes what is held; a key pressed with it that runs nothing (⌘C) ends the hold
      // until the next change. A key held down repeats its press.
      if (bindingOf(event) === undefined) {
        if (!event.repeat) hold(event);
      } else if (!ran) letGo();
    });
    plugin.listen(document, "keyup", (event) => {
      if (bindingOf(event) === undefined) hold(event);
    });
    // Leaving the window, as switching apps does, lets go.
    plugin.listen(window, "blur", letGo);
    plugin.onCleanup(letGo);
  },
});
