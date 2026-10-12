import type { CompositionChange } from "@lemma/contracts";

/** What a change reported: a loader's `ReloadReport`, or as much of one as a caller knows. */
interface Reported {
  readonly started?: readonly string[];
  readonly stopped?: readonly string[];
  readonly restarted?: readonly string[];
  readonly failed?: readonly string[];
}

/** A plugin as the core says it is (`CoreSnapshot.plugins`), as much as a start's record reads. */
interface Running {
  readonly id: string;
  readonly state: string;
  readonly haltedBy?: string | undefined;
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
  const applied = (cause: CompositionChange["cause"], report: Reported, subjects?: readonly string[], at: number = Date.now()): void =>
    add({
      at,
      cause,
      ...(subjects === undefined ? {} : { subjects }),
      started: report.started ?? [],
      stopped: report.stopped ?? [],
      restarted: report.restarted ?? [],
      failed: report.failed ?? [],
    });
  return {
    applied,
    /** The first start, from the core's plugins once it has started: those running, and those failed or halted by a failure. */
    started: (plugins: readonly Running[], at: number = Date.now()): void =>
      applied(
        "start",
        {
          started: plugins.filter((plugin) => plugin.state === "active").map((plugin) => plugin.id),
          failed: plugins.filter((plugin) => plugin.state === "failed" || plugin.haltedBy !== undefined).map((plugin) => plugin.id),
        },
        undefined,
        at,
      ),
    refused: (cause: CompositionChange["cause"], why: string, subjects?: readonly string[], at: number = Date.now()): void =>
      add({ at, cause, ...(subjects === undefined ? {} : { subjects }), started: [], stopped: [], restarted: [], failed: [], refused: why }),
    get: (): readonly CompositionChange[] => changes,
  };
}
export type CompositionHistory = ReturnType<typeof compositionHistory>;
