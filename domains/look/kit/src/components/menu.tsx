import { Show, createSignal } from "solid-js";
import { CheckIcon, CONFIRM_DELETE, Icon, TrashIcon } from "@lemma/look";
import type { ConfirmDeleteProps, MenuItemProps } from "@lemma/look";

/**
 * `MenuItemPart`: a `.menu-item` row, `.menu-danger` when it destroys. Its icon, or its checkmark when it is a choice,
 * goes in a `.menu-check` before the label, and its hint in a `.menu-hint` after it.
 */
export function MenuItem(props: MenuItemProps) {
  return (
    <button
      class="menu-item"
      classList={{ "menu-danger": props.danger === true }}
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={props.checked}
      data-tip={props.tip}
      onClick={() => {
        props.close();
        props.run();
      }}
    >
      <Show when={props.checked !== undefined || props.icon !== undefined}>
        <span class="menu-check">
          <Show when={props.checked} fallback={<Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>}>
            <CheckIcon />
          </Show>
        </span>
      </Show>
      <span class="menu-label">{props.label}</span>
      <Show when={props.hint}>
        <span class="menu-hint">{props.hint}</span>
      </Show>
    </button>
  );
}

/**
 * `ConfirmDeletePart`: a quiet trash button, filled in the error color at the same size once armed. A mouse leaving it
 * disarms it; a touch leaves at every tap's end, before its click, so only a mouse does.
 */
export function ConfirmDelete(props: ConfirmDeleteProps) {
  const [armed, setArmed] = createSignal(false);
  const arm = (next: boolean) => {
    if (armed() === next) return;
    setArmed(next);
    props.onArmed?.(next);
  };
  return (
    <button
      type="button"
      class="icon-button confirm-delete"
      aria-label={armed() ? `${CONFIRM_DELETE}: ${props.label}` : props.label}
      aria-disabled={props.blocked !== undefined}
      data-armed={armed() ? "" : undefined}
      data-tip={props.blocked ?? (armed() ? CONFIRM_DELETE : (props.tip ?? "Delete"))}
      onBlur={() => arm(false)}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") arm(false);
      }}
      onKeyDown={(event) => {
        // Escape takes back the question, before it reaches what else Escape does (closing settings).
        if (event.key !== "Escape" || !armed()) return;
        event.preventDefault();
        arm(false);
      }}
      onClick={(event) => {
        if (props.blocked !== undefined) return;
        if (!armed()) {
          arm(true);
          event.currentTarget.focus();
          return;
        }
        arm(false);
        props.onConfirm();
      }}
    >
      <TrashIcon />
    </button>
  );
}
