import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { budgets, recordAverage } from "../bench/budgets.ts";
import { compareSamples, mannWhitney, median, medianInterval } from "../bench/stats.ts";

const script = (name: string) => fileURLToPath(new URL(`../bench/${name}`, import.meta.url));

// The benchmarks run here with tiny counts so they cannot rot unnoticed; `pnpm perf:check` measures them.
describe("benchmarks", () => {
  test("the microbenchmarks run and report every case", () => {
    const output = execFileSync(process.execPath, [script("core.ts")], {
      encoding: "utf8",
      env: { ...process.env, LEMMA_BENCH_ITERATIONS: "5", LEMMA_BENCH_SAMPLES: "1", LEMMA_PERF_ENFORCE: "0", LEMMA_BENCH_OUTPUT_DIR: "" },
    });
    const report = JSON.parse(output.trim().split("\n").at(-1)!) as {
      parameters: Record<string, number>;
      measurements: Record<string, { value: number; unit: string; values: number[] }>;
    };
    expect(Object.keys(report.measurements)).toEqual(expect.arrayContaining(["core.run entry", "Hook / 32 handlers / spans on", "Reload one of 32 plugins"]));
    expect(report.parameters).toEqual({ samples: 1, iterations: 5 });
    for (const { value, unit, values } of Object.values(report.measurements)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(unit).toBe("us/op");
      expect(values).toEqual([value]);
    }
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

describe("benchmark budgets", () => {
  test("one extra read or sync fails an average budget, even when its rounded average would pass", () => {
    const exitCode = process.exitCode;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.exitCode = 0;
      recordAverage("Harness / 100 entries / syncs per step", 160, 20, "count/step");
      expect(process.exitCode).toBe(0);
      recordAverage("Harness / 100 entries / syncs per step", 161, 20, "count/step");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      recordAverage("Harness / 100 entries / events read per step", 1, 20, "count/step");
      expect(process.exitCode).toBe(1);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      process.exitCode = exitCode;
      warning.mockRestore();
    }
  });

  test("every measured harness count has a budget; missing budgets and invalid denominators fail", () => {
    for (const length of [100, 1_000, 10_000]) {
      for (const count of ["events read", "syncs", "bytes written", "hooks run", "events published"]) {
        const name = `Harness / ${length} entries / ${count} per step`;
        expect(budgets).toHaveProperty(name);
      }
    }
    expect(() => recordAverage("missing", 1, 20, "count/step")).toThrow("Missing budget");
    expect(() => recordAverage("Harness / 100 entries / syncs per step", 160, 0, "count/step")).toThrow("Invalid samples");
    expect(() => recordAverage("Harness / 100 entries / syncs per step", -1, 20, "count/step")).toThrow("Invalid total");
  });
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

  test("the median's interval: order statistics whose coverage is at least 95%", () => {
    const samples = Array.from({ length: 10 }, (_, index) => 100 + index);
    // Of ten samples, the 2nd and 9th smallest bound the median with 97.9% coverage; the 3rd and 8th with only 89%.
    expect(medianInterval(samples)).toEqual({ low: 101, high: 108 });
    expect(medianInterval([1, 2])).toEqual({});
    expect(() => medianInterval([])).toThrow();
  });

  test("a comparison names a change only when it is both significant and beyond the threshold", () => {
    const base = Array.from({ length: 10 }, (_, index) => 100 + index);
    expect(compareSamples(base, base, 0.05, 0.1).verdict).toBe("~");
    expect(
      compareSamples(
        base,
        base.map((value) => value * 2),
        0.05,
        0.1,
      ),
    ).toMatchObject({ verdict: "slower", change: expect.closeTo(1, 5) });
    expect(
      compareSamples(
        base,
        base.map((value) => value / 2),
        0.05,
        0.1,
      ).verdict,
    ).toBe("faster");
    // Twice as slow in the median, but the samples overlap too much for the test to say so.
    expect(compareSamples([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 9, 10, 11, 12, 13], 0.05, 0.1).verdict).toBe("unclear");
  });
});
