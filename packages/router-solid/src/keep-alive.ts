import { createContext, createEffect, createMemo, untrack, useContext } from "solid-js";
import type { Accessor } from "solid-js";

export interface KeepAliveState {
  /** The keys kept mounted, in the order they first came: a stable order for their elements. */
  readonly mounted: Accessor<readonly string[]>;
  /** Whether `key` is the active one. Reactive. */
  readonly isActive: (key: string) => boolean;
}

/** How many views a `KeepAlive` keeps when `keep` is not a number it can use. */
const DEFAULT_KEEP = 5;

/**
 * Which views to keep: the active key and the most recently active others,
 * up to `keep` in all. A key past that is dropped, its view disposed (its
 * cleanups run, so it can save what it needs); one coming back mounts anew.
 * With `open`, the keys that still exist (a tab bar's tabs), a key that
 * leaves it is dropped at once: a closed tab's view does not linger, and an
 * id used again later mounts a new one.
 */
export const createKeepAlive = (
  active: Accessor<string | undefined>,
  keep: Accessor<number>,
  open?: Accessor<readonly string[] | undefined>,
): KeepAliveState => {
  /** Most recently active first. */
  const recent = createMemo<readonly string[]>((previous) => {
    const now = active();
    const wanted = keep();
    const limit = Number.isFinite(wanted) ? Math.max(1, Math.floor(wanted)) : DEFAULT_KEEP;
    const existing = open?.();
    const still = existing === undefined ? previous : previous.filter((key) => existing.includes(key));
    // An active key `open` no longer has is closed too: its view goes now, not when another becomes active.
    const order = now === undefined || (existing !== undefined && !existing.includes(now)) ? still : [now, ...still.filter((key) => key !== now)];
    return order.length > limit ? order.slice(0, limit) : order;
  }, []);
  const mounted = createMemo<readonly string[]>((previous) => {
    const kept = new Set(recent());
    const next = previous.filter((key) => kept.has(key));
    for (const key of recent()) if (!next.includes(key)) next.push(key);
    return next.length === previous.length && next.every((key, index) => key === previous[index]) ? previous : next;
  }, []);
  return { mounted, isActive: (key) => active() === key };
};

/** Whether the view this is read in is the active one; true outside any `KeepAlive`. */
export const ActiveContext = createContext<Accessor<boolean>>(() => true);

/** Whether the view reading it is the active one of its `KeepAlive`. Reactive. */
export const useActive = (): Accessor<boolean> => useContext(ActiveContext);

/** Runs `fn` on each change of the view's activity to `to`, not for the activity it starts with. */
const onActivity = (to: boolean, fn: () => void) => {
  const active = useActive();
  createEffect<boolean>((was) => {
    const now = active();
    if (now !== was && now === to) untrack(fn);
    return now;
  }, untrack(active));
};

/** Runs `fn` each time the view reading it stops being the active one (it stays mounted, hidden). */
export const onSuspend = (fn: () => void): void => onActivity(false, fn);

/** Runs `fn` each time the view reading it becomes the active one again. */
export const onResume = (fn: () => void): void => onActivity(true, fn);
