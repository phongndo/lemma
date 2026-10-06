import { For, Show, createSignal } from "solid-js";
import { Layers, Notify, Slots } from "../ui/contracts.ts";
import type { Toast } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { AlertIcon, CheckIcon, CopyIcon, ExternalIcon, XIcon } from "../ui/parts.tsx";
import { copyText } from "../lib/clipboard.ts";
import styles from "./toasts.css?inline";

function CodeBox(props: { code: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="device-code">
      <code>{props.code}</code>
      <button
        class="icon-button"
        aria-label="Copy code"
        data-tip={copied() ? "Copied" : "Copy code"}
        onClick={() =>
          void copyText(props.code).then((ok) => {
            setCopied(ok);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied() ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function ToastView(props: { toast: Toast; onDismiss: () => void }) {
  const [copied, setCopied] = createSignal(false);
  const copy = () =>
    void copyText(props.toast.message).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(false), 1500);
    });
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
          <button class="icon-button" aria-label="Copy message" data-tip={copied() ? "Copied" : "Copy"} onClick={copy}>
            {copied() ? <CheckIcon /> : <CopyIcon />}
          </button>
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

/** Draws the `Notify` model's messages in a corner of the page; turning it off leaves the messages undrawn, not lost. */
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
          <For each={notify.toasts()}>{(item) => <ToastView toast={item} onDismiss={() => notify.dismiss(item.id)} />}</For>
        </div>
      ),
    });
  },
});
