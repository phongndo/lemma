import type { SpanRecord } from "@lemma/contracts";

/** An event of Chrome's trace event format: a span ("X", complete), or a process's name ("M", metadata). */
export type ChromeTraceEvent =
  | {
      readonly ph: "X";
      readonly name: string;
      readonly cat: string;
      readonly pid: number;
      readonly tid: number;
      /** Microseconds. */
      readonly ts: number;
      readonly dur: number;
      readonly args: Readonly<Record<string, string | number | boolean>>;
    }
  | { readonly ph: "M"; readonly name: "process_name"; readonly pid: number; readonly args: { readonly name: string } };

/** A span's end may pass its parent's by a rounding: by this much (ms), it still nests. */
const SLACK = 0.001;

/**
 * Spans as Chrome's trace event format, which Perfetto (ui.perfetto.dev) and `chrome://tracing` open. Each trace is a
 * process, named for its root span. Its spans are complete events on lanes (threads), each nesting in the one open
 * before it, as a viewer draws a lane: a span goes in its parent's lane when it fits, and spans that ran side by side
 * (a step's tool calls) get lanes of their own. A span's attributes are its args, with its status and its error.
 */
export const chromeTrace = (spans: readonly SpanRecord[]): { readonly traceEvents: readonly ChromeTraceEvent[]; readonly displayTimeUnit: "ms" } => {
  const traces = new Map<string, SpanRecord[]>();
  for (const span of spans) {
    const trace = traces.get(span.traceId);
    if (trace === undefined) traces.set(span.traceId, [span]);
    else trace.push(span);
  }
  const events: ChromeTraceEvent[] = [];
  // Outer spans first: by start, the longer of two that start together.
  const ordered = [...traces.values()].map((trace) => trace.sort((a, b) => a.start - b.start || b.ms - a.ms)).sort((a, b) => a[0]!.start - b[0]!.start);
  ordered.forEach((trace, index) => {
    const pid = index + 1;
    const ids = new Set(trace.map((span) => span.id));
    const root = trace.find((span) => span.parentId === undefined || !ids.has(span.parentId)) ?? trace[0]!;
    events.push({ ph: "M", name: "process_name", pid, args: { name: root.name } });
    // Each lane, the ends of the spans open in it, innermost last.
    const lanes: number[][] = [];
    const laneOf = new Map<string, number>();
    const fits = (lane: number[], span: SpanRecord) => {
      while (lane.length > 0 && lane.at(-1)! <= span.start + SLACK) lane.pop();
      return lane.length === 0 || lane.at(-1)! + SLACK >= span.start + span.ms;
    };
    for (const span of trace) {
      const parentLane = span.parentId === undefined ? undefined : laneOf.get(span.parentId);
      let lane = parentLane !== undefined && fits(lanes[parentLane]!, span) ? parentLane : lanes.findIndex((open) => fits(open, span));
      if (lane === -1) lane = lanes.push([]) - 1;
      lanes[lane]!.push(span.start + span.ms);
      laneOf.set(span.id, lane);
      events.push({
        ph: "X",
        name: span.name,
        cat: String(span.attributes["plugin.id"] ?? "lemma"),
        pid,
        tid: lane + 1,
        ts: Math.round(span.start * 1000),
        dur: Math.round(span.ms * 1000),
        args: { ...span.attributes, "span.id": span.id, status: span.status, ...(span.error === undefined ? {} : { error: span.error }) },
      });
    }
  });
  return { traceEvents: events, displayTimeUnit: "ms" };
};
