import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

// Engineering guardrails, not application SLAs. Reference: Linux x64, Ryzen 9
// 9950X, Node 24.20.0, Effect 4.0.1, 2026-10-05. Warm baseline: core.run
// 3.73us, 32 traced handlers 77.7us, reload 76.9us, mount/dispose 1308us
// (Effect 3.22 took 9.8, 286, 163, and 2828: scripts/bench-compare.ts).
// Allow roughly 50% headroom for host noise and added lifecycle bookkeeping.
// New workload/bundle limits bound regression risk; they do not prove optimality.
export const budgets = {
  // Dispatch tuned 2026-10-06 (same machine): a handler's own services are overlaid on its caller's context instead
  // of merged into a copy per call, and no span is made with tracing off. 32 handlers: 67.3 -> 18.3us spans off,
  // 74.1 -> 64.4 spans on (Effect's span machinery is the rest).
  "Hook / 32 handlers / spans on": 100,
  "Hook / 32 handlers / spans off": 28,
  // Handlers written with promises: passing through in place 26.6us against 18.5 for Effect handlers (1.4x). Async-local
  // storage is entered for every handler: entering it only for `async` ones (22.3us) lost the operation's context in
  // `.then` chains. A call through a promise-based view 0.46us against 0.16 for Effect.runPromise, its plugin's own
  // services overlaid on the caller's context.
  "Hook / 32 plain handlers, in place / spans off": 34,
  "Plain service call": 0.6,
  "core.run entry": 6,
  "Mount + dispose / 32 plugins": 2000,
  "Reload one of 32 plugins": 120,
  coldStartupMs: 500,
  operationP95Us: 1000,
  operationP99Us: 2000,
  heapGrowthBytes: 16 * 1024 * 1024,
  rssGrowthBytes: 64 * 1024 * 1024,
  // Packed UI fixture including Effect and application code, bundled by esbuild:
  // 435KB / 137KB gzip (596KB / 185KB on Effect 3). These caps allow about 10%
  // dependency/bundler variation, and fail CI when exceeded.
  browserBundleBytes: 480_000,
  browserBundleGzipBytes: 152_000,
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
