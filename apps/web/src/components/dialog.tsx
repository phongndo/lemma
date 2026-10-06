import { Show, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { DialogProps } from "../ui/contracts.ts";
import { XIcon } from "../ui/parts.tsx";

/**
 * Modal shell: backdrop, Esc to close, focus moved in on open and restored on
 * close, Tab kept inside. Without a `title` there is no header: the body leads
 * (a search field) and names the dialog through `label`.
 */
export function Dialog(props: DialogProps) {
  let panel!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  const focusables = () =>
    [...panel.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
      (el) => !el.hasAttribute("disabled"),
    );
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && props.onClose !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "Tab") {
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  onMount(() => {
    // Prefer an explicit target, then the first control in the body or footer, before the close button.
    const autofocus =
      panel.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables().find((el) => !el.closest(".dialog-head")) ?? focusables()[0] ?? panel;
    queueMicrotask(() => autofocus.focus());
  });
  onCleanup(() => previous?.focus?.());
  return (
    <Portal>
      <div
        class="backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && props.closeOnBackdrop !== false) props.onClose?.();
        }}
      >
        <div ref={panel} class={`dialog ${props.class ?? ""}`} role="dialog" aria-modal="true" aria-label={props.label} tabindex="-1" onKeyDown={onKey}>
          <Show when={props.title}>
            <header class="dialog-head">
              <h2>{props.title}</h2>
              <Show when={props.onClose}>
                <button class="icon-button" aria-label="Close" onClick={() => props.onClose?.()}>
                  <XIcon />
                </button>
              </Show>
            </header>
          </Show>
          <div class="dialog-body">{props.children}</div>
          <Show when={props.footer}>
            <footer class="dialog-foot">{props.footer}</footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
