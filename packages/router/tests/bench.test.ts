import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { budgets } from "../bench/budgets.ts";

// The benchmarks run here with tiny counts so they cannot rot unnoticed; `pnpm router:bench` measures them.
describe("benchmarks", () => {
  test("the microbenchmarks run and report every budgeted case", () => {
    const output = execFileSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("../bench/router.ts", import.meta.url))], {
      encoding: "utf8",
      env: { ...process.env, LEMMA_BENCH_ITERATIONS: "5", LEMMA_BENCH_SAMPLES: "1", LEMMA_PERF_ENFORCE: "0", LEMMA_BENCH_OUTPUT_DIR: "" },
    });
    const report = JSON.parse(output.trim().split("\n").at(-1)!) as { measurements: Record<string, { value: number }> };
    const timed = Object.keys(budgets).filter((name) => !name.startsWith("browserBundle"));
    expect(Object.keys(report.measurements)).toEqual(expect.arrayContaining(timed));
    for (const { value } of Object.values(report.measurements)) expect(Number.isFinite(value)).toBe(true);
  }, 60_000);
});
