import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { bindingOf, modKey } from "./keys.ts";

/**
 * Whether the quick-pick modifier (⌘, or Ctrl off macOS) is held in a list, so
 * it shows each item's `quickKey` only then. Pass the list's keydown, keyup,
 * and focusout to `track`; leaving it, as switching apps does, lets go. While
 * the list is `showing` (one that comes and goes, as a text field's
 * completions do), the modifier held alone is its own: marked handled
 * (`preventDefault`), so the keymap's actions do not show their keys for it too
 * (`Action.onHold`, the sidebar's `⌘1`).
 */
export const createQuickHold = (
  showing: () => boolean = () => true,
): { readonly held: Accessor<boolean>; readonly track: (event: KeyboardEvent | FocusEvent) => void } => {
  const [held, setHeld] = createSignal(false);
  return {
    held,
    track: (event) => {
      const next = event instanceof KeyboardEvent && modKey(event) && !event.altKey && !event.shiftKey;
      setHeld(next);
      if (next && bindingOf(event) === undefined && showing()) event.preventDefault();
    },
  };
};
