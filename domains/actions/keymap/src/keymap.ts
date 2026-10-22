import { bindingOf, bindsTyping, holdsKeys, matchesKeys } from "@lemma/web/keys";
import { ActionIds, keysFor } from "@lemma/actions";
import type { Action, KeyOverrides } from "@lemma/actions";
import type { SlotItem } from "@lemma/web";

/** How long modifiers are held down alone before the actions they would run hear it: a shortcut pressed at once (⌘C) passes first. */
export const HOLD_DELAY = 200;

/** Where a key goes, as actions' keys care: under a dialog or question, which holds them back, or into a text field. */
export interface Place {
  readonly modal: boolean;
  readonly inField: boolean;
}

export type Item = SlotItem<Action>;

export interface KeymapDeps {
  /** The actions, in order. */
  readonly actions: () => readonly Item[];
  /** The user's bindings over the actions' own. */
  readonly overrides: KeyOverrides;
  readonly placeOf: (event: KeyboardEvent) => Place;
  /** Runs `run` once `ms` have passed; returns what cancels it. */
  readonly after: (ms: number, run: () => void) => () => void;
  /** What an action threw, the fault of the plugin that added it. */
  readonly failed: (action: Item, error: unknown) => void;
}

/** The page's keys, as the keymap hears them. */
export interface Keymap {
  readonly keydown: (event: KeyboardEvent) => void;
  readonly keyup: (event: KeyboardEvent) => void;
  /** What is held is let go: the window lost focus, or the keymap stops. */
  readonly letGo: () => void;
}

/**
 * Runs the first action in order whose keys `event` presses and whose `when` holds, and tells the actions one more
 * key would run while modifiers are held down alone a moment (`onHold`), until that ends.
 */
export const createKeymap = ({ actions, overrides, placeOf, after, failed }: KeymapDeps): Keymap => {
  /** The first of `action`'s keys that `matches`, while it would run on them at `place`: held back by nothing, and offered (`when`). */
  const runsOn = (action: Item, place: Place, matches: (binding: string) => boolean): string | undefined => {
    if (place.modal && !action.global) return undefined;
    const binding = keysFor(action.id, action.keys, overrides).find(matches);
    if (binding === undefined || (place.inField && bindsTyping(binding) && !action.whileTyping)) return undefined;
    try {
      return action.when === undefined || action.when() ? binding : undefined;
    } catch (error) {
      failed(action, error);
      return undefined;
    }
  };
  /** Runs the first action `event` presses the keys of; whether one ran. */
  const onKey = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || event.isComposing) return false;
    const place = placeOf(event);
    for (const action of actions()) {
      if (runsOn(action, place, (candidate) => matchesKeys(candidate, event)) === undefined) continue;
      event.preventDefault();
      // One that needs a value asks for it in the palette, as picking it there would.
      const palette = action.input === undefined ? undefined : actions().find((item) => item.id === ActionIds.palette);
      const runs = palette ?? action;
      try {
        const result: unknown = palette !== undefined ? palette.run(action.id) : action.run();
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function")
          (result as PromiseLike<unknown>).then(undefined, (error: unknown) => failed(runs, error));
      } catch (error) {
        failed(runs, error);
      }
      return true;
    }
    return false;
  };

  let told: Item[] = [];
  let waiting: (() => void) | undefined;
  const tell = (action: Item, binding: string | undefined) => {
    try {
      action.onHold?.(binding);
    } catch (error) {
      failed(action, error);
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
    // A modifier already handled is held for something else: a quick-pick list's own ⌘1 (`createQuickHold`).
    if (event.defaultPrevented || (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)) return;
    waiting = after(HOLD_DELAY, () => {
      waiting = undefined;
      const listening = actions().filter((action) => action.onHold !== undefined);
      // Only the bindings they listen for, and as a key would: each runs the first action it matches.
      const wanted = new Set(listening.flatMap((action) => keysFor(action.id, action.keys, overrides)).filter((binding) => holdsKeys(binding, event)));
      if (wanted.size === 0) return;
      const place = placeOf(event);
      const taken = new Set<string>();
      for (const action of actions()) {
        const binding = runsOn(action, place, (candidate) => wanted.has(candidate) && !taken.has(candidate));
        if (binding === undefined) continue;
        taken.add(binding);
        if (action.onHold === undefined) continue;
        told.push(action);
        tell(action, binding);
      }
    });
  };

  return {
    keydown: (event) => {
      const ran = onKey(event);
      // A modifier pressed or let go changes what is held; a key pressed with it that runs nothing (⌘C) ends the hold
      // until the next change. A key held down repeats its press.
      if (bindingOf(event) === undefined) {
        if (!event.repeat) hold(event);
      } else if (!ran) letGo();
    },
    keyup: (event) => {
      if (bindingOf(event) === undefined) hold(event);
    },
    letGo,
  };
};
