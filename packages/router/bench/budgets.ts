import { writeReport } from "../../core/bench/report.ts";
import type { Measurement, Unit } from "../../core/bench/report.ts";

// Engineering guardrails, not application SLAs. Values are microseconds per
// operation unless named otherwise; reference and headroom are recorded beside
// each group. Timing budgets fail only when asked to (LEMMA_PERF_ENFORCE=1, on
// an idle, comparable machine); size budgets are the same everywhere and always fail.
//
// Reference: Linux x64, Ryzen 9 9950X, Node 24.20.0, Effect 4.0.1, 2026-10-06. Roughly 50% headroom for host noise.
//
// Before tuning: resolve 0.72/1.45/7.3 at 10/100/1000 routes (every route tried), set entries 57/4982 (conflict
// detection compared every pair of routes), navigate 6.7 (a new DOMException per abort, the journal copied per event),
// a 314KB / 97KB gzip bundle (Effect's Schema representation, for comparing Schemas). After: resolve 0.74/0.76/0.76
// (routes indexed by their first literal), set entries 42/405 (routes compared within their shape), navigate 2.6, a
// 273KB / 85KB bundle (a fingerprint from the Schema AST).
export const budgets: Record<string, number> = {
  "Resolve / 10 routes": 1.1,
  "Resolve / 100 routes": 1.2,
  "Resolve / 1000 routes": 1.2,
  "Compile / 100 routes": 18,
  "Compile / 1000 routes": 135,
  "Set entries / 100 routes": 65,
  "Set entries / 1000 routes": 650,
  "Navigate / 100 routes": 4,
  "Explain / 100 routes": 12,
  "Href / Schema params and search": 1.4,
  // Navigators over one table: create and destroy 2.7, set entries with 100 navigators 128 (one compile, then each
  // navigator matches its own location again), 4.0KB of heap each, all of it released on destroy.
  "Navigator create + destroy / 100 routes": 6,
  "Set entries / 100 routes, 100 navigators": 200,
  "Navigator heap bytes": 6000,
  // The packed browser consumer bundled and minified by esbuild, Effect included: 273KB / 85KB gzip. About 10% for
  // dependency and bundler variation.
  browserBundleBytes: 300_000,
  browserBundleGzipBytes: 94_000,
};

const measurements: Record<string, Measurement> = {};
export const enforced = process.env.LEMMA_PERF_ENFORCE === "1";
const deterministic = new Set<string>(["browserBundleBytes", "browserBundleGzipBytes"]);

/** A measurement, with the samples it summarizes when there are several. */
export function record(name: string, value: number, unit: Unit, values?: readonly number[]) {
  const limit = budgets[name];
  if (!Number.isFinite(value)) throw new Error(`Invalid measurement: ${name}`);
  const fails = enforced || deterministic.has(name);
  measurements[name] = {
    value,
    unit,
    ...(values === undefined ? {} : { values }),
    ...(limit === undefined ? {} : { limit, passed: value <= limit, enforced: fails }),
  };
  if (limit !== undefined && value > limit) {
    console.warn(`${fails ? "FAIL" : "ADVISORY"}: ${name} ${value.toFixed(3)} > ${limit}`);
    if (fails) process.exitCode = 1;
  }
}

/** Reports what was recorded, as `router-<name>`: see `writeReport`. */
export function finish(name: string, parameters?: Readonly<Record<string, unknown>>) {
  return writeReport(`router-${name}`, measurements, enforced, parameters);
}
