// Compares benchmarks of a base revision with the working tree: the core's microbenchmarks, and with
// `--harness`, the harness benchmark's step times (`… ms per step`, packages/sim/bench/harness.ts).
// Like Go's benchstat and Node's benchmark/compare.js, it alternates runs of the two builds on the same machine and
// reports a change only when a Mann-Whitney U test finds it significant (Bonferroni-corrected
// across the benchmarks) and it is larger than the threshold. Absolute numbers from shared CI
// runners mean little; the difference between two builds measured side by side does.
//
//   node scripts/bench-compare.ts [--base <ref>] [--runs <n>] [--threshold <fraction>] [--fail] [--harness] [--output <dir>]
//
// The base defaults to the merge base with origin/main. Each run takes about 25 s at the default
// iteration count; LEMMA_BENCH_ITERATIONS and LEMMA_BENCH_SAMPLES pass through. A benchmark the base does
// not have yet is run on the head alone and left out of the comparison, as is one whose unit changed. Every run's
// reports, and `comparison.json` with each benchmark's samples, are kept in `--output` (or LEMMA_BENCH_OUTPUT_DIR; a
// new temporary directory otherwise).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Unit } from "../packages/core/bench/report.ts";
import { compareSamples, median, medianInterval } from "../packages/core/bench/stats.ts";

const { values: options } = parseArgs({
  options: {
    base: { type: "string" },
    runs: { type: "string", default: "10" },
    threshold: { type: "string", default: "0.1" },
    fail: { type: "boolean", default: false },
    harness: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
const runs = Number(options.runs);
const threshold = Number(options.threshold);
// The rank test's normal approximation holds from about eight samples a side (stats.ts).
if (!Number.isInteger(runs) || runs < 8) throw new Error("--runs must be an integer of at least 8");
if (!(threshold >= 0)) throw new Error("--threshold must be a non-negative fraction");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const base = options.base ?? mergeBase();
const baseSha = git("rev-parse", "--short", base);
const work = mkdtempSync(join(tmpdir(), "lemma-bench-compare-"));
const baseRoot = join(work, "base");
const directory = options.output ?? process.env.LEMMA_BENCH_OUTPUT_DIR;
const output = directory === undefined ? mkdtempSync(join(tmpdir(), "lemma-bench-comparison-")) : resolve(directory);
mkdirSync(output, { recursive: true });
/** Each benchmark: its script, the flags node runs it with, and the report it writes (`finish(report)`). */
const benches = [
  { script: "packages/core/bench/core.ts", node: [], report: "microbench" },
  ...(options.harness ? [{ script: "packages/sim/bench/harness.ts", node: ["--expose-gc", "--conditions=lemma-source"], report: "harness" }] : []),
];
/** Timings are compared; what a run counts is the same on every machine, and has its own budgets. */
const compared: readonly Unit[] = ["us/op", "ms/step"];

function mergeBase(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", ref);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("No base: pass --base <ref>");
}

const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: ["ignore", "ignore", "inherit"] });

/** One run of every benchmark the checkout at `cwd` has: each measurement it reports, by name. */
function measure(cwd: string, index: number, side: string): Map<string, { value: number; unit?: Unit }> {
  const reports = join(output, side, String(index));
  const measured = new Map<string, { value: number; unit?: Unit }>();
  for (const bench of benches) {
    if (!existsSync(join(cwd, bench.script))) continue;
    run(process.execPath, [...bench.node, bench.script], cwd, { ...process.env, LEMMA_BENCH_OUTPUT_DIR: reports, LEMMA_PERF_ENFORCE: "0" });
    const report = JSON.parse(readFileSync(join(reports, `${bench.report}.json`), "utf8")) as {
      measurements: Record<string, { value: number; unit?: Unit }>;
    };
    for (const [name, measurement] of Object.entries(report.measurements)) measured.set(name, measurement);
  }
  return measured;
}

/** Each side's samples of each measurement, one a run, and its unit (none in a report from before units). */
const samples = { base: new Map<string, { unit?: Unit; values: number[] }>(), head: new Map<string, { unit?: Unit; values: number[] }>() };
try {
  console.error(`base ${baseSha} (${base}) vs the working tree, ${runs} alternating runs each`);
  git("worktree", "add", "--detach", baseRoot, base);
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], baseRoot);
  run("pnpm", ["build"], baseRoot);
  run("pnpm", ["build"], root);
  for (let index = 0; index < runs; index++) {
    // Alternate which side goes first so drift (thermal, background load) does not favor one.
    const order = index % 2 === 0 ? (["base", "head"] as const) : (["head", "base"] as const);
    for (const side of order) {
      for (const [name, { value, unit }] of measure(side === "base" ? baseRoot : root, index, side)) {
        const entry = samples[side].get(name) ?? { ...(unit === undefined ? {} : { unit }), values: [] };
        entry.values.push(value);
        samples[side].set(name, entry);
      }
    }
    console.error(`run ${index + 1}/${runs} done`);
  }
} finally {
  try {
    git("worktree", "remove", "--force", baseRoot);
  } catch {
    // Already gone, or never created.
  }
  rmSync(work, { recursive: true, force: true });
}

const names = [...samples.head].filter(([name, head]) => head.unit !== undefined && compared.includes(head.unit) && samples.base.has(name));
const changedUnit = names.filter(([name, head]) => ![undefined, head.unit].includes(samples.base.get(name)!.unit)).map(([name]) => name);
const comparable = names.filter(([name]) => !changedUnit.includes(name));
const alpha = 0.05 / Math.max(1, comparable.length);
const spread = (values: readonly number[]) => {
  const { low, high } = medianInterval(values);
  const middle = median(values);
  return low === undefined || high === undefined || middle === 0 ? "" : ` ±${((Math.max(middle - low, high - middle) / middle) * 100).toFixed(0)}%`;
};
const results = comparable.map(([name, head]) => {
  const before = samples.base.get(name)!.values;
  return { name, unit: head.unit, ...compareSamples(before, head.values, alpha, threshold), samples: { base: before, head: head.values } };
});
const rows = results.map((result) => [
  `${result.name} (${result.unit})`,
  result.base.toFixed(3) + spread(result.samples.base),
  result.head.toFixed(3) + spread(result.samples.head),
  `${result.change >= 0 ? "+" : ""}${(result.change * 100).toFixed(1)}%`,
  result.p.toFixed(4),
  result.verdict,
]);
const header = ["benchmark", `base ${baseSha}`, "head", "change", "p", ""];
const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
for (const row of [header, ...rows])
  console.log(row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  "));
console.log(
  `\n~: no change beyond ${(threshold * 100).toFixed(0)}% at p < ${alpha.toPrecision(2)} (0.05 Bonferroni-corrected over ${comparable.length} benchmarks);` +
    ` unclear: beyond it, but not significant. ±: the median's 95% interval.`,
);
if (changedUnit.length > 0) console.log(`Not compared, as their unit changed: ${changedUnit.join(", ")}.`);
writeFileSync(join(output, "comparison.json"), JSON.stringify({ base: baseSha, runs, threshold, alpha, results, changedUnit }, null, 2) + "\n");
console.error(`Reports and samples: ${output}`);
if (options.fail && results.some((result) => result.verdict === "slower")) process.exitCode = 1;
