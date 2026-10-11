import { Cause, Exit, Option, Tracer } from "effect";

/** An ended span as plain data: what a collector keeps, and a client reads. */
export interface SpanRecord {
  readonly id: string;
  readonly parentId?: string;
  readonly traceId: string;
  readonly name: string;
  /** Epoch milliseconds it started at, fractional. */
  readonly start: number;
  readonly ms: number;
  readonly status: "ok" | "error" | "interrupted";
  /** What failed, in a line, when it did. */
  readonly error?: string;
  /**
   * Its attributes, plain values only: those set on it (`plugin.id`, `hook.name`), and those the work around it set
   * on every span inside (`Effect.annotateSpans`), as an application marks what the work is for.
   */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface SpanCollector {
  /** What to trace with: `Effect.withTracer(collector.tracer)` around the program. */
  readonly tracer: Tracer.Tracer;
  /** The spans kept, in the order they ended: the last `limit`. */
  readonly spans: () => readonly SpanRecord[];
  /** Hears the spans that end, a batch at a time. Returns the removal. */
  readonly subscribe: (listener: (spans: readonly SpanRecord[]) => void) => () => void;
}

/** How long a failure's line may be. */
const ERROR_CHARS = 300;

const plain = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const failure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const text = error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error);
  return text.split("\n", 1)[0]!.slice(0, ERROR_CHARS);
};

/**
 * Keeps the spans a program ends, in memory and bounded: the last `limit` (5000 unless given). Every span the kernel
 * makes (activation, a hook's handler, an observer, background work) and every span plugins make lands here, with its
 * attributes, so a devtools can show what ran, for whom, and how long it took. Nothing leaves the process unless a
 * reader sends it.
 */
export function makeSpanCollector(options?: { readonly limit?: number }): SpanCollector {
  const limit = Math.max(1, options?.limit ?? 5000);
  let kept: SpanRecord[] = [];
  const listeners = new Set<(spans: readonly SpanRecord[]) => void>();
  let pending: SpanRecord[] = [];
  const flush = () => {
    const batch = pending;
    pending = [];
    for (const listener of listeners) {
      try {
        listener(batch);
      } catch {
        // A reader that throws misses nothing it has not missed already; the others still hear.
      }
    }
  };
  const record = (span: Tracer.NativeSpan, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
    if (!span.sampled) return;
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of span.attributes) {
      if (plain(value)) attributes[key] = value;
      else if (typeof value === "bigint") attributes[key] = Number(value);
    }
    const parent = Option.getOrUndefined(span.parent);
    const ended: SpanRecord = {
      id: span.spanId,
      ...(parent === undefined ? {} : { parentId: parent.spanId }),
      traceId: span.traceId,
      name: span.name,
      start: Number(span.startTime) / 1e6,
      ms: Number(endTime - span.startTime) / 1e6,
      status: Exit.isSuccess(exit) ? "ok" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error",
      ...(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? { error: failure(exit.cause) } : {}),
      attributes,
    };
    kept.push(ended);
    // Trimmed a quarter at a time, so keeping one costs no copy.
    if (kept.length >= limit + Math.ceil(limit / 4)) kept = kept.slice(-limit);
    if (listeners.size === 0) return;
    if (pending.length === 0) queueMicrotask(flush);
    pending.push(ended);
  };
  class CollectedSpan extends Tracer.NativeSpan {
    override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
      super.end(endTime, exit);
      record(this, endTime, exit);
    }
  }
  return {
    tracer: Tracer.make({ span: (options) => new CollectedSpan(options) }),
    spans: () => (kept.length > limit ? kept.slice(-limit) : kept.slice()),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
