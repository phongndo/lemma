import { createSignal } from "solid-js";
import type { CompositionChange } from "@lemma/contracts";
import { compositionHistory } from "@lemma/composition";
import { makeSpanCollector } from "@lemma/core";
import type { PageTraceService } from "@lemma/web";

/**
 * The page's trace (`PageTrace`): a collector for the spans its web plugins' work ends, whose `tracer` the boot runs the
 * loader with, and its composition's changes, which the boot records as it applies them.
 */
export function createPageTrace() {
  const spans = makeSpanCollector();
  const history = compositionHistory();
  const [changes, setChanges] = createSignal<readonly CompositionChange[]>([]);
  const recording =
    <A extends readonly unknown[]>(record: (...args: A) => void) =>
    (...args: A) => {
      record(...args);
      setChanges(history.get());
    };
  return {
    tracer: spans.tracer,
    applied: recording(history.applied),
    refused: recording(history.refused),
    started: recording(history.started),
    trace: { spans: spans.spans, subscribe: spans.subscribe, changes } satisfies PageTraceService,
  };
}
export type PageTraceRuntime = ReturnType<typeof createPageTrace>;
