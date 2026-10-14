import { stepFor } from "@lemma/web/keys";

/**
 * The keys of a table whose rows select, so the keyboard works it as the pointer does: ↑ and ↓ select the row before
 * or after the one focused (or selected), Enter or Space selects the row focused, and Escape clears the selection
 * where the panel can close its details (`clear`). The table is a focusable `role="grid"` and handles them
 * (`onKeyDown`); each row carries its key in `data-key`, says whether it is selected (`aria-selected`), and takes focus
 * (`tabindex="-1"`). A key the table handles is its own; Enter on a button or link in a row is that control's.
 */
export const rowKeys = (select: (key: string) => void, clear?: () => void) => (event: KeyboardEvent & { readonly currentTarget: HTMLElement }) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)) return;
  const table = event.currentTarget;
  const focused = event.target.closest<HTMLElement>("tbody tr[data-key]");
  const selected = table.querySelector<HTMLElement>('tbody tr[data-key][aria-selected="true"]');
  if (event.key === "Enter" || event.key === " ") {
    if (focused === null || focused !== event.target) return;
    select(focused.dataset.key!);
  } else if (event.key === "Escape") {
    if (clear === undefined || selected === null) return;
    clear();
    table.focus();
  } else {
    const rows = [...table.querySelectorAll<HTMLElement>("tbody tr[data-key]")];
    const from = focused ?? selected;
    const step = stepFor(event.key, from === null ? -1 : rows.indexOf(from), rows.length);
    const next = step === undefined ? undefined : rows[step];
    if (next === undefined) return;
    select(next.dataset.key!);
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }
  event.preventDefault();
  event.stopPropagation();
};
