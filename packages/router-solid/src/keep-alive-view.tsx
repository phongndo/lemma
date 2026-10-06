import { For } from "solid-js";
import type { JSX } from "solid-js";
import { ActiveContext, createKeepAlive } from "./keep-alive.ts";

export interface KeepAliveProps {
  /** The key of the view to show (a tab's id); undefined shows none. */
  readonly active: string | undefined;
  /** How many views stay mounted, the active one included. Default 5. */
  readonly keep?: number;
  /** The keys that still exist (a tab bar's tabs): a view whose key leaves it is disposed at once. Absent: views leave only past `keep`. */
  readonly open?: readonly string[];
  /** The view for a key: rendered once while kept, hidden while another is active. */
  readonly children: (key: string) => JSX.Element;
}

/**
 * Shows the active key's view and keeps the most recently active others
 * mounted but hidden (`display: none`), so going back to one keeps its state
 * (scroll, inputs, a running stream) without rendering it again. Past `keep`,
 * the least recent is disposed. A view reads `useActive`, `onSuspend`, and
 * `onResume` to pause work while hidden.
 */
export function KeepAlive(props: KeepAliveProps): JSX.Element {
  const state = createKeepAlive(
    () => props.active,
    () => props.keep ?? 5,
    () => props.open,
  );
  return (
    <For each={state.mounted()}>
      {(key) => {
        const active = () => state.isActive(key);
        return (
          <ActiveContext.Provider value={active}>
            <div data-keep-alive={key} style={{ display: active() ? "contents" : "none" }}>
              {props.children(key)}
            </div>
          </ActiveContext.Provider>
        );
      }}
    </For>
  );
}
