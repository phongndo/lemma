import { For, Show, createEffect, createMemo } from "solid-js";
import { Layers } from "@lemma/frame";
import { Notify, Slots, defineWebPlugin } from "@lemma/web";
import type { Toast } from "@lemma/web";
import { AlertIcon, CopyButton, ExternalIcon, XIcon } from "@lemma/look";
import styles from "./toasts.css?inline";

/** How long a message shows, by level, unless it carries links to act on: those stay until dismissed. */
const SHOWS_FOR: Readonly<Record<Toast["level"], number>> = { error: 12_000, warning: 8_000, info: 5_000 };
/** At most this many show at once; one more dismisses the oldest. */
const AT_MOST = 6;

function ToastView(props: { toast: Toast; onDismiss: () => void; hold: (held: boolean) => void }) {
  // Held while the pointer is on it or focus is in it, so it is not dismissed while being read.
  let pointed = false;
  let focused = false;
  const tell = () => props.hold(pointed || focused);
  return (
    <div
      class={`toast toast-${props.toast.level}`}
      role={props.toast.level === "error" ? "alert" : "status"}
      onPointerEnter={() => {
        pointed = true;
        tell();
      }}
      onPointerLeave={() => {
        pointed = false;
        tell();
      }}
      onFocusIn={() => {
        focused = true;
        tell();
      }}
      onFocusOut={(event) => {
        focused = event.currentTarget.contains(event.relatedTarget as Node | null);
        tell();
      }}
    >
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
        <button class="icon-button" aria-label="Dismiss" data-tip="Dismiss" onClick={() => props.onDismiss()}>
          <XIcon />
        </button>
      </div>
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
 * up (counted again from the start once the pointer or focus leaves it), and
 * the oldest when too many show. Turning it off leaves the messages undrawn,
 * not lost.
 */
export default defineWebPlugin({
  id: "frame.toasts",
  styles,
  requires: { notify: Notify, slots: Slots },
  setup: ({ notify, slots }, plugin) => {
    const shown = createMemo(() => notify.toasts().filter((item) => !notify.claimed(item)));
    /** Each message's timer, from when this plugin first saw it; one with links has none, nor one held. */
    const timers = new Map<number, () => void>();
    /** The messages the pointer or focus is on: their time waits. */
    const held = new Set<number>();
    const time = (item: Toast) => {
      if (timers.has(item.id) || held.has(item.id) || (item.links?.length ?? 0) > 0) return;
      timers.set(
        item.id,
        plugin.after(SHOWS_FOR[item.level], () => notify.dismiss(item.id), { name: "dismiss toast" }),
      );
    };
    const hold = (item: Toast, holding: boolean) => {
      if (holding === held.has(item.id)) return;
      if (holding) {
        held.add(item.id);
        timers.get(item.id)?.();
        timers.delete(item.id);
      } else {
        held.delete(item.id);
        time(item);
      }
    };
    createEffect(() => {
      const all = notify.toasts();
      for (const [id, cancel] of timers) {
        if (all.some((item) => item.id === id)) continue;
        cancel();
        timers.delete(id);
      }
      for (const id of held) if (!all.some((item) => item.id === id)) held.delete(id);
      for (const item of all) time(item);
    });
    createEffect(() => {
      for (const item of shown().slice(0, -AT_MOST)) notify.dismiss(item.id);
    });
    slots.add(Layers, {
      id: "toasts",
      order: 100,
      component: () => (
        <div class="toasts" aria-live="polite">
          <For each={shown()}>{(item) => <ToastView toast={item} onDismiss={() => notify.dismiss(item.id)} hold={(holding) => hold(item, holding)} />}</For>
        </div>
      ),
    });
  },
});
