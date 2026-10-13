import { describe, expect, it, onTestFailed } from "vitest";
import { ACTIONS, digestOf, World } from "../src/index.ts";
import { saveWorldFailure } from "../src/artifacts.ts";

/*
 * The harness under a workload and faults drawn from each seed (`World`): a safety phase with the faults on, a liveness
 * phase with them off, then the checker's audit of the log it left. `pnpm test` runs 100 seeds; the nightly job runs
 * many more (`LEMMA_HARNESS_RUNS`). A failure prints the seed and the command that replays it.
 *
 * Across the seeds, every kind of action, fault, and outcome must show up at least once: a kind that never does is a
 * part of the space no run reaches, which a generator can lose without anyone noticing (TigerBeetle's "Fuzzer Blind
 * Spots").
 */

const runs = Number(process.env.LEMMA_HARNESS_RUNS ?? 100);
const first = Number(process.env.LEMMA_HARNESS_SEED ?? 1);
const ticks = Number(process.env.LEMMA_HARNESS_TICKS ?? 120);

/**
 * What the seeds together must reach: below 100 seeds (a run cut short to debug one), it is not asked. The rarest
 * kinds happen in about a tenth of runs, so any 100 seeds reach each of them but for about one window in a thousand.
 */
const REACHED = [
  ...ACTIONS.map((action) => `action ${action}`),
  ...["reply", "tools", "transient", "rateLimit", "fatal", "overflow", "stall", "cut", "malformed", "bigUsage", "summary", "summary failed"].map(
    (kind) => `model ${kind}`,
  ),
  "tool fail",
  "tool slow",
  "tool output",
  ...["inputSlow", "inputFail", "inputAnswer", "requestSlow", "requestFail"].map((kind) => `hook ${kind}`),
  ...["write", "sync", "truncate", "rename", "open"].map((operation) => `disk ${operation}`),
  "crash",
  "crash mid-write",
  "crash while starting",
  "stop",
  // What actions did, not that they were drawn: a generator whose calls all fail would otherwise go on looking busy.
  "retried",
  "checked out",
  ...["agent.loop", "sessions.files", "tools.registry"].map((id) => `restarted ${id}`),
  ...["placed", "handled", "refused", "unknown", "failed Busy", "failed Retracted"].map((outcome) => `prompt ${outcome}`),
  ...["done", "error", "cancelled", "max-steps"].map((reason) => `turn ${reason}`),
  "appended compaction",
  "queue changed",
  "withdrawn",
];

describe("the harness simulation", () => {
  it(
    `keeps every invariant for seeds ${first} to ${first + runs - 1}, and reaches every kind of action, fault, and outcome`,
    { timeout: Math.max(60_000, runs * 5_000) },
    async () => {
      const reached = new Map<string, number>();
      let current = first;
      // Names the seed even when it never finishes, which the error below cannot.
      onTestFailed(() => console.error(`harness seed ${current}: pnpm --filter @lemma/sim sim --seed ${current} --ticks ${ticks} --dump`));
      for (let seed = first; seed < first + runs; seed++) {
        current = seed;
        const world = new World({ seed, ticks });
        try {
          await world.run();
        } catch (error) {
          saveWorldFailure(world, ticks, error);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${world.describe()}\nreplay: pnpm --filter @lemma/sim sim --seed ${seed} --ticks ${ticks} --dump`,
            { cause: error },
          );
        }
        for (const [what, count] of world.coverage()) reached.set(what, (reached.get(what) ?? 0) + count);
      }
      if (runs >= 100) expect(REACHED.filter((what) => (reached.get(what) ?? 0) === 0)).toEqual([]);
    },
  );

  it("is a seed's: run twice, it leaves the same disk and model calls", async () => {
    const once = new World({ seed: 7, ticks: 60 });
    const again = new World({ seed: 7, ticks: 60 });
    await once.run();
    await again.run();
    expect(digestOf(again.disk)).toBe(digestOf(once.disk));
    expect(again.calls.length).toBe(once.calls.length);
  });
});
