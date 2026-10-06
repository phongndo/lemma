import { createSignal } from "solid-js";
import { recordFailed, recordStatus } from "@lemma/contracts";
import type { AssistantRecord, LedgerRecord, LedgerSort } from "@lemma/contracts";
import { wheeled } from "../../model/timeline.ts";
import { copyText } from "../../lib/clipboard.ts";
import type { NotifyService, ThreadsService } from "../../ui/contracts.ts";
import type { SlotsService } from "../../ui/slots.ts";

export interface TrajectoryDeps {
  readonly threads: ThreadsService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
}

export type Selection = { readonly type: "record"; readonly id: string } | { readonly type: "request"; readonly eventId: string };
export type Kind = LedgerRecord["kind"];
export type TypeFilter = "all" | Kind | "error";
export type SortKey = LedgerSort;

/** The view's state (selection, filters, zoom) and what its pieces share, one per plugin instance. */
export function createView(deps: TrajectoryDeps) {
  /** Elements the pieces set and read: the filter field, the table's scroller, and where it last was (a scroll above it is the reader's, which stops following). */
  const refs: { filterInput?: HTMLInputElement | undefined; scroller?: HTMLDivElement | undefined; lastTop: number } = { lastTop: 0 };
  /** The table's rows by record id, for bringing one into view from the overview. */
  const rowElements = new Map<string, HTMLTableRowElement>();

  const [selection, setSelection] = createSignal<Selection>();
  const [tab, setTab] = createSignal<string>();
  const [equalDurations, setEqualDurations] = createSignal(false);
  const [groupTurns, setGroupTurns] = createSignal(true);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [typeFilter, setTypeFilter] = createSignal<TypeFilter>("all");
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<{ key: SortKey; desc: boolean }>({ key: "time", desc: false });
  /** A time range dragged on the overview; rows outside it fade. */
  const [range, setRange] = createSignal<{ readonly from: number; readonly to: number }>();
  /** The visible slice of the time axis, as fractions of its full width. */
  const [zoom, setZoom] = createSignal({ start: 0, end: 1 });
  const [menu, setMenu] = createSignal<{ x: number; y: number; record: LedgerRecord }>();
  /** Whether the table keeps its newest row in view as rows arrive, as a log does; scrolling up stops it. */
  const [stuck, setStuck] = createSignal(true);

  /** Brings the newest row into view and keeps it there. */
  const follow = () => {
    setStuck(true);
    queueMicrotask(() => {
      if (refs.scroller === undefined) return;
      refs.scroller.scrollTo({ top: refs.scroller.scrollHeight });
      // Its own move, recorded now: one scroll event may cover it and the reader's scroll up after it.
      refs.lastTop = refs.scroller.scrollTop;
    });
  };

  const select = (next: Selection | undefined, initialTab?: string) => {
    setSelection(next);
    setTab(initialTab);
  };

  const firstLine = (text: string) =>
    text
      .trim()
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const thinkingOf = (record: AssistantRecord) => record.message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : [])).join("\n\n");
  const callsOf = (record: AssistantRecord) => record.message.content.flatMap((part) => (part.type === "toolCall" ? [part.name] : []));

  const copy = async (text: string) => {
    if (!(await copyText(text))) deps.notify.report(new Error("The clipboard refused the text"), "Could not copy");
  };

  const statusOf = (record: LedgerRecord) => recordStatus(record, deps.threads.busy());

  const typeMatches = (record: LedgerRecord) => {
    const filter = typeFilter();
    return filter === "all" || (filter === "error" ? recordFailed(record) : record.kind === filter);
  };

  /** Wheel zooms around the pointer; horizontal wheel pans. */
  const wheelZoom = (event: WheelEvent, box: DOMRect) => {
    event.preventDefault();
    setZoom(wheeled(zoom(), event, event.clientX - box.left, box.width));
  };

  return {
    deps,
    refs,
    rowElements,
    selection,
    setSelection,
    tab,
    setTab,
    equalDurations,
    setEqualDurations,
    groupTurns,
    setGroupTurns,
    collapsed,
    setCollapsed,
    typeFilter,
    setTypeFilter,
    query,
    setQuery,
    sort,
    setSort,
    range,
    setRange,
    zoom,
    setZoom,
    menu,
    setMenu,
    stuck,
    setStuck,
    follow,
    select,
    firstLine,
    json,
    thinkingOf,
    callsOf,
    copy,
    statusOf,
    typeMatches,
    wheelZoom,
  };
}
export type View = ReturnType<typeof createView>;
