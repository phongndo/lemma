import type { CompositionChange } from "@lemma/contracts";

/** What a change reported: a loader's `ReloadReport`, or as much of one as a restart says. */
interface Reported {
  readonly started?: readonly string[];
  readonly stopped?: readonly string[];
  readonly restarted?: readonly string[];
  readonly failed?: readonly string[];
}

/**
 * The composition's recent changes, newest first, the last `limit`: what each started, stopped, and restarted, or why it
 * was refused. The host and the web app each keep one, for their devtools' timelines.
 */
export function compositionHistory(limit = 50) {
  let changes: readonly CompositionChange[] = [];
  const add = (change: CompositionChange) => {
    changes = [change, ...changes].slice(0, limit);
  };
  return {
    applied: (cause: CompositionChange["cause"], report: Reported, subjects?: readonly string[], at: number = Date.now()): void =>
      add({
        at,
        cause,
        ...(subjects === undefined ? {} : { subjects }),
        started: report.started ?? [],
        stopped: report.stopped ?? [],
        restarted: report.restarted ?? [],
        failed: report.failed ?? [],
      }),
    refused: (cause: CompositionChange["cause"], why: string, subjects?: readonly string[], at: number = Date.now()): void =>
      add({ at, cause, ...(subjects === undefined ? {} : { subjects }), started: [], stopped: [], restarted: [], failed: [], refused: why }),
    get: (): readonly CompositionChange[] => changes,
  };
}
export type CompositionHistory = ReturnType<typeof compositionHistory>;
