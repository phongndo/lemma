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
  return {
    tracer: spans.tracer,
    applied: (...args: Parameters<typeof history.applied>) => {
      history.applied(...args);
      setChanges(history.get());
    },
    refused: (...args: Parameters<typeof history.refused>) => {
      history.refused(...args);
      setChanges(history.get());
    },
    trace: { spans: spans.spans, subscribe: spans.subscribe, changes } satisfies PageTraceService,
  };
}
export type PageTraceRuntime = ReturnType<typeof createPageTrace>;
