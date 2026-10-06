import { For, Show } from "solid-js";
import { Layers, Notify, Slots } from "../ui/contracts.ts";
import type { Toast } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { AlertIcon, CopyButton, ExternalIcon, XIcon } from "../ui/parts.tsx";
import styles from "./toasts.css?inline";

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
          <Show when={props.toast.source && props.toast.source !== "client"}>
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

/** Draws the `Notify` model's messages in a corner of the page, but those a view claims; turning it off leaves the messages undrawn, not lost. */
export default defineUiPlugin({
  id: "toasts",
  styles,
  requires: { notify: Notify, slots: Slots },
  setup: ({ notify, slots }) => {
    slots.add(Layers, {
      id: "toasts",
      order: 100,
      component: () => (
        <div class="toasts" aria-live="polite">
          <For each={notify.toasts().filter((item) => !notify.claimed(item))}>
            {(item) => <ToastView toast={item} onDismiss={() => notify.dismiss(item.id)} />}
          </For>
        </div>
      ),
    });
  },
});
