import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/** The time, kept current every `ms` while `active` holds (always, without it): for labels that count or age. */
export const createNow = (ms: number, active: () => boolean = () => true): Accessor<number> => {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    onCleanup(() => clearInterval(timer));
  });
  return now;
};
