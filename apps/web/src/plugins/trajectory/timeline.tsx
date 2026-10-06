import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { RECORD_KIND_LABEL, formatDuration, recordWithin } from "@lemma/contracts";
import type { AssistantRecord, LedgerRecord, LedgerSpan, ToolRecord } from "@lemma/contracts";
import { panned, place, ticks, ttftPercent } from "../../model/timeline.ts";
import type { Scale } from "../../model/timeline.ts";
import { clockTime } from "../../model/format.ts";
import type { View } from "./state.ts";

/** The overview: three lanes of spans over the session's active time, zoomed with the wheel and ranged by dragging. */
export function createTimeline(view: View) {
  const { selection, equalDurations, range, setRange, zoom, setZoom, select, wheelZoom, rowElements } = view;

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
    const x = (f: number) => place(f, zoom(), width());
    const timeAt = (clientX: number) => {
      const box = track.getBoundingClientRect();
      const f = zoom().start + ((clientX - box.left) / box.width) * (zoom().end - zoom().start);
      return props.scale.timeAt(f);
    };
    // Ruler: ticks every "nice" amount of active time across the visible slice.
    const rulerTicks = createMemo(() =>
      equalDurations() || props.scale.empty
        ? []
        : ticks(zoom(), props.scale.msPerFraction, width()).map((tick) => ({ left: x(tick.at), label: formatDuration(tick.ms) })),
    );

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
        setZoom(panned(panning, -(event.clientX - panning.x) / width()));
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
          <For each={rulerTicks()}>
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
              const ttft = () => ttftPercent(span);
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

  return { Overview };
}
