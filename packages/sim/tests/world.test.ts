import { describe, expect, it } from "vitest";
import { digestOf, World } from "../src/index.ts";

/*
 * The harness under a workload and faults drawn from each seed (`World`): a safety phase with the faults on, a liveness
 * phase with them off, then the checker's audit of the log it left. `pnpm test` runs a few seeds; the nightly job
 * runs many more (`LEMMA_HARNESS_RUNS`). A failure prints the seed and the command that replays it.
 */

const runs = Number(process.env.LEMMA_HARNESS_RUNS ?? 16);
const first = Number(process.env.LEMMA_HARNESS_SEED ?? 1);
const ticks = Number(process.env.LEMMA_HARNESS_TICKS ?? 120);

describe("the harness simulation", () => {
  it(`keeps every invariant for seeds ${first} to ${first + runs - 1}`, { timeout: Math.max(60_000, runs * 5_000) }, async () => {
    for (let seed = first; seed < first + runs; seed++) {
      const world = new World({ seed, ticks });
      try {
        await world.run();
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${world.describe()}\nreplay: pnpm --filter @lemma/sim sim --seed ${seed} --ticks ${ticks} --dump`,
          { cause: error },
        );
      }
    }
  });

  it("is a seed's: run twice, it leaves the same disk and model calls", async () => {
    const once = new World({ seed: 7, ticks: 60 });
    const again = new World({ seed: 7, ticks: 60 });
    await once.run();
    await again.run();
    expect(digestOf(again.disk)).toBe(digestOf(once.disk));
    expect(again.calls.length).toBe(once.calls.length);
  });
});
