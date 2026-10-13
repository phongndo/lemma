import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

/** What a measurement counts. A rate (`count/s`) is better higher; every other unit, lower. */
export type Unit =
  | "us/op"
  | "us"
  | "ms"
  | "ms/step"
  | "MB"
  | "bytes"
  | "bytes/step"
  | "bytes/turn"
  | "count"
  | "count/step"
  | "count/turn"
  | "count/s"
  | "ratio";

export interface Measurement {
  readonly value: number;
  readonly unit: Unit;
  /** The samples `value` summarizes (batches, operations, or turns), when it summarizes several. */
  readonly values?: readonly number[];
  /** An average count's exact sum and number of samples, compared with its limit before any rounding. */
  readonly total?: number;
  readonly samples?: number;
  readonly limit?: number;
  readonly passed?: boolean;
  /** Whether exceeding `limit` fails the run: always for counts and sizes, for timings under `LEMMA_PERF_ENFORCE=1`. */
  readonly enforced?: boolean;
}

/** The commit measured, and whether the working tree had changes beside it. */
function source(): { readonly sha?: string; readonly dirty?: boolean } {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    // Not a git checkout.
    return {};
  }
}

/**
 * Prints a benchmark's report as the last line of its output and, with `LEMMA_BENCH_OUTPUT_DIR`, writes it to
 * `<name>.json` there. `parameters` are the workload's sizes and counts, so a report says what it measured.
 */
export function writeReport(
  name: string,
  measurements: Readonly<Record<string, Measurement>>,
  enforced: boolean,
  parameters?: Readonly<Record<string, unknown>>,
) {
  const report = {
    measuredAt: new Date().toISOString(),
    runtime: `Node ${process.version}`,
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus()[0]?.model,
    source: source(),
    ...(parameters === undefined ? {} : { parameters }),
    enforced,
    measurements,
  };
  console.log(JSON.stringify(report));
  const directory = process.env.LEMMA_BENCH_OUTPUT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}
