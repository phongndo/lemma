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
  // The ids of the spans held, kept beside them, so a batch is checked against them without building a set each time.
  let ids = new Set<string>();
  const replace = (next: readonly SpanRecord[]) => {
    const held = next.slice(-KEPT);
    ids = new Set(held.map((span) => span.id));
    setSpans(held);
  };
  const append = (fresh: readonly SpanRecord[]) => {
    const held = [...spans(), ...fresh];
    for (const span of fresh) ids.add(span.id);
    for (const span of held.splice(0, Math.max(0, held.length - KEPT))) ids.delete(span.id);
    setSpans(held);
  };
  // What the follow brings while a refresh is on its way: the answer may have been read before those spans ended.
  const arriving = new Set<SpanRecord[]>();
  const refresh = async () => {
    const during: SpanRecord[] = [];
    arriving.add(during);
    try {
      const [kept, changed] = await Promise.all([source.spans(), source.changes()]);
      const answered = new Set(kept.map((span) => span.id));
      batch(() => {
        replace([...kept, ...during.filter((span) => !answered.has(span.id))]);
        setChanges(changed);
        setError(undefined);
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      arriving.delete(during);
    }
  };
  // Spans that end from now on; what ended before is read by `refresh`, so a span may arrive twice, and is kept once.
  onCleanup(
    source.follow((ended) => {
      for (const during of arriving) during.push(...ended);
      const fresh = ended.filter((span) => !ids.has(span.id));
      if (fresh.length > 0) append(fresh);
    }),
  );
  return { source, spans, changes, error, refresh };
}
export type TraceModel = ReturnType<typeof createTrace>;
