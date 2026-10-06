import { recordFailed } from "@lemma/contracts";
import type { LedgerRecord, LedgerSpan } from "@lemma/contracts";

/*
 * The Trajectory's timeline: an axis of fractions (0 to 1) over the session's
 * active time, the slice of it in view, and the ruler over that slice.
 */

/** The fraction of the axis the idle time between two turns collapses to. */
export const GAP = 0.012;

/**
 * Maps times to fractions of the full axis: actual time within each turn,
 * with the idle time between turns (the user reading, typing, or away)
 * collapsed to `GAP` so one long pause does not squash every turn. A span
 * still running ends at `now`.
 */
export function timeScale(spans: readonly LedgerSpan[], now: number) {
  const byTurn = new Map<string, { from: number; to: number }>();
  for (const span of spans) {
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
  return {
    fraction,
    timeAt,
    /** Where one turn ends and the next begins: the middle of each gap. */
    boundaries: segments.slice(1).map((segment) => fraction(segment.from) - GAP / 2),
    /** Milliseconds of active time per unit of fraction, for the ruler. */
    msPerFraction: total / usable,
    empty: segments.length === 0,
  };
}
export type Scale = ReturnType<typeof timeScale>;

/** The slice of the axis in view. */
export interface Zoom {
  readonly start: number;
  readonly end: number;
}

/** Where fraction `f` falls in a box `width` wide showing `zoom`. */
export const place = (f: number, zoom: Zoom, width: number): number => ((f - zoom.start) / (zoom.end - zoom.start)) * width;

/** `zoom` moved by `by` of its own width, kept on the axis. */
export const panned = (zoom: Zoom, by: number): Zoom => {
  const span = zoom.end - zoom.start;
  const start = Math.min(Math.max(0, zoom.start + by * span), 1 - span);
  return { start, end: start + span };
};

/**
 * `zoom` after a wheel over a box `width` wide, at `x` px from its left: a
 * horizontal wheel pans, a vertical one zooms around the pointer, down to
 * 0.2% of the axis.
 */
export const wheeled = (zoom: Zoom, wheel: { readonly deltaX: number; readonly deltaY: number }, x: number, width: number): Zoom => {
  if (Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)) return panned(zoom, wheel.deltaX / width);
  const span = zoom.end - zoom.start;
  const anchor = zoom.start + (x / width) * span;
  const next = Math.min(1, Math.max(0.002, span * Math.exp(wheel.deltaY * 0.0015)));
  const start = Math.min(Math.max(0, anchor - ((anchor - zoom.start) / span) * next), 1 - next);
  return { start, end: start + next };
};

const TICK_STEPS = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** The ruler's ticks across `zoom`: the fraction of each, and the active time it marks, about every 90px of `width`. */
export const ticks = (zoom: Zoom, msPerFraction: number, width: number): { readonly at: number; readonly ms: number }[] => {
  const visibleMs = (zoom.end - zoom.start) * msPerFraction;
  const raw = visibleMs / Math.max(1, width / 90);
  const step = (TICK_STEPS.find((candidate) => candidate >= raw) ?? 600_000) / msPerFraction;
  const out: { at: number; ms: number }[] = [];
  for (let f = Math.ceil(zoom.start / step) * step; f <= zoom.end; f += step) out.push({ at: f, ms: f * msPerFraction });
  return out;
};

/** How far into a finished model call its first token came, in percent; undefined without both. */
export const ttftPercent = (span: LedgerSpan): number | undefined =>
  span.ttft === undefined || span.end === undefined || span.end <= span.start ? undefined : Math.min(100, (span.ttft / (span.end - span.start)) * 100);

/** Input counts cache reads and writes, as providers bill them. */
export const inputTokens = (usage: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number }): number =>
  usage.input + usage.cacheRead + usage.cacheWrite;

/** What `records` add up to: model requests, tool calls, failures, tokens, cost, and the active time of their turns (running ones up to `now`). */
export const ledgerStats = (records: readonly LedgerRecord[], now: number) => {
  let requests = 0;
  let tools = 0;
  let errors = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const record of records) {
    if (record.kind === "assistant") {
      requests++;
      input += inputTokens(record.message.usage);
      output += record.message.usage.output;
      cost += record.message.usage.cost.total;
    }
    if (record.kind === "tool") tools++;
    if (recordFailed(record)) errors++;
  }
  const active = [...new Set(records.map((record) => record.turn))].reduce((sum, turn) => sum + ((turn.endedAt ?? now) - turn.startedAt), 0);
  return { requests, tools, errors, input, output, cost, active };
};
