import { writeReport } from "./report.ts";
import type { Measurement, Unit } from "./report.ts";

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
  // As the host traces (2026-10-11, same machine): a collector keeps each span as data, 89us against 65 for Effect's
  // native spans; hearing each handler's step (`onStep`, which the agent asks for once per request) adds about 30.
  "Hook / 32 handlers / spans collected, steps heard": 180,
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
  // The harness (packages/sim/bench/harness.ts, 2026-10-12, same machine): a session's step, in simulated time on a
  // file system in memory, compacting as its context fills, against its estimate (packages/sim/README.md#the-harness-
  // benchmark). Counts per step are the same on every machine and always fail; timings are advisory. What it
  // measured: the README's "What it measures".
  "Harness / 100 entries / events read per step": 0,
  "Harness / 1000 entries / events read per step": 0,
  "Harness / 10000 entries / events read per step": 0,
  "Harness / 100 entries / syncs per step": 8,
  "Harness / 1000 entries / syncs per step": 8,
  "Harness / 10000 entries / syncs per step": 8,
  "Harness / 100 entries / bytes written per step": 2_600,
  "Harness / 1000 entries / bytes written per step": 2_600,
  "Harness / 10000 entries / bytes written per step": 2_600,
  "Harness / 100 entries / hooks run per step": 3,
  "Harness / 1000 entries / hooks run per step": 3,
  "Harness / 10000 entries / hooks run per step": 3,
  "Harness / 100 entries / events published per step": 23,
  "Harness / 1000 entries / events published per step": 23,
  "Harness / 10000 entries / events published per step": 23,
  // A measured turn is a tool step and an answer step: its maxima, twice a step's, keep one costly turn from hiding in
  // the average.
  "Harness / 100 entries / max syncs per turn": 16,
  "Harness / 1000 entries / max syncs per turn": 16,
  "Harness / 10000 entries / max syncs per turn": 16,
  "Harness / 100 entries / max bytes per turn": 5200,
  "Harness / 1000 entries / max bytes per turn": 5200,
  "Harness / 10000 entries / max bytes per turn": 5200,
  "Harness / 100 entries / max hooks per turn": 6,
  "Harness / 1000 entries / max hooks per turn": 6,
  "Harness / 10000 entries / max hooks per turn": 6,
  "Harness / 100 entries / max events per turn": 46,
  "Harness / 1000 entries / max events per turn": 46,
  "Harness / 10000 entries / max events per turn": 46,
  "Harness / 100 entries / ms per step": 3,
  "Harness / 10000 entries / ms per step": 3,
  "Harness / 10000 entries / heap MB": 64,
  "Harness / step time 10k vs 1k entries": 1.5,
  // The session store's long session (domains/sessions/files/bench/store.ts, 2026-10-21, same machine): 10,018 events,
  // 22.5 MB. A host holds 2,220 bytes an event (0.99x the file; 2,520 before requests shared their contributions, and
  // holding each line's text as well would be about twice that). Search with no match 25 ms and a listing without the
  // index 14 ms, reading events from their heads (75 and 42 ms parsing every line); trajectory 12-14 ms (about 50 ms
  // when every request's tool specs were stringified). Advisory, as timings and the heap are.
  sessionHeapPerEventBytes: 2_700,
  sessionSearchMissMs: 50,
  sessionListUnindexedMs: 30,
  sessionTrajectoryMs: 30,
} as const;

const measurements: Record<string, Measurement> = {};
/** Timings vary with the machine, so their budgets fail only when asked to (on an idle, comparable machine). */
export const enforced = process.env.LEMMA_PERF_ENFORCE === "1";
/** Sizes, and counts of what a simulated run does, are the same on every machine, so their budgets always fail. */
const deterministic = new Set<string>([
  "browserBundleBytes",
  "browserBundleGzipBytes",
  // The harness's counts, not its timings (ms, the heap, and how a step's time grows).
  ...Object.keys(budgets).filter((name) => name.startsWith("Harness / ") && !/ ms per step$| heap MB$|^Harness \/ step time /.test(name)),
]);

function check(name: string, measurement: Measurement, exceeds: (limit: number) => boolean) {
  if (!Number.isFinite(measurement.value)) throw new Error(`Invalid measurement: ${name}`);
  const limit = budgets[name as keyof typeof budgets];
  if (limit === undefined) {
    measurements[name] = measurement;
    return;
  }
  const passed = !exceeds(limit);
  const fails = enforced || deterministic.has(name);
  measurements[name] = { ...measurement, limit, passed, enforced: fails };
  if (!passed) {
    console.warn(`${fails ? "FAIL" : "ADVISORY"}: ${name} ${measurement.value.toFixed(3)} > ${limit}`);
    if (fails) process.exitCode = 1;
  }
}

/** A measurement, with the samples it summarizes when there are several. */
export function record(name: string, value: number, unit: Unit, values?: readonly number[]) {
  check(name, { value, unit, ...(values === undefined ? {} : { values }) }, (limit) => value > limit);
}

/**
 * A budgeted average count: its exact `total` over `samples` is compared with the limit, so one extra sync in twenty
 * steps fails a budget its rounded average would meet.
 */
export function recordAverage(name: string, total: number, samples: number, unit: Unit) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Invalid total: ${name}`);
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error(`Invalid samples: ${name}`);
  if (budgets[name as keyof typeof budgets] === undefined) throw new Error(`Missing budget: ${name}`);
  check(name, { value: total / samples, unit, total, samples }, (limit) => total > limit * samples);
}

/** Reports what was recorded: see `writeReport`. */
export function finish(name: string, parameters?: Readonly<Record<string, unknown>>) {
  return writeReport(name, measurements, enforced, parameters);
}
