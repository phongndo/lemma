import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { mannWhitney, median } from "../bench/stats.ts";

const script = (name: string) => fileURLToPath(new URL(`../bench/${name}`, import.meta.url));

// The benchmarks run here with tiny counts so they cannot rot unnoticed; `pnpm perf:check` measures them.
describe("benchmarks", () => {
  test("the microbenchmarks run and report every case", () => {
    const output = execFileSync(process.execPath, [script("core.ts")], {
      encoding: "utf8",
      env: { ...process.env, LEMMA_BENCH_ITERATIONS: "5", LEMMA_BENCH_SAMPLES: "1", LEMMA_PERF_ENFORCE: "0", LEMMA_BENCH_OUTPUT_DIR: "" },
    });
    const report = JSON.parse(output.trim().split("\n").at(-1)!) as { measurements: Record<string, { value: number }> };
    expect(Object.keys(report.measurements)).toEqual(expect.arrayContaining(["core.run entry", "Hook / 32 handlers / spans on", "Reload one of 32 plugins"]));
    for (const { value } of Object.values(report.measurements)) expect(Number.isFinite(value)).toBe(true);
  }, 60_000);

  test("the stress workload runs and keeps its resource assertions", () => {
    const output = execFileSync(process.execPath, ["--expose-gc", script("workload.ts")], {
      encoding: "utf8",
      env: { ...process.env, LEMMA_STRESS_CYCLES: "20", LEMMA_PERF_ENFORCE: "0", LEMMA_BENCH_OUTPUT_DIR: "" },
    });
    const report = JSON.parse(output.trim().split("\n").at(-1)!) as { measurements: Record<string, { value: number }> };
    expect(Object.keys(report.measurements)).toEqual(expect.arrayContaining(["coldStartupMs", "operationP99Us", "heapGrowthBytes"]));
  }, 60_000);
});

describe("benchmark statistics", () => {
  test("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  test("Mann-Whitney U: separated samples are significant, identical ones are not", () => {
    const low = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const high = low.map((value) => value + 100);
    // Complete separation of 10 against 10: U = 0, z = (50 - 0.5) / 13.229, p = 1.8e-4.
    expect(mannWhitney(low, high)).toBeCloseTo(1.8e-4, 5);
    expect(mannWhitney(high, low)).toBeCloseTo(mannWhitney(low, high), 12);
    expect(mannWhitney(low, low)).toBeGreaterThan(0.9);
    expect(mannWhitney([5, 5, 5], [5, 5, 5])).toBe(1);
  });
});
