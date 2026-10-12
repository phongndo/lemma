import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The harness benchmark runs here on a short session so it cannot rot unnoticed (`pnpm harness:bench` runs it to
 * 10,000 entries). What it counts per step is the same on every machine: this test, run on Linux and macOS alike,
 * pins the counts, so a change that makes a step do more shows here, and is either fixed or its count moved on.
 */

const script = fileURLToPath(new URL("../bench/harness.ts", import.meta.url));

describe("the harness benchmark", () => {
  it("counts the same work per step on every machine", { timeout: 60_000 }, () => {
    const output = execFileSync(process.execPath, ["--conditions=lemma-source", script], {
      encoding: "utf8",
      env: { ...process.env, LEMMA_HARNESS_BENCH_ENTRIES: "300", LEMMA_PERF_ENFORCE: "0", LEMMA_BENCH_OUTPUT_DIR: "" },
    });
    const { measurements } = JSON.parse(output.trim().split("\n").at(-1)!) as { measurements: Record<string, { value: number }> };
    const at100 = (what: string) => measurements[`Harness / 100 entries / ${what}`]?.value;
    expect({
      eventsRead: at100("events read per step"),
      syncs: at100("syncs per step"),
      bytesWritten: at100("bytes written per step"),
      hooks: at100("hooks run per step"),
      published: at100("events published per step"),
    }).toEqual({ eventsRead: 510, syncs: 8, bytesWritten: 2348, hooks: 3, published: 23 });
    expect(Number.isFinite(at100("ms per step"))).toBe(true);
  });
});
