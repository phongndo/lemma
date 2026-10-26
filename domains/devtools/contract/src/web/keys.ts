import { stepFor } from "@lemma/web/keys";

/**
 * The keys of a panel's table whose rows select, so the keyboard works it as the pointer does: ↑ and ↓ select the row
 * before or after the one focused (or selected), Enter or Space opens the row focused (`open`, which selects it when
 * not given: a row whose click does more than select, as a trace's opening its spans, passes what the click does), and
 * Escape clears the selection where the panel can close its details (`clear`). The table is a focusable `role="grid"`
 * and handles them (`onKeyDown`); each row carries its key in `data-key`, says whether it is selected
 * (`aria-selected`), and takes focus (`tabindex="-1"`). A key the table handles is its own; Enter on a button or link
 * in a row is that control's. The devtools' panels share it, so each panel's table answers the keys the same.
 */
export const rowKeys =
  (select: (key: string) => void, clear?: () => void, open: (key: string) => void = select) =>
  (event: KeyboardEvent & { readonly currentTarget: HTMLElement }) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)) return;
    const table = event.currentTarget;
    const focused = event.target.closest<HTMLElement>("tbody tr[data-key]");
    const selected = table.querySelector<HTMLElement>('tbody tr[data-key][aria-selected="true"]');
    if (event.key === "Enter" || event.key === " ") {
      if (focused === null || focused !== event.target) return;
      open(focused.dataset.key!);
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

/**
 * Escape in a panel's filter field clears what is typed (`clear`), as the browser's devtools do; with nothing typed it
 * is left to what holds the field (a panel closing its details, the app). Its field's `onKeyDown`.
 */
export const clearsOnEscape = (typed: () => string, clear: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.defaultPrevented || typed() === "") return;
  event.preventDefault();
  event.stopPropagation();
  clear();
};
