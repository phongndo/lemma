import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Rewrites `test-durations.json`, which CI splits the tests into shards by (`test-shards.ts`): runs every test once
// and records how long each file took. Run it when the shards' times drift apart: `pnpm test:durations`. On Linux it
// runs on four cores, as a CI runner has, so a file's time includes its share of a busy runner: on many cores the
// small files' start-up looks free, and a shard of them takes longer than its sum.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "lemma-test-durations-"));
const report = join(dir, "report.json");

try {
  const vitest = ["pnpm", "exec", "vitest", "run", "--reporter=dot", "--reporter=json", `--outputFile.json=${report}`];
  const pinned = spawnSync("taskset", ["--version"]).status === 0 ? ["taskset", "-c", "0-3", ...vitest] : vitest;
  const run = spawnSync(pinned[0]!, pinned.slice(1), { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error("The tests failed; test-durations.json is unchanged.");
    process.exit(1);
  }
  const { testResults } = JSON.parse(readFileSync(report, "utf8")) as { testResults: { name: string; startTime: number; endTime: number }[] };
  const durations = Object.fromEntries(
    testResults
      .map((file) => [relative(root, file.name).replaceAll("\\", "/"), Math.round((file.endTime - file.startTime) / 100) / 10] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(join(root, "scripts/test-durations.json"), `${JSON.stringify(durations, null, 2)}\n`);
  const { assignShards } = await import("./test-shards.ts");
  for (const count of [2, 3]) {
    const { totals } = assignShards(Object.keys(durations), count);
    console.log(`${count} shards: ${totals.map((seconds) => `${seconds.toFixed(0)} s`).join(", ")}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
