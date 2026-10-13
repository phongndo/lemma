import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The harness benchmark runs here on a short session so it cannot rot unnoticed (`pnpm harness:bench` runs it to
 * 10,000 entries). What it counts per step is the same on every machine: this test, run on Linux and macOS alike,
 * pins the counts, so a change that makes a step do more shows here, and is either fixed or its count moved on.
 */

const script = fileURLToPath(new URL("../bench/harness.ts", import.meta.url));

describe("the harness benchmark", () => {
  it("counts the same work per step on every machine", { timeout: 60_000 }, () => {
    const output = execFileSync(process.execPath, ["--conditions=lemma-source", script], {
      encoding: "utf8",
      env: { ...process.env, LEMMA_HARNESS_BENCH_ENTRIES: "300", LEMMA_PERF_ENFORCE: "0", LEMMA_BENCH_OUTPUT_DIR: "" },
    });
    const { measurements } = JSON.parse(output.trim().split("\n").at(-1)!) as {
      measurements: Record<string, { value: number; values?: number[]; total?: number; samples?: number; enforced?: boolean }>;
    };
    const at100 = (what: string) => measurements[`Harness / 100 entries / ${what}`];
    // Exact totals over the twenty measured steps, not their averages, which could round a change away.
    for (const [what, total] of [
      ["events read", 0],
      ["syncs", 160],
      ["bytes written", 47_697],
      ["hooks run", 60],
      ["events published", 450],
    ] as const) {
      expect(at100(`${what} per step`)).toMatchObject({ total, samples: 20, enforced: true });
    }
    expect(Number.isFinite(at100("ms per step")?.value)).toBe(true);
    // Ten measured turns, two steps each, five text deltas per step: growing the session adds no latency samples.
    expect(at100("delta to observer ms p50")?.values).toHaveLength(100);
    expect(at100("delta to observer ms p99")!.value).toBeGreaterThanOrEqual(at100("delta to observer ms p50")!.value);
  });
});
