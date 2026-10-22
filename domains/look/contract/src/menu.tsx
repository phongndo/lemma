import { createSignal } from "solid-js";
import { TrashIcon } from "./parts.tsx";

/*
 * Plain controls drawn with the foundation's classes (`.menu-item`, `.icon-button`, `.button-danger`): handlers bind to
 * their element (`on:click`), not through Solid's page-wide delegation, which runs when the module loads, and a
 * contract loads without a page too, in the tests.
 */

/** A row of a popover's menu (`Popover`): picking it closes the menu, then runs. `danger` draws it in the error color. */
export function MenuItem(props: { readonly label: string; readonly close: () => void; readonly run: () => void; readonly danger?: boolean }) {
  return (
    <button
      class="menu-item"
      classList={{ "menu-danger": props.danger === true }}
      role="menuitem"
      on:click={() => {
        props.close();
        props.run();
      }}
    >
      <span class="menu-label">{props.label}</span>
    </button>
  );
}

/** What deleting one thing in place says once it asks: one wording wherever it does (a row, a header, a thread's menu). */
export const CONFIRM_DELETE = "Confirm delete";

/**
 * Deletes one thing after asking in place: a quiet trash button whose first click arms it, filled in the error color at
 * the same size (its tooltip `CONFIRM_DELETE`), and whose second runs `onConfirm`. Moving the pointer or focus off it,
 * or Escape, disarms it. Many things at once, or one whose loss takes more with it (a profile, with all its data), ask
 * in a dialog instead, which says what goes and what stays.
 */
export function ConfirmDelete(props: {
  /** Its accessible name, naming what it deletes: `Delete Fix the flaky test`. */
  readonly label: string;
  /** Its tooltip at rest; `Delete` when absent. */
  readonly tip?: string;
  /** Why it cannot delete now (a turn runs in the thread): said in its tooltip, and it does not arm. */
  readonly blocked?: string | undefined;
  /** Told as it arms and disarms, so a row keeps it shown while it asks. */
  readonly onArmed?: (armed: boolean) => void;
  readonly onConfirm: () => void;
}) {
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
      on:blur={() => arm(false)}
      on:pointerleave={() => arm(false)}
      on:keydown={(event) => {
        // Escape takes back the question, before it reaches what else Escape does (closing settings).
        if (event.key !== "Escape" || !armed()) return;
        event.preventDefault();
        arm(false);
      }}
      on:click={(event) => {
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
