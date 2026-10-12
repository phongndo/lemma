import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { modKey } from "./keys.ts";

/**
 * Whether the quick-pick modifier (⌘, or Ctrl off macOS) is held in a list, so
 * it shows each item's `quickKey` only then. Pass the list's keydown, keyup,
 * and focusout to `track`; leaving it, as switching apps does, lets go.
 */
export const createQuickHold = (): { readonly held: Accessor<boolean>; readonly track: (event: KeyboardEvent | FocusEvent) => void } => {
  const [held, setHeld] = createSignal(false);
  return { held, track: (event) => setHeld(event instanceof KeyboardEvent && modKey(event) && !event.altKey && !event.shiftKey) };
};
