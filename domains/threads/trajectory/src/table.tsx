import { For, Match, Show, Switch, createMemo, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { formatCost, formatDuration, formatTokens } from "@lemma/client/format";
import { contentText } from "@lemma/llm";
import { RECORD_KIND_LABEL, rebuildRequest, recordDuration, recordFailed, recordName, recordRequest, recordWithin, sortRecords } from "@lemma/sessions";
import type { AssistantRecord, LedgerRecord, LedgerSpan } from "@lemma/sessions";
import { inputTokens, ledgerStats, ttftPercent } from "./scale.ts";
import type { Scale } from "./scale.ts";
import { clockTime } from "@lemma/web/format";
import { stepFor } from "@lemma/web/keys";
import { usePlugin } from "@lemma/web";
import { TrajectoryActions } from "@lemma/threads";
import type { View, SortKey } from "./state.ts";

/** How much of a text a cell cuts short its tooltip shows. */
const TIP = 200;

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
              data-motion={props.span!.end === undefined || undefined}
              classList={{ "has-ttft": ttft() !== undefined && !equalDurations() }}
              style={{ left: `${pct(b().from)}%`, width: `max(2px, ${pct(b().to) - pct(b().from)}%)`, "--ttft": `${ttft() ?? 0}%` }}
              data-tip={`${clockTime(props.span!.start)}${props.span!.end === undefined ? " · running" : ` · ${formatDuration(props.span!.end - props.span!.start)}`}${props.span!.ttft === undefined ? "" : ` · TTFT ${formatDuration(props.span!.ttft)}`}`}
            />
          )}
        </Show>
      </div>
    );
  }

  /** A tooltip with the whole of a text a cell cuts short, up to a length a tooltip holds. */
  const tipOf = (text: string) => (text.length > TIP ? `${text.slice(0, TIP)}…` : text);

  function NameCell(props: { record: LedgerRecord }) {
    const r = props.record;
    return (
      <span class="trj-name">
        <i class="trj-dot" data-kind={r.kind} data-error={recordFailed(r)} />
        <Switch
          fallback={
            <span
              class="trj-text"
              data-tip={tipOf(recordName(r))}
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
              <span class="trj-text" data-tip={tipOf(`${tool().run.call.name} ${JSON.stringify(tool().run.call.arguments)}`)}>
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

  type ColumnKey = SortKey | "initiator" | "waterfall";
  const COLUMNS: readonly { key: ColumnKey; label: string; class: string; sortable: boolean }[] = [
    { key: "name", label: "Name", class: "trj-c-name", sortable: true },
    { key: "status", label: "Status", class: "trj-c-status", sortable: true },
    { key: "type", label: "Type", class: "trj-c-type", sortable: true },
    { key: "initiator", label: "Initiator", class: "trj-c-init", sortable: false },
    { key: "tokens", label: "Tokens", class: "trj-c-tok dt-num", sortable: true },
    { key: "duration", label: "Time", class: "trj-c-time dt-num", sortable: true },
    { key: "waterfall", label: "Waterfall", class: "trj-c-wf", sortable: false },
  ];
  /**
   * The columns a table narrower than its widths (px) leaves out, widest first and so least needed first, so the names
   * and the waterfall keep their room: a record's type shows in its dot, and its initiator in its details.
   */
  const NARROW: readonly { below: number; drops: readonly ColumnKey[] }[] = [
    { below: 640, drops: ["type", "initiator"] },
    { below: 540, drops: ["status"] },
  ];

  function Table(props: {
    records: readonly LedgerRecord[];
    visible: readonly LedgerRecord[];
    scale: Scale;
    ledgerSpans: ReadonlyMap<string, LedgerSpan>;
    now: number;
    compact: boolean;
    /** The width it has (its scroller's), which decides which columns fit. */
    width: number;
  }) {
    const inRange = (record: LedgerRecord) => {
      const r = range();
      return r === undefined || recordWithin(record, props.ledgerSpans.get(record.id), r.from, r.to, props.now);
    };
    const sorted = createMemo(() => sortRecords(props.visible, sort().key, sort().desc, deps.threads.busy()));
    // A row that shows what it did keeps its object, so <For> keeps its element, and the focus in it: a turn's opened
    // or closed by its button stays focused.
    let kept = new Map<string, Row>();
    // Group rows open each turn, in time order only; a sorted table is flat, as in DevTools.
    const rows = createMemo(() => {
      const out: Row[] = [];
      const next = new Map<string, Row>();
      const keep = (key: string, row: Row) => {
        const before = kept.get(key);
        const same = before !== undefined && (Object.keys(row) as (keyof Row)[]).every((field) => before[field] === row[field]) ? before : row;
        next.set(key, same);
        out.push(same);
      };
      const grouped = groupTurns() && sort().key === "time";
      const indexOf = new Map(props.records.map((record, index) => [record.id, index]));
      let turn: LedgerRecord["turn"] | undefined;
      for (const record of sorted()) {
        if (grouped && record.turn !== turn) {
          turn = record.turn;
          keep(`turn:${turn.turnId}`, { type: "turn", turn, count: sorted().filter((candidate) => candidate.turn === turn).length });
        }
        if (grouped && collapsed().has(record.turn.turnId)) continue;
        keep(record.id, { type: "record", record, index: indexOf.get(record.id)! });
      }
      kept = next;
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
    // Its cells are drawn by these columns, so a column left out takes its cells with it and the rest line up.
    // How many widths it is under: its columns, and so its cells, change only when this does, not with every pixel.
    const level = createMemo(() => NARROW.filter((step) => props.width < step.below).length);
    const dropped = () => NARROW.slice(0, level()).flatMap((step) => step.drops);
    const columns = createMemo(() => (props.compact ? COLUMNS.slice(0, 1) : COLUMNS.filter((column) => !dropped().includes(column.key))));
    let wfHeader: HTMLTableCellElement | undefined;

    return (
      <table class="trj-table dt-table" classList={{ compact: props.compact }} role="grid" aria-label="Trajectory records" tabindex="0">
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
                  aria-sort={column.sortable ? (sort().key === column.key ? (sort().desc ? "descending" : "ascending") : "none") : undefined}
                  onWheel={(event) => {
                    if (column.key === "waterfall" && wfHeader !== undefined) wheelZoom(event, wfHeader.getBoundingClientRect());
                  }}
                >
                  {/* A button sorts, so the keyboard reaches it as the mouse does. */}
                  <Show when={column.sortable} fallback={column.label}>
                    <button type="button" class="trj-sort-button" onClick={() => sortBy(column.key as SortKey)}>
                      {column.label}
                      <Show when={sort().key === column.key}>
                        <span class="trj-sort" aria-hidden="true">
                          {sort().desc ? "▼" : "▲"}
                        </span>
                      </Show>
                    </button>
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
                    const prompt = () => (turn().prompt === undefined ? "" : firstLine(contentText(turn().prompt!.content)));
                    const toggle = () =>
                      setCollapsed((set) => {
                        const next = new Set(set);
                        if (!next.delete(turn().turnId)) next.add(turn().turnId);
                        return next;
                      });
                    // A button fills the row, so the keyboard opens and closes the turn as the mouse does, and says which it is.
                    return (
                      <tr class="trj-group" data-turn={turn().turnId}>
                        <td colSpan={columns().length}>
                          <button type="button" class="trj-group-row" aria-expanded={open()} onClick={toggle}>
                            <span class="trj-caret" data-open={open()} aria-hidden="true">
                              ▶
                            </span>
                            <span class="trj-group-label">Turn {turn().index}</span>
                            <span class="trj-group-prompt" data-tip={prompt() === "" ? undefined : tipOf(prompt())}>
                              {prompt()}
                            </span>
                            <span class="trj-group-meta">
                              {group().count} records · {turn().steps.length} requests
                              {turn().endedAt === undefined ? " · running" : ` · ${formatDuration(turn().endedAt! - turn().startedAt)}`}
                              {turn().end !== undefined && turn().end!.reason !== "done" ? ` · ${turn().end!.reason}` : ""}
                            </span>
                          </button>
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
                    const cell = (key: ColumnKey): JSX.Element => {
                      switch (key) {
                        case "name":
                          return (
                            <td class="trj-c-name">
                              <NameCell record={r} />
                            </td>
                          );
                        case "status":
                          return (
                            <td class="trj-c-status" classList={{ "trj-error": recordFailed(r) }}>
                              {statusOf(r)}
                            </td>
                          );
                        case "type":
                          return <td class="trj-c-type">{RECORD_KIND_LABEL[r.kind]}</td>;
                        case "initiator":
                          return (
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
                          );
                        case "tokens":
                          return (
                            <td
                              class="trj-c-tok dt-num"
                              data-tip={
                                usage === undefined
                                  ? undefined
                                  : `${usage.cacheRead.toLocaleString()} cached · ${(usage.input + usage.cacheWrite).toLocaleString()} new · ${usage.output.toLocaleString()} out`
                              }
                            >
                              {usage === undefined ? "" : `${formatTokens(inputTokens(usage))} / ${formatTokens(usage.output)}`}
                            </td>
                          );
                        case "duration":
                          return (
                            <td class="trj-c-time dt-num">
                              {duration === undefined ? (r.kind === "assistant" || r.kind === "tool" ? "(pending)" : "") : formatDuration(duration)}
                            </td>
                          );
                        case "waterfall":
                          return (
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
                          );
                        case "time":
                          return undefined;
                      }
                    };
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
                        aria-selected={selectedId() === r.id}
                        data-dim={!inRange(r)}
                        onClick={() => select({ type: "record", id: r.id })}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          select({ type: "record", id: r.id });
                          // From the keyboard (the menu key, Shift+F10) the point may be anywhere: then it opens under the row.
                          const box = event.currentTarget.getBoundingClientRect();
                          const inside = event.clientY >= box.top && event.clientY <= box.bottom;
                          setMenu({ x: inside ? event.clientX : box.left + 24, y: inside ? event.clientY : box.bottom, record: r });
                        }}
                      >
                        <For each={columns()}>{(column) => cell(column.key)}</For>
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

  /** A menu item, in its group: separators part the groups (inspect, copy, filter, branch, then what plugins add). */
  interface MenuItem {
    readonly label: string;
    readonly group: "inspect" | "copy" | "filter" | "branch" | "added";
    readonly run: () => void;
  }

  const menuItems = (record: LedgerRecord): MenuItem[] => {
    const request = recordRequest(record);
    const out: MenuItem[] = [];
    if (request !== undefined) out.push({ label: "Inspect request", group: "inspect", run: () => select({ type: "request", eventId: request.eventId }) });
    if (request !== undefined)
      out.push({
        label: "Copy exact request",
        group: "copy",
        run: () => {
          const rebuilt = rebuildRequest(deps.threads.branch(), request.eventId);
          if (rebuilt !== undefined) void copy(json(rebuilt));
        },
      });
    if (record.kind === "tool") {
      out.push({ label: "Copy payload", group: "copy", run: () => void copy(json(record.run.call.arguments)) });
      if (record.run.result !== undefined) out.push({ label: "Copy result", group: "copy", run: () => void copy(contentText(record.run.result!.content)) });
    }
    if (record.kind === "assistant" || record.kind === "user")
      out.push({ label: "Copy text", group: "copy", run: () => void copy(contentText(record.message.content)) });
    out.push({
      label: "Copy as JSON",
      group: "copy",
      run: () => void copy(json(record.kind === "tool" ? record.run : record.kind === "system" ? record.request : record.message)),
    });
    if (record.kind === "tool")
      out.push({ label: `Filter: tool:${record.run.call.name}`, group: "filter", run: () => setQuery(`tool:${record.run.call.name}`) });
    out.push({ label: `Filter: turn:${record.turn.index}`, group: "filter", run: () => setQuery(`turn:${record.turn.index}`) });
    // Records of model calls and tool runs are log events; the next prompt can continue from one of them.
    if (record.kind === "assistant" || record.kind === "tool") {
      out.push({
        label: "Branch from here",
        group: "branch",
        run: () =>
          void deps.threads.checkout(record.id).then((moved) => {
            if (moved) deps.notify.toast({ level: "info", message: "The next prompt continues from the chosen event, on a new branch." });
          }),
      });
    }
    // Then what plugins add.
    for (const action of deps.slots.list(TrajectoryActions)) {
      if (action.when?.(record) ?? true) out.push({ label: action.label, group: "added", run: () => action.run(record) });
    }
    return out;
  };

  /**
   * The menu open on a record: its first item takes the focus, ↑ and ↓ (Home, End) move it, and Escape or Tab closes
   * it, the focus going back to the record's row; its keys stay its own, so the table behind it keeps its selection.
   */
  function Menu(props: { at: { x: number; y: number; record: LedgerRecord } }) {
    let element!: HTMLDivElement;
    let table: HTMLElement | null = null;
    const items = menuItems(props.at.record);
    const buttons = () => [...element.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const close = () => {
      setMenu(undefined);
      const row = rowElements.get(props.at.record.id);
      (row?.isConnected ? row : table)?.focus({ preventScroll: true });
    };
    onMount(() => {
      table = element.closest<HTMLElement>(".trj");
      // Kept on the screen, however many items it has.
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(4, Math.min(props.at.x, window.innerWidth - box.width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(props.at.y, window.innerHeight - box.height - 4))}px`;
      buttons()[0]?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const all = buttons();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : stepFor(event.key, at, all.length);
      if (next !== undefined) all[next]?.focus();
      else if (event.key === "Escape" || event.key === "Tab") close();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    return (
      <div
        ref={element}
        class="trj-menu"
        role="menu"
        aria-label="Record actions"
        style={{ left: `${props.at.x}px`, top: `${props.at.y}px` }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <For each={items}>
          {(item, index) => (
            <>
              <Show when={index() > 0 && items[index() - 1]!.group !== item.group}>
                <div class="menu-sep" role="separator" />
              </Show>
              <button
                role="menuitem"
                class="trj-menu-item"
                tabindex="-1"
                onPointerEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
                onClick={() => {
                  item.run();
                  close();
                }}
              >
                {item.label}
              </button>
            </>
          )}
        </For>
      </div>
    );
  }

  function ContextMenu() {
    const plugin = usePlugin();
    onMount(() => {
      const close = () => setMenu(undefined);
      onCleanup(plugin.listen(window, "pointerdown", close));
      onCleanup(plugin.listen(window, "blur", close));
    });
    return (
      <Show when={menu()} keyed>
        {(at) => <Menu at={at} />}
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
