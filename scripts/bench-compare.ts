// Compares the core microbenchmarks of a base revision with the working tree. Like Go's benchstat
// and Node's benchmark/compare.js, it alternates runs of the two builds on the same machine and
// reports a change only when a Mann-Whitney U test finds it significant (Bonferroni-corrected
// across the benchmarks) and it is larger than the threshold. Absolute numbers from shared CI
// runners mean little; the difference between two builds measured side by side does.
//
//   node scripts/bench-compare.ts [--base <ref>] [--runs <n>] [--threshold <fraction>] [--fail]
//
// The base defaults to the merge base with origin/main. Each run takes about 25 s at the default
// iteration count; LEMMA_BENCH_ITERATIONS and LEMMA_BENCH_SAMPLES pass through.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mannWhitney, median } from "../packages/core/bench/stats.ts";

const { values: options } = parseArgs({
  options: {
    base: { type: "string" },
    runs: { type: "string", default: "10" },
    threshold: { type: "string", default: "0.1" },
    fail: { type: "boolean", default: false },
  },
});
const runs = Number(options.runs);
const threshold = Number(options.threshold);
if (!Number.isInteger(runs) || runs < 2) throw new Error("--runs must be an integer of at least 2");
if (!(threshold >= 0)) throw new Error("--threshold must be a non-negative fraction");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const base = options.base ?? mergeBase();
const baseSha = git("rev-parse", "--short", base);
const work = mkdtempSync(join(tmpdir(), "lemma-bench-compare-"));
const baseRoot = join(work, "base");
const bench = "packages/core/bench/core.ts";

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

/** One benchmark run of the checkout at `cwd`: each benchmark's batch-mean median, in µs per operation. */
function measure(cwd: string, index: number, side: string): Map<string, number> {
  const output = join(work, `${side}-${index}`);
  run(process.execPath, [bench], cwd, { ...process.env, LEMMA_BENCH_OUTPUT_DIR: output, LEMMA_PERF_ENFORCE: "0" });
  const report = JSON.parse(readFileSync(join(output, "microbench.json"), "utf8")) as { measurements: Record<string, { value: number }> };
  return new Map(Object.entries(report.measurements).map(([name, { value }]) => [name, value]));
}

const samples = { base: new Map<string, number[]>(), head: new Map<string, number[]>() };
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
      for (const [name, value] of measure(side === "base" ? baseRoot : root, index, side)) {
        samples[side].set(name, [...(samples[side].get(name) ?? []), value]);
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

const names = [...samples.head.keys()].filter((name) => samples.base.has(name));
const alpha = 0.05 / Math.max(1, names.length);
let regressions = 0;
const rows = names.map((name) => {
  const before = samples.base.get(name)!;
  const after = samples.head.get(name)!;
  const change = median(after) / median(before) - 1;
  const p = mannWhitney(before, after);
  const significant = p < alpha && Math.abs(change) > threshold;
  if (significant && change > 0) regressions++;
  return [
    name,
    median(before).toFixed(3),
    median(after).toFixed(3),
    `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`,
    p.toFixed(4),
    significant ? (change > 0 ? "slower" : "faster") : "~",
  ];
});
const header = ["benchmark (µs/op)", `base ${baseSha}`, "head", "change", "p", ""];
const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
for (const row of [header, ...rows])
  console.log(row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  "));
console.log(
  `\n~: no change beyond ${(threshold * 100).toFixed(0)}% at p < ${alpha.toPrecision(2)} (0.05 Bonferroni-corrected over ${names.length} benchmarks).`,
);
if (options.fail && regressions > 0) process.exitCode = 1;
