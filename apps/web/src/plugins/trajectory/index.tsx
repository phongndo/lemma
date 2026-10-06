import { Show, createEffect, createMemo, on } from "solid-js";
import type { JSX } from "solid-js";
import { ledger, ledgerSpans, parseLedgerFilter, trajectory as projectTrajectory } from "@lemma/contracts";
import type { LedgerRecord } from "@lemma/contracts";
import { stepFor } from "../../lib/keys.ts";
import { timeScale } from "../../model/timeline.ts";
import { createNow } from "../../lib/now.ts";
import { Notify, Threads, Slots, Views } from "../../ui/contracts.ts";
import { defineUiPlugin } from "../../ui/define.ts";
import { TrajectoryIcon } from "../../ui/parts.tsx";
import styles from "./trajectory.css?inline";
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
 * session log (`trajectory` → `ledger`). One per plugin instance.
 */
function createTrajectory(deps: TrajectoryDeps): () => JSX.Element {
  const view = createView(deps);
  const { selection, tab, setCollapsed, query, setQuery, sort, setRange, setZoom, menu, setMenu, stuck, setStuck, follow, select, typeMatches, refs } = view;
  const { Toolbar } = createToolbar(view);
  const { Overview } = createTimeline(view);
  const { Table, ContextMenu, StatusBar } = createTable(view);
  const { Details } = createDetails(view);

  function Trajectory(): JSX.Element {
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

    createEffect(
      on(
        () => deps.threads.activeId(),
        () => {
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
    createEffect(
      on(
        () => sort().key,
        (key) => {
          if (key === "time") follow();
        },
        { defer: true },
      ),
    );
    const onScroll = () => {
      const top = refs.scroller!.scrollTop;
      // Only scrolling up stops following: rows added below move the bottom away too.
      if (refs.scroller!.scrollHeight - top - refs.scroller!.clientHeight < 24) setStuck(true);
      else if (top < refs.lastTop) setStuck(false);
      refs.lastTop = top;
    };

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
        else if (selection() !== undefined) select(undefined);
        else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (typing || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      event.preventDefault();
      const rows = [...root.querySelectorAll<HTMLTableRowElement>("tbody tr[data-record]")];
      const s = selection();
      const current = rows.findIndex((row) => s?.type === "record" && row.dataset.record === s.id);
      const next = rows[stepFor(event.key, current, rows.length)!];
      if (next === undefined) return;
      select({ type: "record", id: next.dataset.record! }, tab());
      next.scrollIntoView({ block: "nearest" });
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
            onScroll={onScroll}
          >
            <Show
              when={records().length > 0}
              fallback={
                <p class="trj-empty">{deps.threads.activeId() === undefined ? "Start a chat to see its trajectory." : "No records on this branch yet."}</p>
              }
            >
              <Table records={records()} visible={visible()} scale={scale()} ledgerSpans={spanById()} now={now()} compact={selection() !== undefined} />
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

/** The session as the requests and tool runs behind it, like DevTools' Network panel. */
export default defineUiPlugin({
  id: "trajectory",
  styles,
  requires: { threads: Threads, notify: Notify, slots: Slots },
  setup: ({ threads, notify, slots }) => {
    slots.add(Views, { id: "trajectory", title: "Trajectory", icon: TrajectoryIcon, component: createTrajectory({ threads, notify, slots }) });
  },
});
