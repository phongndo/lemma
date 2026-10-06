import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

// Initial engineering guardrails, not application SLAs. Reference: Linux x64,
// Ryzen 9 9950X, Node 24.19.0, 2026-09-27. Warm baseline: core.run 9.679us,
// 32 traced handlers 259.812us, reload 150.342us, mount/dispose 2785us.
// Allow roughly 50% headroom for host noise and added lifecycle bookkeeping.
// New workload/bundle limits bound regression risk; they do not prove optimality.
export const budgets = {
  "Hook / 32 handlers / spans on": 320,
  "core.run entry": 15,
  "Mount + dispose / 32 plugins": 6000,
  "Reload one of 32 plugins": 400,
  coldStartupMs: 500,
  operationP95Us: 1000,
  operationP99Us: 2000,
  heapGrowthBytes: 16 * 1024 * 1024,
  rssGrowthBytes: 64 * 1024 * 1024,
  // Packed UI fixture including Effect and application code, bundled by esbuild:
  // 596KB / 185KB gzip. These caps allow about 10-15% dependency/bundler variation,
  // and fail CI when exceeded.
  browserBundleBytes: 660_000,
  browserBundleGzipBytes: 210_000,
  httpP99Ms: 25,
} as const;

const measurements: Record<string, { value: number; limit?: number; passed?: boolean }> = {};
/** Timings vary with the machine, so their budgets fail only when asked to (on an idle, comparable machine). */
export const enforced = process.env.LEMMA_PERF_ENFORCE === "1";
/** Sizes are the same on every machine, so their budgets always fail. */
const deterministic = new Set<string>(["browserBundleBytes", "browserBundleGzipBytes"]);

export function record(name: string, value: number) {
  const limit = budgets[name as keyof typeof budgets];
  if (!Number.isFinite(value)) throw new Error(`Invalid measurement: ${name}`);
  measurements[name] = { value, ...(limit === undefined ? {} : { limit, passed: value <= limit }) };
  if (limit !== undefined && value > limit) {
    const fails = enforced || deterministic.has(name);
    console.warn(`${fails ? "FAIL" : "ADVISORY"}: ${name} ${value.toFixed(3)} > ${limit}`);
    if (fails) process.exitCode = 1;
  }
}

export function finish(name: string) {
  const report = {
    measuredAt: new Date().toISOString(),
    runtime: `Node ${process.version}`,
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus()[0]?.model,
    enforced,
    measurements,
  };
  console.log(JSON.stringify(report));
  const directory = process.env.LEMMA_BENCH_OUTPUT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(report, null, 2) + "\n");
  }
}
