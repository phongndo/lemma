import { Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

import type { Placement, PopoverProps } from "../ui/contracts.ts";

const MARGIN = 8;
const GAP = 6;
const ITEMS = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"]), [role="option"]:not([aria-disabled="true"])';

/**
 * Places `menu` against `anchor` on the preferred side, flipping when the
 * other side has more room and shifting to stay inside the viewport.
 */
const position = (anchor: DOMRect, menu: HTMLElement, placement: Placement) => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = vh - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const height = menu.scrollHeight;
  const wantTop = placement.startsWith("top");
  const top = wantTop ? height <= above || above >= below : !(height <= below || below >= above);
  const room = Math.max(120, top ? above : below);
  menu.style.maxHeight = `${room}px`;
  const shown = Math.min(height, room);
  const width = menu.offsetWidth;
  const left = placement.endsWith("end") ? anchor.right - width : anchor.left;
  menu.style.left = `${Math.max(MARGIN, Math.min(left, vw - width - MARGIN))}px`;
  menu.style.top = `${top ? anchor.top - GAP - shown : anchor.bottom + GAP}px`;
  menu.dataset.side = top ? "top" : "bottom";
};

/**
 * A trigger with a floating menu. The menu renders at the document root so no
 * container clips it, and it owns keyboard navigation: arrows move the active
 * item (focus stays in a search field if there is one), Enter picks it, typing
 * a letter jumps to a matching item, Escape closes and returns focus.
 *
 * Items are elements with role `menuitem`, `menuitemradio`, or `option`.
 */
export function Popover(props: PopoverProps) {
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  let observer: MutationObserver | undefined;
  let typed = "";
  let typedAt = 0;

  const items = () => (menu === undefined ? [] : [...menu.querySelectorAll<HTMLElement>(ITEMS)]);
  const activeIndex = () => items().findIndex((item) => item.dataset.active === "true");
  const activate = (index: number, scroll = true) => {
    const all = items();
    all.forEach((item, i) => {
      item.dataset.active = String(i === index);
    });
    if (scroll) all[index]?.scrollIntoView({ block: "nearest" });
  };
  const place = () => {
    if (menu !== undefined) position(trigger.getBoundingClientRect(), menu, props.placement ?? "bottom-end");
  };

  const close = (restoreFocus = true) => {
    if (!open()) return;
    setOpen(false);
    detach();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  const show = () => {
    props.onOpen?.();
    setOpen(true);
    attach();
    requestAnimationFrame(() => {
      if (menu === undefined) return;
      place();
      const selected = items().findIndex((item) => item.getAttribute("aria-checked") === "true" || item.getAttribute("aria-selected") === "true");
      activate(Math.max(0, selected));
      (menu.querySelector<HTMLElement>("[data-autofocus]") ?? menu).focus({ preventScroll: true });
      // Filtering replaces items: keep one active and the menu in place.
      observer = new MutationObserver(() => {
        if (activeIndex() === -1) activate(0, false);
        place();
      });
      observer.observe(menu, { childList: true, subtree: true });
    });
  };

  props.controller?.({
    open: () => {
      if (!open() && !props.disabled) show();
    },
  });

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!trigger.contains(target) && !menu?.contains(target)) close(false);
  };
  const onReflow = () => place();
  const onBlur = () => close(false);
  const attach = () => {
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("blur", onBlur);
  };
  const detach = () => {
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("resize", onReflow);
    window.removeEventListener("scroll", onReflow, true);
    window.removeEventListener("blur", onBlur);
  };
  onCleanup(detach);

  const onKeyDown = (event: KeyboardEvent) => {
    const all = items();
    const index = activeIndex();
    const inField = event.target instanceof HTMLInputElement;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "Tab":
        close(false);
        return;
      case "ArrowDown":
        event.preventDefault();
        activate(all.length === 0 ? -1 : (index + 1) % all.length);
        return;
      case "ArrowUp":
        event.preventDefault();
        activate(all.length === 0 ? -1 : (index - 1 + all.length) % all.length);
        return;
      case "Home":
        if (inField) return;
        event.preventDefault();
        activate(0);
        return;
      case "End":
        if (inField) return;
        event.preventDefault();
        activate(all.length - 1);
        return;
      case "Enter":
      case " ":
        if (event.key === " " && inField) return;
        if (event.isComposing || index === -1) return;
        event.preventDefault();
        all[index]!.click();
        return;
    }
    // Type-ahead when there is no search field to type into.
    if (!inField && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed = now - typedAt > 600 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
      typedAt = now;
      const match = all.findIndex((item) => item.textContent?.trim().toLowerCase().startsWith(typed));
      if (match !== -1) activate(match);
    }
  };
  // The pointer moves the active item, so hover and keyboard never show two highlights.
  const onPointerMove = (event: PointerEvent) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(ITEMS);
    if (item === null || item.dataset.active === "true") return;
    activate(items().indexOf(item), false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={props.triggerClass ?? "icon-button"}
        data-tip={open() ? undefined : (props.tip ?? props.label)}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open()) {
            event.preventDefault();
            show();
          }
        }}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={(el) => {
              menu = el;
            }}
            class={`popover menu ${props.menuClass ?? ""}`}
            role="menu"
            tabindex="-1"
            onKeyDown={onKeyDown}
            onPointerMove={onPointerMove}
          >
            {props.children(() => close())}
          </div>
        </Portal>
      </Show>
    </>
  );
}
