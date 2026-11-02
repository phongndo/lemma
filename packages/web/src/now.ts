import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/**
 * The time, kept current every `ms` while `active` holds (always, without it): for labels that count or age. `ms` may
 * be an accessor, so a clock can tick faster while there is more to see, as the sidebar's does while a turn runs. The
 * clock stops with the owner that made it.
 */
export const createNow = (ms: number | Accessor<number>, active: () => boolean = () => true): Accessor<number> => {
  const [now, setNow] = createSignal(Date.now());
  const every = typeof ms === "number" ? () => ms : ms;
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every());
    onCleanup(() => clearInterval(timer));
  });
  return now;
};
