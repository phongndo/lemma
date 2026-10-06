import { For, Match, Show, Switch, createMemo, onCleanup, onMount } from "solid-js";
import {
  RECORD_KIND_LABEL,
  contentText,
  formatCost,
  formatDuration,
  formatTokens,
  rebuildRequest,
  recordDuration,
  recordFailed,
  recordName,
  recordRequest,
  recordWithin,
  sortRecords,
} from "@lemma/contracts";
import type { AssistantRecord, LedgerRecord, LedgerSpan } from "@lemma/contracts";
import { inputTokens, ledgerStats, ttftPercent } from "../../model/timeline.ts";
import type { Scale } from "../../model/timeline.ts";
import { clockTime } from "../../model/format.ts";
import { TrajectoryActions } from "../../ui/contracts.ts";
import type { View, SortKey } from "./state.ts";

/** The records' table with its waterfall column, the row's context menu, and the status bar under them. */
export function createTable(view: View) {
  const {
    selection,
    equalDurations,
    groupTurns,
    collapsed,
    setCollapsed,
    setQuery,
    sort,
    setSort,
    range,
    zoom,
    menu,
    setMenu,
    select,
    firstLine,
    json,
    copy,
    statusOf,
    wheelZoom,
    deps,
    rowElements,
  } = view;

  /** One row's bar in the waterfall column, on the same axis and zoom as the overview. */
  function Waterfall(props: { record: LedgerRecord; span: LedgerSpan | undefined; scale: Scale; index: number; count: number; now: number }) {
    const bounds = () => {
      const span = props.span;
      if (span === undefined) return undefined;
      if (equalDurations()) return { from: props.index / props.count, to: (props.index + 0.8) / props.count };
      return { from: props.scale.fraction(span.start), to: props.scale.fraction(span.end ?? props.now) };
    };
    const pct = (f: number) => ((f - zoom().start) / (zoom().end - zoom().start)) * 100;
    const ttft = () => (props.span === undefined ? undefined : ttftPercent(props.span));
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

  function StatusBar(props: { records: readonly LedgerRecord[]; visible: readonly LedgerRecord[]; now: number }) {
    const stats = createMemo(() => ledgerStats(props.visible, props.now));
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

  return { Table, ContextMenu, StatusBar };
}
