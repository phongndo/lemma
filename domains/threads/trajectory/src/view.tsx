import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { createLedgerProjector, createTrajectoryProjector, ledgerSpans, parseLedgerFilter } from "@lemma/sessions";
import type { LedgerRecord } from "@lemma/sessions";
import { stepFor } from "@lemma/web/keys";
import { createNow } from "@lemma/web/now";
import { timeScale } from "./scale.ts";
import { createDetails } from "./details.tsx";
import { createView } from "./state.ts";
import type { TrajectoryDeps } from "./state.ts";
import { createTable } from "./table.tsx";
import { createTimeline } from "./timeline.tsx";
import { createToolbar } from "./toolbar.tsx";

/**
 * The Trajectory view, modeled on Chrome DevTools' Network panel and on
 * DeepSeek Harness's trajectory: a filter toolbar, a zoomable three-lane
 * overview, a sortable table with a waterfall column, a details panel with
 * tabs, a context menu, and a status bar. Everything is projected from the
 * session log (`trajectory` → `ledger`), as it grows while the view is drawn:
 * what an event appended leaves alone keeps its records, and so its rows. One
 * per tab: its filter, selection, and scroll are that tab's.
 */
export function createTrajectory(deps: TrajectoryDeps): () => JSX.Element {
  const view = createView(deps);
  const {
    selection,
    tab,
    setCollapsed,
    query,
    setQuery,
    typeFilter,
    setTypeFilter,
    sort,
    setRange,
    setZoom,
    menu,
    setMenu,
    stuck,
    stick,
    follow,
    select,
    typeMatches,
    refs,
    rowElements,
  } = view;
  const { Toolbar } = createToolbar(view);
  const { Overview } = createTimeline(view);
  const { Table, ContextMenu, StatusBar } = createTable(view);
  const { Details } = createDetails(view);
  /** The thread it last showed: its state is that thread's. */
  let shownFor: string | undefined;

  function Trajectory(): JSX.Element {
    // The view's own while it is drawn, so what they hold of a branch goes with it, as a long thread's may be large.
    const projectTrajectory = createTrajectoryProjector();
    const ledger = createLedgerProjector();
    const records = createMemo(() => ledger(projectTrajectory(deps.threads.branch())));
    // Running bars grow while a turn runs.
    const now = createNow(500, deps.threads.busy);
    const allSpans = createMemo(() => ledgerSpans(records()));
    const spanById = createMemo(() => new Map(allSpans().map((span) => [span.record.id, span])));
    const scale = createMemo(() => timeScale(allSpans(), now()));
    const matchesQuery = createMemo(() => parseLedgerFilter(query()));
    const matches = (record: LedgerRecord) => typeMatches(record) && matchesQuery()(record);
    const visible = createMemo(() => records().filter(matches));
    let root!: HTMLDivElement;
    // The room the table has decides which of its columns fit (`Table`'s `width`). It is measured before the table is
    // first laid out, and again when the scroller's border box changes: only the pane's layout sets that, where the
    // scrollbars a change of the columns adds or takes away would change the content box in the frame it was observed.
    const [width, setWidth] = createSignal(Infinity);
    const observer = new ResizeObserver(() => setWidth(refs.scroller!.clientWidth));
    onMount(() => {
      setWidth(refs.scroller!.clientWidth);
      observer.observe(refs.scroller!, { box: "border-box" });
    });
    onCleanup(() => observer.disconnect());

    createEffect(
      on(
        () => deps.threads.activeId(),
        (id) => {
          // Drawn again over the thread it last showed (its tab shown again), it is as it was, where it was scrolled to.
          if (id === shownFor) {
            if (stuck() && sort().key === "time") follow();
            else queueMicrotask(() => refs.scroller?.scrollTo({ top: stick.lastTop() }));
            return;
          }
          shownFor = id;
          select(undefined);
          setRange(undefined);
          setQuery("");
          setZoom({ start: 0, end: 1 });
          setCollapsed(new Set<string>());
          setMenu(undefined);
          if (sort().key === "time") follow();
        },
      ),
    );
    // In time order the newest row is the one to watch, so the table opens at its end and follows new rows there
    // (a filter's change too), until the reader scrolls up. Another order has no "newest end" to follow.
    createEffect(
      on(visible, () => {
        if (stuck() && sort().key === "time") follow();
      }),
    );
    // A record a change of the filter leaves out leaves the details too, rather than showing what the table no longer
    // does. One picked on the overview, where every record shows, stays until the filter next changes.
    createEffect(
      on(
        [query, typeFilter],
        () => {
          const s = selection();
          if (s?.type === "record" && !visible().some((record) => record.id === s.id)) select(undefined);
        },
        { defer: true },
      ),
    );
    createEffect(
      on(
        () => sort().key,
        (key) => {
          if (key === "time") follow();
        },
        { defer: true },
      ),
    );

    // DevTools keys: arrows move the selection, Escape closes the panel (or the menu), "/" and Ctrl/Cmd+F focus the filter.
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement;
      if ((event.key === "/" && !typing) || (event.key === "f" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        refs.filterInput?.focus();
        return;
      }
      if (event.key === "Escape") {
        // Handled here when it closes something; otherwise it is the app's (stopping a turn, say).
        if (menu() !== undefined) setMenu(undefined);
        else if (typing && query() !== "") setQuery("");
        else if (selection() !== undefined) {
          const s = selection()!;
          const inDetails = event.target instanceof Element && event.target.closest(".trj-details") !== null;
          select(undefined);
          // The details go, and the focus in them goes back to the row they showed (or the view), not to the page.
          if (inDetails) ((s.type === "record" ? rowElements.get(s.id) : undefined) ?? root).focus({ preventScroll: true });
        } else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // The details keep their own keys (a text's selection), but on their tabs, whose ← and → are theirs, ↑ and ↓ still
      // move the selection, as they do from the table.
      if (typing || !(event.target instanceof Element)) return;
      const onTab = event.target.matches('[role="tab"]') && event.target.closest(".trj-details") !== null;
      if (event.target.closest(".trj-details") !== null && !onTab) return;
      // Enter or Space on a row opens its details, as a click does.
      if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLTableRowElement && event.target.dataset.record !== undefined) {
        event.preventDefault();
        select({ type: "record", id: event.target.dataset.record });
        return;
      }
      if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      const rows = [...root.querySelectorAll<HTMLTableRowElement>("tbody tr[data-record]")];
      const s = selection();
      const current = rows.findIndex((row) => s?.type === "record" && row.dataset.record === s.id);
      const next = rows[stepFor(event.key, current, rows.length)!];
      if (next === undefined) return;
      select({ type: "record", id: next.dataset.record! }, tab());
      // The focus goes with the selection, so its ring is not left on the row clicked; from a details tab it goes to the
      // tab shown for the next record, its tabs drawn anew, which reads it in its turn.
      if (onTab)
        queueMicrotask(() => (root.querySelector<HTMLElement>('.trj-details [role="tab"][aria-selected="true"]') ?? next).focus({ preventScroll: true }));
      else next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    };
    const clearFilter = () => {
      setQuery("");
      setTypeFilter("all");
      refs.filterInput?.focus();
    };

    return (
      <div class="trj dt-scope" ref={root} tabindex="-1" onKeyDown={onKeyDown}>
        <Toolbar />
        <Overview ledgerSpans={allSpans()} scale={scale()} now={now()} matches={matches} />
        <div class="trj-body">
          <div
            class="trj-scroll"
            ref={(el) => {
              refs.scroller = el;
            }}
            onScroll={stick.onScroll}
          >
            <Show
              when={records().length > 0}
              fallback={<p class="trj-empty">{deps.threads.blank() ? "Start a chat to see its trajectory." : "No records on this branch yet."}</p>}
            >
              <Table
                records={records()}
                visible={visible()}
                scale={scale()}
                ledgerSpans={spanById()}
                now={now()}
                compact={selection() !== undefined}
                width={width()}
              />
              <Show when={visible().length === 0}>
                <div class="trj-empty trj-no-match">
                  <p>No records match the filter.</p>
                  <button class="dt-chip" onClick={clearFilter}>
                    Clear filter
                  </button>
                </div>
              </Show>
            </Show>
          </div>
          <Details records={records()} />
        </div>
        <StatusBar records={records()} visible={visible()} now={now()} />
        <ContextMenu />
      </div>
    );
  }

  return Trajectory;
}
