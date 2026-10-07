import { Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

import { listKey, modKey, quickKey } from "../lib/keys.ts";
import type { Placement, PopoverProps } from "../ui/contracts.ts";

const MARGIN = 8;
const GAP = 6;
let menus = 0;
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
 * item (focus stays in a search field if there is one, which then names the
 * active item to screen readers), as do Ctrl+N/P and Ctrl+J/K; Enter picks it,
 * mod+1 … mod+9 picks the item at that place (labelled while mod is held),
 * typing a letter jumps to a matching item, Escape closes and returns focus.
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
  let quick = false;
  const menuId = `popover-${++menus}`;

  const items = () => (menu === undefined ? [] : [...menu.querySelectorAll<HTMLElement>(ITEMS)]);
  const activeIndex = () => items().findIndex((item) => item.dataset.active === "true");
  const search = () => menu?.querySelector<HTMLInputElement>("input") ?? undefined;
  const activate = (index: number, scroll = true) => {
    const all = items();
    all.forEach((item, i) => {
      item.dataset.active = String(i === index);
      item.id ||= `${menuId}-item-${i}`;
    });
    const active = all[index];
    if (active === undefined) search()?.removeAttribute("aria-activedescendant");
    else search()?.setAttribute("aria-activedescendant", active.id);
    if (scroll) active?.scrollIntoView({ block: "nearest" });
  };
  // While mod is held, the first nine items show the key that picks them.
  const label = () =>
    items().forEach((item, i) => {
      const key = quick ? quickKey(i) : undefined;
      if (key === undefined) delete item.dataset.quickKey;
      else item.dataset.quickKey = key;
    });
  const hold = (event: KeyboardEvent | FocusEvent) => {
    const next = event instanceof KeyboardEvent && modKey(event) && !event.altKey && !event.shiftKey;
    if (next === quick) return;
    quick = next;
    label();
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
    quick = false;
    props.onOpen?.();
    setOpen(true);
    attach();
    requestAnimationFrame(() => {
      if (menu === undefined) return;
      place();
      const selected = items().findIndex((item) => item.getAttribute("aria-checked") === "true" || item.getAttribute("aria-selected") === "true");
      // A search field drives the list, so it is a combobox over the menu.
      const field = search();
      if (field !== undefined) {
        field.setAttribute("role", "combobox");
        field.setAttribute("aria-expanded", "true");
        field.setAttribute("aria-autocomplete", "list");
        field.setAttribute("aria-controls", menuId);
      }
      activate(Math.max(0, selected));
      (menu.querySelector<HTMLElement>("[data-autofocus]") ?? menu).focus({ preventScroll: true });
      // Filtering replaces items: keep one active, its labels, and the menu in place.
      observer = new MutationObserver(() => {
        if (activeIndex() === -1) activate(0, false);
        else activate(activeIndex(), false);
        if (quick) label();
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
    hold(event);
    const all = items();
    const index = activeIndex();
    const inField = event.target instanceof HTMLInputElement;
    const list = event.isComposing ? undefined : listKey(event);
    if (list !== undefined) {
      event.preventDefault();
      if ("pick" in list) all[list.pick]?.click();
      else activate(all.length === 0 ? -1 : (index + list.move + all.length) % all.length);
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "Tab":
        close(false);
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
            id={menuId}
            class={`popover menu ${props.menuClass ?? ""}`}
            role="menu"
            tabindex="-1"
            onKeyDown={onKeyDown}
            onKeyUp={hold}
            onFocusOut={hold}
            onPointerMove={onPointerMove}
          >
            {props.children(() => close())}
          </div>
        </Portal>
      </Show>
    </>
  );
}
