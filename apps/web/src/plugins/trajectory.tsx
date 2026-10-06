import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import {
  RECORD_KIND_LABEL,
  contentText,
  formatCost,
  formatDuration,
  formatTokens,
  ledger,
  ledgerSpans,
  parseLedgerFilter,
  promptDiff,
  rebuildRequest,
  recordDuration,
  recordFailed,
  recordName,
  recordRequest,
  recordStatus,
  recordWithin,
  sortRecords,
  trajectory as projectTrajectory,
} from "@lemma/contracts";
import type { AssistantRecord, LedgerRecord, LedgerSort, LedgerSpan, SystemRecord, Timing, ToolRecord, TrajectoryRequest } from "@lemma/contracts";
import { stepFor } from "../lib/keys.ts";
import { clockTime } from "../model/format.ts";
import { createNow } from "../lib/now.ts";
import { Notify, Threads, Slots, ToolViews, TrajectoryActions, TrajectoryTabs, Views } from "../ui/contracts.ts";
import type { NotifyService, ThreadsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotsService } from "../ui/slots.ts";
import { Contained, CopyIcon, Markdown, TrajectoryIcon, XIcon } from "../ui/parts.tsx";
import { copyText } from "../lib/clipboard.ts";
import styles from "./trajectory.css?inline";

/**
 * The Trajectory view, modeled on Chrome DevTools' Network panel and on
 * DeepSeek Harness's trajectory: a filter toolbar, a zoomable three-lane
 * overview, a sortable table with a waterfall column, a details panel with
 * tabs, a context menu, and a status bar. Everything is projected from the
 * session log (`trajectory` → `ledger`).
 */

interface TrajectoryDeps {
  readonly threads: ThreadsService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
}

/** The view and its state (selection, filters, zoom), one per plugin instance. */
function createTrajectory(deps: TrajectoryDeps): () => JSX.Element {
  /** The table's rows by record id, for bringing one into view from the overview. */
  const rowElements = new Map<string, HTMLTableRowElement>();
  // ------------------------------------------------------------------ state

  type Selection = { readonly type: "record"; readonly id: string } | { readonly type: "request"; readonly eventId: string };
  type Kind = LedgerRecord["kind"];
  type TypeFilter = "all" | Kind | "error";
  type SortKey = LedgerSort;

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
  let filterInput: HTMLInputElement | undefined;
  let scroller: HTMLDivElement | undefined;
  /** Where the table last was: a scroll above it is the reader's, which stops following. */
  let lastTop = 0;

  /** Brings the newest row into view and keeps it there. */
  const follow = () => {
    setStuck(true);
    queueMicrotask(() => {
      if (scroller === undefined) return;
      scroller.scrollTo({ top: scroller.scrollHeight });
      // Its own move, recorded now: one scroll event may cover it and the reader's scroll up after it.
      lastTop = scroller.scrollTop;
    });
  };

  const select = (next: Selection | undefined, initialTab?: string) => {
    setSelection(next);
    setTab(initialTab);
  };

  // ------------------------------------------------------------------ helpers

  const firstLine = (text: string) =>
    text
      .trim()
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const inputTokens = (usage: { input: number; cacheRead: number; cacheWrite: number }) => usage.input + usage.cacheRead + usage.cacheWrite;
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

  // ------------------------------------------------------------------ time scale

  /** Pixels the idle time between two turns collapses to, per 1000px of width. */
  const GAP = 0.012;

  /**
   * Maps times to fractions of the full axis: actual time within each turn,
   * with the idle time between turns (the user reading, typing, or away)
   * collapsed to a fixed gap so one long pause does not squash every turn.
   */
  function timeScale(all: readonly LedgerSpan[], now: number) {
    const byTurn = new Map<string, { from: number; to: number }>();
    for (const span of all) {
      const key = span.record.turn.turnId;
      const end = span.end ?? now;
      const current = byTurn.get(key);
      byTurn.set(key, current === undefined ? { from: span.start, to: end } : { from: Math.min(current.from, span.start), to: Math.max(current.to, end) });
    }
    let active = 0;
    const segments = [...byTurn.values()]
      .sort((a, b) => a.from - b.from)
      .map((segment, index) => {
        const out = { ...segment, before: active, index };
        active += Math.max(1, segment.to - segment.from);
        return out;
      });
    const total = Math.max(1, active);
    const usable = 1 - GAP * Math.max(0, segments.length - 1);
    const fraction = (at: number) => {
      const segment = segments.filter((candidate) => candidate.from <= at).at(-1) ?? segments[0];
      if (segment === undefined) return 0;
      const within = Math.min(Math.max(at - segment.from, 0), Math.max(1, segment.to - segment.from));
      return segment.index * GAP + ((segment.before + within) / total) * usable;
    };
    const timeAt = (f: number) => {
      for (const segment of segments) {
        const left = fraction(segment.from);
        const right = fraction(segment.to);
        if (f <= right || segment === segments.at(-1)) {
          if (f <= left) return segment.from;
          return segment.from + ((f - left) / Math.max(1e-9, right - left)) * (segment.to - segment.from);
        }
      }
      return 0;
    };
    /** Milliseconds of active time per unit of fraction, for the ruler. */
    const msPerFraction = total / usable;
    return { fraction, timeAt, boundaries: segments.slice(1).map((segment) => fraction(segment.from) - GAP / 2), msPerFraction, empty: segments.length === 0 };
  }
  type Scale = ReturnType<typeof timeScale>;

  /** Position of a fraction inside a box of `width` px under the current zoom. */
  const place = (f: number, width: number) => ((f - zoom().start) / (zoom().end - zoom().start)) * width;

  /** Wheel zooms around the pointer; horizontal wheel pans. */
  const wheelZoom = (event: WheelEvent, box: DOMRect) => {
    event.preventDefault();
    const current = zoom();
    const span = current.end - current.start;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const start = Math.min(Math.max(0, current.start + (event.deltaX / box.width) * span), 1 - span);
      setZoom({ start, end: start + span });
      return;
    }
    const anchor = current.start + ((event.clientX - box.left) / box.width) * span;
    const next = Math.min(1, Math.max(0.002, span * Math.exp(event.deltaY * 0.0015)));
    const start = Math.min(Math.max(0, anchor - ((anchor - current.start) / span) * next), 1 - next);
    setZoom({ start, end: start + next });
  };

  // ------------------------------------------------------------------ toolbar

  const TYPES: readonly { id: TypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "user", label: "User" },
    { id: "assistant", label: "Model" },
    { id: "tool", label: "Tool" },
    { id: "system", label: "System" },
    { id: "error", label: "Errors" },
  ];

  function Toolbar() {
    return (
      <div class="dt-toolbar" role="toolbar" aria-label="Trajectory toolbar">
        <label class="dt-filter">
          <svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" />
          </svg>
          <input
            ref={(el) => {
              filterInput = el;
            }}
            type="search"
            placeholder="Filter  (is:error  tool:bash  turn:2  -text)"
            aria-label="Filter trajectory"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            spellcheck={false}
          />
        </label>
        <span class="dt-sep" />
        <For each={TYPES}>
          {(type) => (
            <button class="dt-chip" aria-pressed={typeFilter() === type.id} onClick={() => setTypeFilter(type.id)}>
              {type.label}
            </button>
          )}
        </For>
        <span class="dt-sep" />
        <label class="dt-check" data-tip="Group rows under their turn">
          <input type="checkbox" checked={groupTurns()} onChange={(event) => setGroupTurns(event.currentTarget.checked)} />
          Group by turn
        </label>
        <label class="dt-check" data-tip="Every record gets the same width in the overview and waterfall">
          <input type="checkbox" checked={equalDurations()} onChange={(event) => setEqualDurations(event.currentTarget.checked)} />
          Equal widths
        </label>
        <Show when={zoom().start > 0 || zoom().end < 1}>
          <button class="dt-chip trj-accent" onClick={() => setZoom({ start: 0, end: 1 })} data-tip="Show the whole thread (or double-click the overview)">
            Reset zoom
          </button>
        </Show>
        <Show when={range()}>
          {(r) => (
            <button class="dt-chip trj-accent" onClick={() => setRange(undefined)} data-tip="Clear the selected time range">
              {formatDuration(r().to - r().from)} range <XIcon />
            </button>
          )}
        </Show>
        <Show when={!stuck() && sort().key === "time"}>
          <span class="dt-sep" />
          <button class="dt-chip" onClick={follow} data-tip="Show the newest record and keep it in view">
            ↓ Follow
          </button>
        </Show>
      </div>
    );
  }

  // ------------------------------------------------------------------ overview

  const LANE_TOP = 18;

  function Overview(props: { ledgerSpans: readonly LedgerSpan[]; scale: Scale; now: number; matches: (record: LedgerRecord) => boolean }) {
    let track!: HTMLDivElement;
    const [width, setWidth] = createSignal(600);
    const [hover, setHover] = createSignal<{ span: LedgerSpan; x: number }>();
    const [drag, setDrag] = createSignal<{ from: number; to: number }>();
    const [pan, setPan] = createSignal<{ x: number; start: number; end: number }>();
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    onCleanup(() => observer.disconnect());

    const order = createMemo(() => new Map(props.ledgerSpans.map((span, index) => [span, index])));
    const fractionOf = (span: LedgerSpan, end: boolean) => {
      if (equalDurations()) return (order().get(span)! + (end ? 0.8 : 0)) / Math.max(1, props.ledgerSpans.length);
      return props.scale.fraction(end ? (span.end ?? props.now) : span.start);
    };
    const x = (f: number) => place(f, width());
    const timeAt = (clientX: number) => {
      const box = track.getBoundingClientRect();
      const f = zoom().start + ((clientX - box.left) / box.width) * (zoom().end - zoom().start);
      return props.scale.timeAt(f);
    };
    // Ruler: ticks every "nice" amount of active time across the visible slice.
    const ticks = createMemo(() => {
      if (equalDurations() || props.scale.empty) return [];
      const visibleMs = (zoom().end - zoom().start) * props.scale.msPerFraction;
      const raw = visibleMs / Math.max(1, width() / 90);
      const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
      const step = steps.find((candidate) => candidate >= raw) ?? 600_000;
      const stepFraction = step / props.scale.msPerFraction;
      const out: { left: number; label: string }[] = [];
      for (let f = Math.ceil(zoom().start / stepFraction) * stepFraction; f <= zoom().end; f += stepFraction) {
        out.push({ left: x(f), label: formatDuration(f * props.scale.msPerFraction) });
      }
      return out;
    });

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        setPan({ x: event.clientX, ...zoom() });
        track.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button !== 0 || equalDurations()) return;
      const start = timeAt(event.clientX);
      setDrag({ from: start, to: start });
      track.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const panning = pan();
      if (panning !== undefined) {
        const span = panning.end - panning.start;
        const start = Math.min(Math.max(0, panning.start - ((event.clientX - panning.x) / width()) * span), 1 - span);
        setZoom({ start, end: start + span });
        return;
      }
      const current = drag();
      if (current !== undefined) setDrag({ from: current.from, to: timeAt(event.clientX) });
    };
    const onPointerUp = (event: PointerEvent) => {
      const panning = pan();
      setPan(undefined);
      if (panning !== undefined) {
        if (Math.abs(event.clientX - panning.x) < 3) setRange(undefined);
        return;
      }
      const current = drag();
      setDrag(undefined);
      if (current === undefined) return;
      const from = Math.min(current.from, current.to);
      const to = Math.max(current.from, current.to);
      if (Math.abs(x(props.scale.fraction(to)) - x(props.scale.fraction(from))) < 4) setRange(undefined);
      else setRange({ from, to });
    };
    const shown = () => (equalDurations() ? undefined : (drag() ?? range()));

    return (
      <div class="trj-overview" role="region" aria-label="Trajectory overview">
        <div class="trj-lane-labels" aria-hidden="true">
          <span>in</span>
          <span>model</span>
          <span>tools</span>
        </div>
        <div
          class="trj-track"
          ref={(el) => {
            track = el;
            observer.observe(el);
          }}
          data-panning={pan() !== undefined}
          onWheel={(event) => wheelZoom(event, track.getBoundingClientRect())}
          onDblClick={() => setZoom({ start: 0, end: 1 })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
        >
          <For each={ticks()}>
            {(tick) => (
              <>
                <div class="trj-tick" style={{ left: `${tick.left}px` }} />
                <span class="trj-tick-label" style={{ left: `${tick.left + 3}px` }}>
                  {tick.label}
                </span>
              </>
            )}
          </For>
          <Show when={!equalDurations()}>
            <For each={props.scale.boundaries}>{(f) => <div class="trj-turn-boundary" style={{ left: `${x(f)}px` }} />}</For>
          </Show>
          <For each={props.ledgerSpans}>
            {(span) => {
              const left = () => x(fractionOf(span, false));
              const right = () => x(fractionOf(span, true));
              const ttft = () =>
                span.ttft === undefined || span.end === undefined || span.end <= span.start
                  ? undefined
                  : Math.min(100, (span.ttft / (span.end - span.start)) * 100);
              const current = () => {
                const s = selection();
                return s?.type === "record" && s.id === span.record.id;
              };
              const outside = () => {
                const r = range();
                return r !== undefined && !recordWithin(span.record, span, r.from, r.to, props.now);
              };
              return (
                <div
                  class="trj-span"
                  data-kind={span.record.kind}
                  data-error={span.error}
                  data-current={current()}
                  data-dim={outside() || !props.matches(span.record)}
                  data-running={span.end === undefined}
                  classList={{ "has-ttft": ttft() !== undefined && !equalDurations() }}
                  style={{
                    left: `${left()}px`,
                    width: `${Math.max(2, right() - left() - 1)}px`,
                    top: `${LANE_TOP + span.lane * 11}px`,
                    "--ttft": `${ttft() ?? 0}%`,
                  }}
                  onPointerEnter={(event) => setHover({ span, x: event.clientX - track.getBoundingClientRect().left })}
                  onPointerLeave={() => setHover(undefined)}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.stopPropagation();
                  }}
                  onClick={() => {
                    select({ type: "record", id: span.record.id });
                    rowElements.get(span.record.id)?.scrollIntoView({ block: "nearest" });
                  }}
                />
              );
            }}
          </For>
          <Show when={shown()}>
            {(r) => {
              const a = () => x(props.scale.fraction(Math.min(r().from, r().to)));
              const b = () => x(props.scale.fraction(Math.max(r().from, r().to)));
              return <div class="trj-selection" style={{ left: `${a()}px`, width: `${Math.max(1, b() - a())}px` }} />;
            }}
          </Show>
          <Show when={hover()}>
            {(h) => (
              <div class="trj-tip" role="tooltip" style={{ left: `${Math.min(Math.max(h().x, 90), width() - 90)}px` }}>
                <strong>
                  {h().span.record.kind === "tool"
                    ? (h().span.record as ToolRecord).run.call.name
                    : h().span.record.kind === "assistant"
                      ? `Request #${(h().span.record as AssistantRecord).requestNumber}`
                      : RECORD_KIND_LABEL[h().span.record.kind]}
                </strong>
                <span>
                  {clockTime(h().span.start)} · {h().span.end === undefined ? "running" : formatDuration(h().span.end! - h().span.start)}
                </span>
                <Show when={h().span.ttft !== undefined && h().span.end !== undefined}>
                  <span>
                    TTFT {formatDuration(h().span.ttft!)} · decoding {formatDuration(h().span.end! - h().span.start - h().span.ttft!)}
                  </span>
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.ledgerSpans.length === 0}>
            <div class="trj-empty-track">No timing yet</div>
          </Show>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ table

  /** One row's bar in the waterfall column, on the same axis and zoom as the overview. */
  function Waterfall(props: { record: LedgerRecord; span: LedgerSpan | undefined; scale: Scale; index: number; count: number; now: number }) {
    const bounds = () => {
      const span = props.span;
      if (span === undefined) return undefined;
      if (equalDurations()) return { from: props.index / props.count, to: (props.index + 0.8) / props.count };
      return { from: props.scale.fraction(span.start), to: props.scale.fraction(span.end ?? props.now) };
    };
    const pct = (f: number) => ((f - zoom().start) / (zoom().end - zoom().start)) * 100;
    const ttft = () => {
      const span = props.span;
      return span?.ttft === undefined || span.end === undefined || span.end <= span.start
        ? undefined
        : Math.min(100, (span.ttft / (span.end - span.start)) * 100);
    };
    return (
      <div class="trj-wf">
        <Show when={bounds()}>
          {(b) => (
            <div
              class="trj-wf-bar"
              data-kind={props.record.kind}
              data-error={props.span!.error}
              data-running={props.span!.end === undefined}
              classList={{ "has-ttft": ttft() !== undefined && !equalDurations() }}
              style={{ left: `${pct(b().from)}%`, width: `max(2px, ${pct(b().to) - pct(b().from)}%)`, "--ttft": `${ttft() ?? 0}%` }}
              data-tip={`${clockTime(props.span!.start)}${props.span!.end === undefined ? " · running" : ` · ${formatDuration(props.span!.end - props.span!.start)}`}${props.span!.ttft === undefined ? "" : ` · TTFT ${formatDuration(props.span!.ttft)}`}`}
            />
          )}
        </Show>
      </div>
    );
  }

  function NameCell(props: { record: LedgerRecord }) {
    const r = props.record;
    return (
      <span class="trj-name">
        <i class="trj-dot" data-kind={r.kind} data-error={recordFailed(r)} />
        <Switch
          fallback={
            <span
              class="trj-text"
              classList={{
                "trj-muted": r.kind === "system" || (r.kind === "assistant" && !firstLine(contentText(r.message.content)) && !r.failed),
                "trj-error": recordFailed(r),
              }}
            >
              {recordName(r)}
            </span>
          }
        >
          <Match when={r.kind === "tool" && r}>
            {(tool) => (
              <span class="trj-text">
                <span class="trj-call-name">{tool().run.call.name}</span>
                <span class="trj-call-args"> {JSON.stringify(tool().run.call.arguments)}</span>
              </span>
            )}
          </Match>
        </Switch>
      </span>
    );
  }

  type Row =
    | { readonly type: "record"; readonly record: LedgerRecord; readonly index: number }
    | { readonly type: "turn"; readonly turn: LedgerRecord["turn"]; readonly count: number };

  const COLUMNS: readonly { key: SortKey | "initiator" | "waterfall"; label: string; class: string; sortable: boolean }[] = [
    { key: "name", label: "Name", class: "trj-c-name", sortable: true },
    { key: "status", label: "Status", class: "trj-c-status", sortable: true },
    { key: "type", label: "Type", class: "trj-c-type", sortable: true },
    { key: "initiator", label: "Initiator", class: "trj-c-init", sortable: false },
    { key: "tokens", label: "Tokens", class: "trj-c-tok", sortable: true },
    { key: "duration", label: "Time", class: "trj-c-time", sortable: true },
    { key: "waterfall", label: "Waterfall", class: "trj-c-wf", sortable: false },
  ];

  function Table(props: {
    records: readonly LedgerRecord[];
    visible: readonly LedgerRecord[];
    scale: Scale;
    ledgerSpans: ReadonlyMap<string, LedgerSpan>;
    now: number;
    compact: boolean;
  }) {
    const inRange = (record: LedgerRecord) => {
      const r = range();
      return r === undefined || recordWithin(record, props.ledgerSpans.get(record.id), r.from, r.to, props.now);
    };
    const sorted = createMemo(() => sortRecords(props.visible, sort().key, sort().desc, deps.threads.busy()));
    // Group rows open each turn, in time order only; a sorted table is flat, as in DevTools.
    const rows = createMemo(() => {
      const out: Row[] = [];
      const grouped = groupTurns() && sort().key === "time";
      const indexOf = new Map(props.records.map((record, index) => [record.id, index]));
      let turn: LedgerRecord["turn"] | undefined;
      for (const record of sorted()) {
        if (grouped && record.turn !== turn) {
          turn = record.turn;
          out.push({ type: "turn", turn, count: sorted().filter((candidate) => candidate.turn === turn).length });
        }
        if (grouped && collapsed().has(record.turn.turnId)) continue;
        out.push({ type: "record", record, index: indexOf.get(record.id)! });
      }
      return out;
    });
    const selectedId = () => {
      const s = selection();
      return s?.type === "record" ? s.id : undefined;
    };
    const selectedRequest = () => {
      const s = selection();
      return s?.type === "request" ? s.eventId : undefined;
    };
    const sortBy = (key: SortKey) =>
      setSort((current) => (current.key === key ? (current.desc ? { key: "time", desc: false } : { key, desc: true }) : { key, desc: false }));
    const columns = () => (props.compact ? COLUMNS.slice(0, 1) : COLUMNS);
    let wfHeader: HTMLTableCellElement | undefined;

    return (
      <table class="trj-table dt-table" classList={{ compact: props.compact }}>
        <colgroup>
          <For each={columns()}>{(column) => <col class={column.class} />}</For>
        </colgroup>
        <thead>
          <tr>
            <For each={columns()}>
              {(column) => (
                <th
                  class={column.class}
                  data-sortable={column.sortable}
                  ref={(el) => {
                    if (column.key === "waterfall") wfHeader = el;
                  }}
                  aria-sort={sort().key === column.key ? (sort().desc ? "descending" : "ascending") : "none"}
                  onClick={() => {
                    if (column.sortable) sortBy(column.key as SortKey);
                  }}
                  onWheel={(event) => {
                    if (column.key === "waterfall" && wfHeader !== undefined) wheelZoom(event, wfHeader.getBoundingClientRect());
                  }}
                >
                  {column.label}
                  <Show when={sort().key === column.key && column.sortable}>
                    <span class="trj-sort">{sort().desc ? "▼" : "▲"}</span>
                  </Show>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <Switch>
                <Match when={row.type === "turn" && row}>
                  {(group) => {
                    const turn = () => group().turn;
                    const open = () => !collapsed().has(turn().turnId);
                    const toggle = () =>
                      setCollapsed((set) => {
                        const next = new Set(set);
                        if (!next.delete(turn().turnId)) next.add(turn().turnId);
                        return next;
                      });
                    return (
                      <tr class="trj-group" onClick={toggle}>
                        <td colSpan={columns().length}>
                          <div class="trj-group-row">
                            <span class="trj-caret" data-open={open()}>
                              ▶
                            </span>
                            <span class="trj-group-label">Turn {turn().index}</span>
                            <span class="trj-group-prompt">{turn().prompt === undefined ? "" : firstLine(contentText(turn().prompt!.content))}</span>
                            <span class="trj-group-meta">
                              {group().count} records · {turn().steps.length} requests
                              {turn().endedAt === undefined ? " · running" : ` · ${formatDuration(turn().endedAt! - turn().startedAt)}`}
                              {turn().end !== undefined && turn().end!.reason !== "done" ? ` · ${turn().end!.reason}` : ""}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </Match>
                <Match when={row.type === "record" && row}>
                  {(item) => {
                    const r = item().record;
                    const assistant = r.kind === "assistant" ? r : undefined;
                    const initiator = r.kind === "tool" || r.kind === "assistant" ? r.step.request : r.kind === "system" ? r.request : undefined;
                    const number =
                      r.kind === "assistant" || r.kind === "system"
                        ? r.requestNumber
                        : r.kind === "tool"
                          ? props.records.find((c): c is AssistantRecord => c.kind === "assistant" && c.step === r.step)?.requestNumber
                          : undefined;
                    const duration = recordDuration(r);
                    const usage = assistant?.message.usage;
                    return (
                      <tr
                        ref={(element) => {
                          rowElements.set(r.id, element);
                          onCleanup(() => rowElements.get(r.id) === element && rowElements.delete(r.id));
                        }}
                        data-row
                        data-record={r.id}
                        tabindex="-1"
                        data-kind={r.kind}
                        data-error={recordFailed(r)}
                        data-selected={selectedId() === r.id}
                        data-dim={!inRange(r)}
                        onClick={() => select({ type: "record", id: r.id })}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          select({ type: "record", id: r.id });
                          setMenu({ x: event.clientX, y: event.clientY, record: r });
                        }}
                      >
                        <td class="trj-c-name">
                          <NameCell record={r} />
                        </td>
                        <Show when={!props.compact}>
                          <td class="trj-c-status" classList={{ "trj-error": recordFailed(r) }}>
                            {statusOf(r)}
                          </td>
                          <td class="trj-c-type">{RECORD_KIND_LABEL[r.kind]}</td>
                          <td class="trj-c-init">
                            <Show when={initiator !== undefined && number !== undefined} fallback={<span class="trj-muted">turn {r.turn.index}</span>}>
                              <button
                                class="trj-link-cell"
                                data-active={selectedRequest() === initiator!.eventId}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  select({ type: "request", eventId: initiator!.eventId });
                                }}
                              >
                                request #{number}
                              </button>
                            </Show>
                          </td>
                          <td
                            class="trj-c-tok trj-num"
                            data-tip={
                              usage === undefined
                                ? undefined
                                : `${usage.cacheRead.toLocaleString()} cached · ${(usage.input + usage.cacheWrite).toLocaleString()} new · ${usage.output.toLocaleString()} out`
                            }
                          >
                            {usage === undefined ? "" : `${formatTokens(inputTokens(usage))} / ${formatTokens(usage.output)}`}
                          </td>
                          <td class="trj-c-time trj-num">
                            {duration === undefined ? (r.kind === "assistant" || r.kind === "tool" ? "(pending)" : "") : formatDuration(duration)}
                          </td>
                          <td class="trj-c-wf">
                            <Waterfall
                              record={r}
                              span={props.ledgerSpans.get(r.id)}
                              scale={props.scale}
                              index={item().index}
                              count={props.records.length}
                              now={props.now}
                            />
                          </td>
                        </Show>
                      </tr>
                    );
                  }}
                </Match>
              </Switch>
            )}
          </For>
        </tbody>
      </table>
    );
  }

  // ------------------------------------------------------------------ context menu

  function ContextMenu() {
    onMount(() => {
      const close = () => setMenu(undefined);
      window.addEventListener("pointerdown", close);
      window.addEventListener("blur", close);
      onCleanup(() => {
        window.removeEventListener("pointerdown", close);
        window.removeEventListener("blur", close);
      });
    });
    const items = (record: LedgerRecord): { label: string; run: () => void }[] => {
      const request = recordRequest(record);
      const out: { label: string; run: () => void }[] = [];
      if (request !== undefined) out.push({ label: "Inspect request", run: () => select({ type: "request", eventId: request.eventId }) });
      if (request !== undefined)
        out.push({
          label: "Copy exact request",
          run: () => {
            const rebuilt = rebuildRequest(deps.threads.branch(), request.eventId);
            if (rebuilt !== undefined) void copy(json(rebuilt));
          },
        });
      if (record.kind === "tool") {
        out.push({ label: "Copy payload", run: () => void copy(json(record.run.call.arguments)) });
        if (record.run.result !== undefined) out.push({ label: "Copy result", run: () => void copy(contentText(record.run.result!.content)) });
        out.push({ label: `Filter: tool:${record.run.call.name}`, run: () => setQuery(`tool:${record.run.call.name}`) });
      }
      if (record.kind === "assistant" || record.kind === "user") out.push({ label: "Copy text", run: () => void copy(contentText(record.message.content)) });
      out.push({
        label: "Copy as JSON",
        run: () => void copy(json(record.kind === "tool" ? record.run : record.kind === "system" ? record.request : record.message)),
      });
      out.push({ label: `Filter: turn:${record.turn.index}`, run: () => setQuery(`turn:${record.turn.index}`) });
      // Records of model calls and tool runs are log events; the next prompt can continue from one of them.
      if (record.kind === "assistant" || record.kind === "tool") {
        out.push({ label: "Branch from here", run: () => void deps.threads.checkout(record.id) });
      }
      // Then what plugins add.
      for (const action of deps.slots.list(TrajectoryActions)) {
        if (action.when?.(record) ?? true) out.push({ label: action.label, run: () => action.run(record) });
      }
      return out;
    };
    return (
      <Show when={menu()}>
        {(m) => (
          <div
            class="trj-menu"
            role="menu"
            style={{ left: `${Math.min(m().x, window.innerWidth - 220)}px`, top: `${Math.min(m().y, window.innerHeight - 260)}px` }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <For each={items(m().record)}>
              {(item) => (
                <button
                  role="menuitem"
                  class="trj-menu-item"
                  onClick={() => {
                    item.run();
                    setMenu(undefined);
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    );
  }

  // ------------------------------------------------------------------ status bar

  function StatusBar(props: { records: readonly LedgerRecord[]; visible: readonly LedgerRecord[]; now: number }) {
    const stats = createMemo(() => {
      let requests = 0;
      let tools = 0;
      let errors = 0;
      let input = 0;
      let output = 0;
      let cost = 0;
      for (const record of props.visible) {
        if (record.kind === "assistant") {
          requests++;
          input += inputTokens(record.message.usage);
          output += record.message.usage.output;
          cost += record.message.usage.cost.total;
        }
        if (record.kind === "tool") tools++;
        if (recordFailed(record)) errors++;
      }
      const active = [...new Set(props.visible.map((record) => record.turn))].reduce((sum, turn) => sum + ((turn.endedAt ?? props.now) - turn.startedAt), 0);
      return { requests, tools, errors, input, output, cost, active };
    });
    return (
      <div class="dt-status" role="status">
        <span>
          {props.visible.length} / {props.records.length} records
        </span>
        <span>{stats().requests} requests</span>
        <span>{stats().tools} tool calls</span>
        <Show when={stats().errors > 0}>
          <span class="trj-error">{stats().errors} errors</span>
        </Show>
        <span data-tip="Input tokens (including cache) / output tokens">
          {formatTokens(stats().input)} / {formatTokens(stats().output)} tokens
        </span>
        <Show when={stats().cost > 0}>
          <span>{formatCost(stats().cost)}</span>
        </Show>
        <span data-tip="Time the agent was working, summed over turns">Active: {formatDuration(stats().active)}</span>
        <Show when={range()}>{(r) => <span class="trj-accent">Range: {formatDuration(r().to - r().from)}</span>}</Show>
      </div>
    );
  }

  // ------------------------------------------------------------------ details

  function Section(props: { title: string; children: JSX.Element; aside?: JSX.Element }) {
    return (
      <section class="dt-section">
        <h4>
          <span>{props.title}</span>
          <Show when={props.aside}>
            <span class="dt-section-aside">{props.aside}</span>
          </Show>
        </h4>
        {props.children}
      </section>
    );
  }

  function Facts(props: { rows: readonly (readonly [string, JSX.Element | string | undefined])[] }) {
    return (
      <dl class="dt-facts">
        <For each={props.rows.filter(([, value]) => value !== undefined && value !== "")}>
          {([key, value]) => (
            <>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </>
          )}
        </For>
      </dl>
    );
  }

  function Pre(props: { text: string; error?: boolean }) {
    return (
      <div class="trj-pre-wrap">
        <button class="trj-copy" aria-label="Copy" data-tip="Copy" onClick={() => void copy(props.text)}>
          <CopyIcon />
        </button>
        <pre class="trj-pre" classList={{ "trj-error": props.error === true }}>
          {props.text}
        </pre>
      </div>
    );
  }

  function Meta(props: { source: string; chars: number; changed: boolean }) {
    return (
      <>
        <span class="trj-source">{props.source}</span>
        {props.chars.toLocaleString()} chars
        <Show when={props.changed}>
          <span class="trj-changed">changed</span>
        </Show>
      </>
    );
  }

  function SystemPrompt(props: { request: TrajectoryRequest }) {
    const unsplit = () => props.request.sections.length > 0 && props.request.sections.every((section) => section.text === undefined);
    return (
      <>
        <For each={props.request.sections}>
          {(section) => (
            <Section title={section.id} aside={<Meta source={section.source} chars={section.chars} changed={section.changed} />}>
              <Show when={section.text !== undefined}>
                <Pre text={section.text!} />
              </Show>
            </Section>
          )}
        </For>
        <Show when={unsplit() && props.request.system}>
          {(system) => (
            <Section title="Whole prompt">
              <Pre text={system()} />
            </Section>
          )}
        </Show>
      </>
    );
  }

  function ToolsList(props: { request: TrajectoryRequest }) {
    return (
      <For each={props.request.tools}>
        {(tool) => (
          <Section title={tool.name} aside={<Meta source={tool.source} chars={tool.chars} changed={tool.changed} />}>
            <Show when={tool.spec}>
              {(spec) => (
                <>
                  <p class="trj-desc">{spec().description}</p>
                  <Pre text={json(spec().parameters)} />
                </>
              )}
            </Show>
          </Section>
        )}
      </For>
    );
  }

  /** How a request's system prompt differs from the request before it (`lemma inspect --request N --diff`). */
  function Diff(props: { previous: TrajectoryRequest | undefined; request: TrajectoryRequest }) {
    const sections = createMemo(() => promptDiff(props.previous, props.request));
    return (
      <Switch>
        <Match when={props.previous === undefined}>
          <p class="trj-desc">This is the first request; everything in it is new (see System Prompt).</p>
        </Match>
        <Match when={sections().length === 0}>
          <p class="trj-desc">The system prompt is unchanged from the request before.</p>
        </Match>
        <Match when={true}>
          <For each={sections()}>
            {(section) => (
              <Section
                title={section.id}
                aside={
                  <>
                    <span class="trj-source">{section.source}</span>
                    {section.status}
                  </>
                }
              >
                <pre class="trj-pre trj-diff">
                  <For each={section.lines}>
                    {(line) => (
                      <span class={`trj-diff-${line.kind}`}>
                        {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                        {line.text}
                        {"\n"}
                      </span>
                    )}
                  </For>
                </pre>
              </Section>
            )}
          </For>
        </Match>
      </Switch>
    );
  }

  /** Where a request's prompt came from, by contributing plugin. */
  function Sources(props: { request: TrajectoryRequest }) {
    const rows = createMemo(() => {
      const bySource = new Map<string, { chars: number; parts: string[] }>();
      const parts = [
        ...props.request.sections.map((section) => ({ source: section.source, chars: section.chars, label: section.id })),
        ...props.request.tools.map((tool) => ({ source: tool.source, chars: tool.chars, label: tool.name })),
      ];
      for (const part of parts) {
        const entry = bySource.get(part.source) ?? { chars: 0, parts: [] };
        entry.chars += part.chars;
        entry.parts.push(part.label);
        bySource.set(part.source, entry);
      }
      return [...bySource].sort((a, b) => b[1].chars - a[1].chars);
    });
    const max = () => Math.max(1, ...rows().map(([, entry]) => entry.chars));
    return (
      <div class="trj-sources">
        <For each={rows()}>
          {([source, entry]) => (
            <div class="trj-source-row">
              <span class="trj-source-name">{source}</span>
              <span class="trj-source-bar">
                <i style={{ width: `${(entry.chars / max()) * 100}%` }} />
              </span>
              <span class="trj-source-chars">{entry.chars.toLocaleString()}</span>
              <span class="trj-source-parts">{entry.parts.join(", ")}</span>
            </div>
          )}
        </For>
      </div>
    );
  }

  interface Tab {
    readonly id: string;
    readonly label: string;
    readonly render: () => JSX.Element;
  }

  function TimingFacts(props: { timing: Timing; output?: number | undefined }) {
    const t = () => props.timing;
    const decoding = () => (t().firstTokenAt === undefined ? undefined : t().endedAt - t().firstTokenAt!);
    return (
      <Facts
        rows={[
          ["Started", clockTime(t().startedAt)],
          [
            "First token",
            t().firstTokenAt === undefined ? undefined : `${clockTime(t().firstTokenAt!)} · TTFT ${formatDuration(t().firstTokenAt! - t().startedAt)}`,
          ],
          ["Ended", clockTime(t().endedAt)],
          ["Duration", formatDuration(t().endedAt - t().startedAt)],
          ["Decoding", decoding() === undefined ? undefined : formatDuration(decoding()!)],
          [
            "Throughput",
            decoding() !== undefined && decoding()! > 0 && props.output ? `${(props.output / (decoding()! / 1000)).toFixed(1)} tokens/s` : undefined,
          ],
        ]}
      />
    );
  }

  function requestTabs(request: TrajectoryRequest, assistant: AssistantRecord | undefined, previous: TrajectoryRequest | undefined): Tab[] {
    const usage = assistant?.message.usage;
    const timing = assistant?.timing;
    return [
      {
        id: "summary",
        label: "Summary",
        render: () => (
          <>
            <Facts
              rows={[
                ["Model", request.model],
                ["Thinking", request.thinking],
                ["History", `${request.messages} message${request.messages === 1 ? "" : "s"}`],
                [
                  "Composition",
                  <span class="trj-mono" data-tip={request.composition}>
                    {request.composition.slice(0, 16)}
                  </span>,
                ],
                ["Event", <span class="trj-mono">{request.eventId}</span>],
              ]}
            />
            <Section title="Prompt by source" aside={`${request.sections.length} sections · ${request.tools.length} tools`}>
              <Sources request={request} />
            </Section>
            <button
              class="icon-button"
              aria-label="Copy exact request"
              data-tip="Copy exact request"
              onClick={() => {
                const rebuilt = rebuildRequest(deps.threads.branch(), request.eventId);
                if (rebuilt !== undefined) void copy(json(rebuilt));
              }}
            >
              <CopyIcon />
            </button>
          </>
        ),
      },
      { id: "system", label: "System Prompt", render: () => <SystemPrompt request={request} /> },
      { id: "tools", label: "Tools", render: () => <ToolsList request={request} /> },
      { id: "diff", label: "Diff", render: () => <Diff previous={previous} request={request} /> },
      ...(usage === undefined
        ? []
        : [
            {
              id: "usage",
              label: "Usage",
              render: () => (
                <Facts
                  rows={[
                    ["Input", `${inputTokens(usage).toLocaleString()} tokens`],
                    ["Cache read", usage.cacheRead.toLocaleString()],
                    ["Cache write", usage.cacheWrite.toLocaleString()],
                    ["Uncached", usage.input.toLocaleString()],
                    ["Output", usage.output.toLocaleString()],
                    ["Reasoning", usage.reasoning?.toLocaleString()],
                    ["Cost", usage.cost.total > 0 ? `$${usage.cost.total.toFixed(4)}` : undefined],
                  ]}
                />
              ),
            },
          ]),
      ...(timing === undefined ? [] : [{ id: "timing", label: "Timing", render: () => <TimingFacts timing={timing} output={usage?.output} /> }]),
    ];
  }

  function recordTabs(record: LedgerRecord, previous: TrajectoryRequest | undefined): Tab[] {
    switch (record.kind) {
      case "system":
        return [
          { id: "system", label: "System Prompt", render: () => <SystemPrompt request={record.request} /> },
          { id: "diff", label: "Diff", render: () => <Diff previous={previous} request={record.request} /> },
          { id: "tools", label: "Tools", render: () => <ToolsList request={record.request} /> },
          { id: "sources", label: "Sources", render: () => <Sources request={record.request} /> },
        ];
      case "user":
        return [
          {
            id: "summary",
            label: "Summary",
            render: () => (
              <>
                <Facts
                  rows={[
                    ["Turn", String(record.turn.index)],
                    ["Sent", clockTime(record.at)],
                  ]}
                />
                <Pre text={contentText(record.message.content)} />
              </>
            ),
          },
          { id: "raw", label: "Raw", render: () => <Pre text={json(record.message)} /> },
        ];
      case "assistant": {
        const message = record.message;
        const thinking = thinkingOf(record);
        const text = contentText(message.content);
        return [
          {
            id: "summary",
            label: "Summary",
            render: () => (
              <>
                <Facts
                  rows={[
                    ["Request", `#${record.requestNumber}`],
                    ["Model", `${message.provider}/${message.model}`],
                    ["Stop", message.stopReason],
                    ["Error", message.errorMessage],
                    ["Tokens", `${formatTokens(inputTokens(message.usage))} in · ${formatTokens(message.usage.output)} out`],
                    ["Duration", record.timing === undefined ? undefined : formatDuration(record.timing.endedAt - record.timing.startedAt)],
                    ["TTFT", record.timing?.firstTokenAt === undefined ? undefined : formatDuration(record.timing.firstTokenAt - record.timing.startedAt)],
                    ["Tool calls", callsOf(record).join(", ")],
                  ]}
                />
                <Show when={record.step.request}>
                  {(request) => (
                    <button class="trj-link" onClick={() => select({ type: "request", eventId: request().eventId })}>
                      Open request #{record.requestNumber} →
                    </button>
                  )}
                </Show>
              </>
            ),
          },
          {
            id: "preview",
            label: "Preview",
            render: () => (
              <>
                <Show when={thinking}>
                  <details class="trj-thinking">
                    <summary>Thinking</summary>
                    <div class="trj-quote">{thinking}</div>
                  </details>
                </Show>
                <Show when={text} fallback={<p class="trj-desc">No text output.</p>}>
                  <div class="trj-md">
                    <Markdown text={text} />
                  </div>
                </Show>
              </>
            ),
          },
          { id: "raw", label: "Raw", render: () => <Pre text={json(message)} /> },
          ...(record.timing === undefined
            ? []
            : [{ id: "timing", label: "Timing", render: () => <TimingFacts timing={record.timing!} output={message.usage.output} /> }]),
        ];
      }
      case "tool": {
        const run = record.run;
        const result = run.result === undefined ? undefined : contentText(run.result.content);
        const timing = run.timing;
        return [
          {
            id: "summary",
            label: "Summary",
            render: () => (
              <>
                <Facts
                  rows={[
                    ["Tool", run.call.name],
                    ["Status", run.result === undefined ? "no result" : run.result.isError ? "error" : "ok"],
                    ["Duration", timing === undefined ? undefined : formatDuration(timing.endedAt - timing.startedAt)],
                    ["Call id", <span class="trj-mono">{run.call.id}</span>],
                  ]}
                />
                <Section title="Payload">
                  <Pre text={json(run.call.arguments)} />
                </Section>
                <Show when={result !== undefined}>
                  <Section title="Result">
                    <Pre text={result!} error={run.result?.isError === true} />
                  </Section>
                </Show>
              </>
            ),
          },
          { id: "payload", label: "Payload", render: () => <Pre text={json(run.call.arguments)} /> },
          ...(result === undefined ? [] : [{ id: "result", label: "Result", render: () => <Pre text={result} error={run.result?.isError === true} /> }]),
          ...(record.spec === undefined
            ? []
            : [
                {
                  id: "schema",
                  label: "Schema",
                  render: () => (
                    <>
                      <p class="trj-desc">{record.spec!.description}</p>
                      <Pre text={json(record.spec!.parameters)} />
                    </>
                  ),
                },
              ]),
          ...(timing === undefined
            ? []
            : [
                {
                  id: "timing",
                  label: "Timing",
                  render: () => (
                    <Facts
                      rows={[
                        ["Started", clockTime(timing.startedAt)],
                        ["Ended", clockTime(timing.endedAt)],
                        ["Duration", formatDuration(timing.endedAt - timing.startedAt)],
                      ]}
                    />
                  ),
                },
              ]),
        ];
      }
    }
  }

  /** A tool's own view (its `ToolViews` body), then the tabs plugins add for the record. */
  function addedTabs(record: LedgerRecord): Tab[] {
    const item = record.kind === "tool" ? deps.slots.get(ToolViews, record.run.call.name) : undefined;
    const view = item?.body;
    const tool: Tab[] =
      view === undefined || record.kind !== "tool"
        ? []
        : [
            {
              id: "view",
              label: "View",
              render: () => {
                const run = record.run;
                const result = run.result;
                return (
                  <Contained
                    slot={ToolViews}
                    item={item!}
                    component={view}
                    props={{
                      id: run.call.id,
                      name: run.call.name,
                      args: run.call.arguments,
                      result:
                        result === undefined
                          ? undefined
                          : { eventId: run.eventId ?? record.id, content: result.content, isError: result.isError, details: run.details },
                      state: result === undefined ? "interrupted" : result.isError ? "error" : "ok",
                    }}
                  />
                );
              },
            },
          ];
    return [
      ...tool,
      ...deps.slots
        .list(TrajectoryTabs)
        .filter((tab) => tab.when(record))
        .map((tab): Tab => ({
          id: `added:${tab.id}`,
          label: tab.label,
          render: () => <Contained slot={TrajectoryTabs} item={tab} component={tab.component} props={{ record }} />,
        })),
    ];
  }

  function Tabs(props: { tabs: readonly Tab[]; lead?: JSX.Element; title?: JSX.Element }) {
    const active = () => props.tabs.find((candidate) => candidate.id === tab()) ?? props.tabs[0];
    return (
      <>
        <div class="dt-tabs" role="tablist" aria-label="Event details">
          {props.lead}
          <For each={props.tabs}>
            {(candidate) => (
              <button role="tab" class="dt-tab" aria-selected={active()?.id === candidate.id} onClick={() => setTab(candidate.id)}>
                {candidate.label}
              </button>
            )}
          </For>
        </div>
        <Show when={props.title}>
          <div class="dt-details-title">{props.title}</div>
        </Show>
        <div class="trj-detail-body" role="tabpanel">
          {active()?.render()}
        </div>
      </>
    );
  }

  function Details(props: { records: readonly LedgerRecord[] }) {
    const systemFor = (eventId: string | undefined) =>
      eventId === undefined
        ? undefined
        : props.records.find((record): record is SystemRecord => record.kind === "system" && record.request.eventId === eventId);
    // Requests in log order, for each one's predecessor (the Diff tab).
    const requests = createMemo(() => {
      const seen = new Map<string, TrajectoryRequest>();
      for (const record of props.records) {
        const request = recordRequest(record);
        if (request !== undefined && !seen.has(request.eventId)) seen.set(request.eventId, request);
      }
      return [...seen.values()];
    });
    const previousOf = (eventId: string | undefined) => {
      const index = requests().findIndex((request) => request.eventId === eventId);
      return index > 0 ? requests()[index - 1] : undefined;
    };
    const view = createMemo(() => {
      const s = selection();
      if (s === undefined) return undefined;
      if (s.type === "record") {
        const record = props.records.find((candidate) => candidate.id === s.id);
        if (record === undefined) return undefined;
        const where =
          record.kind === "user"
            ? `Turn ${record.turn.index}`
            : record.kind === "system"
              ? `Request #${record.requestNumber}`
              : `Turn ${record.turn.index} · Step ${record.step.index}`;
        return {
          kind: record.kind as LedgerRecord["kind"] | "request",
          name: record.kind === "tool" ? record.run.call.name : "",
          where,
          tabs: [...recordTabs(record, previousOf(recordRequest(record)?.eventId)), ...addedTabs(record)],
        };
      }
      const assistant = props.records.find(
        (record): record is AssistantRecord => record.kind === "assistant" && !record.failed && record.step.request?.eventId === s.eventId,
      );
      const request = assistant?.step.request ?? systemFor(s.eventId)?.request;
      if (request === undefined) return undefined;
      return {
        kind: "request" as const,
        name: assistant === undefined ? "" : `#${assistant.requestNumber}`,
        where: assistant === undefined ? "" : `Turn ${assistant.turn.index} · Step ${assistant.step.index}`,
        tabs: requestTabs(request, assistant, previousOf(s.eventId)),
      };
    });
    return (
      <Show when={view()}>
        {(v) => (
          <aside class="trj-details dt-details" aria-label="Event details">
            <Tabs
              tabs={v().tabs}
              lead={
                <button class="dt-close" aria-label="Close details" data-tip="Close (Esc)" onClick={() => select(undefined)}>
                  <XIcon />
                </button>
              }
              title={
                <>
                  <span class="trj-dot" data-kind={v().kind} />
                  <span class="trj-details-kind">{v().kind === "request" ? "request" : RECORD_KIND_LABEL[v().kind as Kind]}</span>
                  <Show when={v().name}>
                    <span class="trj-mono">{v().name}</span>
                  </Show>
                  <span class="trj-details-where">{v().where}</span>
                </>
              }
            />
          </aside>
        )}
      </Show>
    );
  }

  // ------------------------------------------------------------------ view

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
      const top = scroller!.scrollTop;
      // Only scrolling up stops following: rows added below move the bottom away too.
      if (scroller!.scrollHeight - top - scroller!.clientHeight < 24) setStuck(true);
      else if (top < lastTop) setStuck(false);
      lastTop = top;
    };

    // DevTools keys: arrows move the selection, Escape closes the panel (or the menu), "/" and Ctrl/Cmd+F focus the filter.
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement;
      if ((event.key === "/" && !typing) || (event.key === "f" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        filterInput?.focus();
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
              scroller = el;
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
