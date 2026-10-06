import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Runs one test file, or one package's tests, many times with several at
 * once, as Node's stress-single-test does: the way to show a flake, and then
 * that a fix holds, before calling it fixed.
 *
 *   pnpm stress apps/cli/tests/turns.test.ts --runs 30 --jobs 8
 *   pnpm stress plugins/agent --name "resumes a turn"
 *
 * Each run is `vitest run` in the target's package (`--name` is vitest's
 * `-t`; arguments after `--` go to vitest as they are). It prints each run as
 * it ends, then the output of every run that failed, and fails if any did.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const split = process.argv.indexOf("--", 2);
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, split === -1 ? undefined : split),
  allowPositionals: true,
  options: {
    runs: { type: "string", short: "n", default: "30" },
    jobs: { type: "string", short: "j", default: "4" },
    name: { type: "string", short: "t" },
  },
});
const passthrough = split === -1 ? [] : process.argv.slice(split + 1);
const runs = Number(values.runs);
const jobs = Number(values.jobs);
const usage = "usage: pnpm stress <test file or package directory> [--runs N] [--jobs J] [--name pattern] [-- vitest args]";
if (positionals.length !== 1 || !(Number.isInteger(runs) && runs > 0) || !(Number.isInteger(jobs) && jobs > 0)) {
  console.error(usage);
  process.exit(2);
}

// Paths are the repository's (pnpm runs root scripts there); INIT_CWD is where the command was typed.
const target = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]!);
let pkg = target;
while (pkg.startsWith(`${root}/`) && !existsSync(join(pkg, "package.json"))) pkg = dirname(pkg);
if (!pkg.startsWith(`${root}/`) || !existsSync(target)) {
  console.error(`${relative(root, target) || "."} is not a test file or directory in one of the workspace's packages\n${usage}`);
  process.exit(2);
}
const args = [
  "exec",
  "vitest",
  "run",
  ...(target === pkg ? [] : [relative(pkg, target)]),
  ...(values.name === undefined ? [] : ["-t", values.name]),
  ...passthrough,
];
console.log(`${runs} runs of \`vitest ${args.slice(2).join(" ")}\` in ${relative(root, pkg)}, ${jobs} at a time`);

interface Outcome {
  readonly run: number;
  readonly ok: boolean;
  readonly ms: number;
  readonly output: string;
}

const once = (run: number) =>
  new Promise<Outcome>((done) => {
    const started = Date.now();
    const child = spawn("pnpm", args, { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code, signal) =>
      done({ run, ok: code === 0, ms: Date.now() - started, output: signal === null ? output : `${output}\n(killed by ${signal})` }),
    );
  });

const started = Date.now();
const outcomes: Outcome[] = [];
let next = 1;
const worker = async () => {
  while (next <= runs) {
    const outcome = await once(next++);
    outcomes.push(outcome);
    console.log(`${outcome.ok ? "pass" : "FAIL"}  run ${outcome.run}  ${(outcome.ms / 1000).toFixed(1)}s  (${outcomes.length}/${runs})`);
  }
};
await Promise.all(Array.from({ length: Math.min(jobs, runs) }, worker));

const failed = outcomes.filter((outcome) => !outcome.ok).sort((a, b) => a.run - b.run);
for (const outcome of failed) console.log(`\n──── run ${outcome.run} failed ────\n${outcome.output.trimEnd()}`);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${runs - failed.length} passed, ${failed.length} failed, of ${runs} runs (${jobs} at a time) in ${seconds}s`);
process.exit(failed.length === 0 ? 0 : 1);
