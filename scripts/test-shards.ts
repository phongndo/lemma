import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// CI runs the tests in shards, a runner each. Vitest splits them by an equal count of files in hash order, which put
// twice the work in one half as in the other: a few files that start real hosts take most of the time. This splits
// them by how long each took instead, from `test-durations.json` (`pnpm test:durations` rewrites it). Every shard
// computes the same split, so together they still run each file once. A file the table does not know counts as the
// median one, so a stale table only splits less evenly.

/** Seconds each test file took, by its path from the repository's root. */
const durations: Readonly<Record<string, number>> = JSON.parse(readFileSync(new URL("test-durations.json", import.meta.url), "utf8"));
const known = Object.values(durations).sort((a, b) => a - b);
const median = known[Math.floor(known.length / 2)] ?? 1;
/** What a file costs a runner beyond its tests' time, which the table leaves out: starting, importing, collecting. */
const PER_FILE = 0.25;

/**
 * Which of `count` shards each file runs in, and the time each shard gets: the longest file first, each to the shard
 * with the least time so far.
 */
export const assignShards = (files: readonly string[], count: number): { shardOf: Map<string, number>; totals: number[] } => {
  const totals = Array.from({ length: count }, () => 0);
  const shardOf = new Map<string, number>();
  const longestFirst = [...new Set(files)].sort((a, b) => (durations[b] ?? median) - (durations[a] ?? median) || (a < b ? -1 : 1));
  for (const file of longestFirst) {
    const least = totals.indexOf(Math.min(...totals));
    shardOf.set(file, least);
    totals[least] = (totals[least] ?? 0) + (durations[file] ?? median) + PER_FILE;
  }
  return { shardOf, totals };
};

export class DurationSequencer extends BaseSequencer {
  private path(file: TestSpecification): string {
    return relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { shard } = this.ctx.config;
    if (!shard) return files;
    const { shardOf } = assignShards(
      files.map((file) => this.path(file)),
      shard.count,
    );
    return files.filter((file) => shardOf.get(this.path(file)) === shard.index - 1);
  }

  // The longest files first, so none starts last and holds up the end: on a fresh runner, which has no results from
  // a run before, Vitest would order them by project and by size. What failed last time still runs first.
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const failed = (file: TestSpecification) => Number(this.ctx.cache.getTestSpecificationResult(file)?.failed === true);
    const seconds = (file: TestSpecification) => durations[this.path(file)] ?? median;
    return [...files].sort(
      (a, b) =>
        a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder ||
        Number(b.project.config.isolate) - Number(a.project.config.isolate) ||
        failed(b) - failed(a) ||
        seconds(b) - seconds(a),
    );
  }
}
