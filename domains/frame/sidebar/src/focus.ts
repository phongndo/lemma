import { onCleanup } from "solid-js";
import { nothingFocused } from "@lemma/frame";
import { focusStep } from "@lemma/web/keys";
import type { WebPluginContext } from "@lemma/web";

/** What a press can put focus on. */
const TAKES_FOCUS = "a[href], button, input, select, textarea, [tabindex]";

/** The row focus goes to when `row` (a list item) goes with focus in it: the next in its list, else the one before. */
const neighbourOf = (row: Element): HTMLElement | undefined => {
  const links = [...(row.closest("ul")?.querySelectorAll<HTMLElement>("[data-session-row]") ?? [])].filter((link) => !row.contains(link));
  return (
    links.find((link) => (row.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ??
    links.filter((link) => (row.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).at(-1)
  );
};

/**
 * Keeps focus in `list` as its rows change: a row that goes with focus in it (archived, deleted, discarded) hands it to
 * its neighbour (`neighbourOf`), or, with none, the first row or `fallback` (the new-thread button); one moved (pinned)
 * keeps it. Focus the person takes out of the list (another control, a press elsewhere) is left alone. Returns the
 * list's `focusin` and `focusout` handlers.
 */
export const keepFocus = (plugin: Pick<WebPluginContext<unknown>, "listen">, list: HTMLElement, fallback: () => HTMLElement | undefined) => {
  let kept: { readonly focused: HTMLElement; readonly next: HTMLElement | undefined } | undefined;
  const remember = () => {
    const focused = document.activeElement;
    const row = focused instanceof HTMLElement && list.contains(focused) ? focused.closest("li") : null;
    if (focused instanceof HTMLElement && row !== null) kept = { focused, next: neighbourOf(row) };
  };
  const observer = new MutationObserver((records) => {
    const was = kept;
    if (was === undefined) return;
    if (list.contains(document.activeElement)) {
      // The neighbour changes only as rows come, go, or move (a list's own children), not with what changes in a row.
      if (was.focused !== document.activeElement || records.some((record) => record.target instanceof HTMLUListElement)) remember();
      return;
    }
    if (!nothingFocused(document.activeElement) || !records.some((record) => [...record.removedNodes].some((node) => node.contains(was.focused)))) return;
    // After what the change does itself (a renamed row focusing its link again).
    queueMicrotask(() => {
      if (nothingFocused(document.activeElement))
        [was.focused, was.next, list.querySelector<HTMLElement>("[data-session-row]") ?? undefined, fallback()]
          .find((candidate) => candidate?.isConnected === true)
          ?.focus();
      remember();
    });
  });
  observer.observe(list, { childList: true, subtree: true });
  onCleanup(() => observer.disconnect());
  /** Focus is going somewhere outside the list, a press or a control: the person's, not the list's to keep. */
  const forget = (to: EventTarget | null) => {
    if (to instanceof Node && !list.contains(to)) kept = undefined;
  };
  /** A press elsewhere, or on what in the list takes no focus (its empty space), leaves focus where the person put it. */
  const pressed = (on: EventTarget | null) => {
    if (!(on instanceof Element) || !list.contains(on) || on.closest(TAKES_FOCUS) === null) kept = undefined;
  };
  onCleanup(plugin.listen(document, "pointerdown", (event) => pressed(event.target), { capture: true }));
  return { focusIn: remember, focusOut: (event: FocusEvent) => forget(event.relatedTarget) };
};

/** Moves focus between rows with ↑ and ↓ (`focusStep`), from a row only: a control in one keeps its keys. */
export const rowKeys = (event: KeyboardEvent): void => {
  if (document.activeElement?.matches("[data-session-row]") !== true) return;
  if (focusStep(event.currentTarget as HTMLElement, "[data-session-row]", event.key) !== undefined) event.preventDefault();
};
