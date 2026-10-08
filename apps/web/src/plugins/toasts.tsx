import { For, Show, createEffect, createMemo } from "solid-js";
import { Layers, Notify, Slots } from "../ui/contracts.ts";
import type { Toast } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { AlertIcon, CopyButton, ExternalIcon, XIcon } from "../ui/parts.tsx";
import styles from "./toasts.css?inline";

/** How long a message shows, by level, unless it carries a code or links to act on: those stay until dismissed. */
const SHOWS_FOR: Readonly<Record<Toast["level"], number>> = { error: 12_000, warning: 8_000, info: 5_000 };
/** At most this many show at once; one more dismisses the oldest. */
const AT_MOST = 6;

function CodeBox(props: { code: string }) {
  return (
    <div class="device-code">
      <code>{props.code}</code>
      <CopyButton text={props.code} label="Copy code" />
    </div>
  );
}

function ToastView(props: { toast: Toast; onDismiss: () => void }) {
  return (
    <div class={`toast toast-${props.toast.level}`} role={props.toast.level === "error" ? "alert" : "status"}>
      <div class="toast-main">
        <Show when={props.toast.level !== "info"}>
          <AlertIcon />
        </Show>
        <div class="toast-text">
          <span>{props.toast.message}</span>
          <Show when={props.toast.source}>
            <span class="toast-source">{props.toast.source}</span>
          </Show>
        </div>
        <Show when={props.toast.level !== "info"}>
          <CopyButton text={props.toast.message} label="Copy message" />
        </Show>
        <button class="icon-button" aria-label="Dismiss" onClick={() => props.onDismiss()}>
          <XIcon />
        </button>
      </div>
      <Show when={props.toast.code}>{(code) => <CodeBox code={code()} />}</Show>
      <Show when={props.toast.links?.length}>
        <div class="toast-links">
          <For each={props.toast.links}>
            {(link) => (
              <a class="button small" href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label ?? new URL(link.url, location.href).host} <ExternalIcon />
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * Draws the `Notify` messages in a corner of the page, but those a view
 * claims, and decides how long they stay: each is dismissed when its time is
 * up, and the oldest when too many show. Turning it off leaves the messages
 * undrawn, not lost.
 */
export default defineUiPlugin({
  id: "toasts",
  styles,
  requires: { notify: Notify, slots: Slots },
  setup: ({ notify, slots }, plugin) => {
    const shown = createMemo(() => notify.toasts().filter((item) => !notify.claimed(item)));
    /** Each message's timer, from when this plugin first saw it; one with a code or links has none. */
    const timers = new Map<number, number>();
    plugin.onCleanup(() => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    });
    createEffect(() => {
      const all = notify.toasts();
      for (const [id, timer] of timers) {
        if (all.some((item) => item.id === id)) continue;
        window.clearTimeout(timer);
        timers.delete(id);
      }
      for (const item of all) {
        if (timers.has(item.id) || item.code !== undefined || (item.links?.length ?? 0) > 0) continue;
        timers.set(
          item.id,
          window.setTimeout(() => notify.dismiss(item.id), SHOWS_FOR[item.level]),
        );
      }
    });
    createEffect(() => {
      for (const item of shown().slice(0, -AT_MOST)) notify.dismiss(item.id);
    });
    slots.add(Layers, {
      id: "toasts",
      order: 100,
      component: () => (
        <div class="toasts" aria-live="polite">
          <For each={shown()}>{(item) => <ToastView toast={item} onDismiss={() => notify.dismiss(item.id)} />}</For>
        </div>
      ),
    });
  },
});
