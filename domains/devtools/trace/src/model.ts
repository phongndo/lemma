import { batch, createSignal, onCleanup } from "solid-js";
import type { CompositionChange, SpanRecord } from "@lemma/contracts";
import { TraceChannels } from "@lemma/devtools";
import type { ClientService, PageTraceService } from "@lemma/web";

/** How many spans a view holds of each trace: the newest. */
export const KEPT = 5000;

/** Where a trace comes from: the host's (over its channels), or the page's own (`PageTrace`). */
export interface TraceSource {
  readonly name: "host" | "page";
  /** The spans kept now, in the order they ended. */
  readonly spans: () => Promise<readonly SpanRecord[]>;
  /** Hears the spans that end from now on. Returns the end. */
  readonly follow: (heard: (spans: readonly SpanRecord[]) => void) => () => void;
  readonly changes: () => Promise<readonly CompositionChange[]>;
}

export const hostTrace = (client: ClientService): TraceSource => ({
  name: "host",
  spans: () => client.channel.call(TraceChannels.spans, { limit: KEPT }),
  follow: (heard) => client.follow(TraceChannels.follow, {}, heard),
  changes: () => client.channel.call(TraceChannels.changes, undefined),
});

export const pageTrace = (trace: PageTraceService): TraceSource => ({
  name: "page",
  spans: async () => trace.spans(),
  follow: (heard) => trace.subscribe(heard),
  changes: async () => trace.changes(),
});

/**
 * A trace while a view shows it: the spans kept, then those that end, and the composition's changes. Made in a
 * component (its follow ends with it); `refresh` reads both again.
 */
export function createTrace(source: TraceSource) {
  const [spans, setSpans] = createSignal<readonly SpanRecord[]>([]);
  const [changes, setChanges] = createSignal<readonly CompositionChange[]>([]);
  const [error, setError] = createSignal<string>();
  const refresh = async () => {
    try {
      const [kept, changed] = await Promise.all([source.spans(), source.changes()]);
      batch(() => {
        setSpans(kept.slice(-KEPT));
        setChanges(changed);
        setError(undefined);
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  // Spans that end from now on; what ended before is read by `refresh`, so a span may arrive twice, and is kept once.
  onCleanup(
    source.follow((ended) => {
      const known = new Set(spans().map((span) => span.id));
      const fresh = ended.filter((span) => !known.has(span.id));
      if (fresh.length > 0) setSpans((held) => [...held, ...fresh].slice(-KEPT));
    }),
  );
  return { source, spans, changes, error, refresh };
}
export type TraceModel = ReturnType<typeof createTrace>;
