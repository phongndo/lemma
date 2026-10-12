import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { digestRun } from "../src/run.ts";

/*
 * A seed is a run: the real sessions store, agent loop, and tool registry on a simulated disk, in simulated time,
 * leave the same bytes on the disk every time, in this process or another. Nothing in the run may reach the event
 * loop's timers, which would let real time decide what happens when.
 */

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("a simulated run", () => {
  it("leaves the same disk for the same seed, and another for another", async () => {
    const [once, again, other] = [await digestRun(1), await digestRun(1), await digestRun(2)];
    expect(again).toBe(once);
    expect(other).not.toBe(once);
  });

  it("leaves the same disk in another process", async () => {
    const here = await digestRun(1);
    const there = execFileSync(process.execPath, ["--conditions=lemma-source", main, "--seed", "1", "--digest"], { encoding: "utf8" }).trim().split("\n");
    expect(there).toEqual(["seed 1", here]);
  });

  it("starts no timer of the event loop's", async () => {
    const started: string[] = [];
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, setImmediate: globalThis.setImmediate };
    const spy =
      <F extends (...args: never[]) => unknown>(name: string, original: F) =>
      (...args: Parameters<F>) => {
        started.push(`${name}: ${new Error().stack?.split("\n")[2]?.trim()}`);
        return original(...args);
      };
    Object.assign(globalThis, {
      setTimeout: spy("setTimeout", real.setTimeout),
      setInterval: spy("setInterval", real.setInterval),
      setImmediate: spy("setImmediate", real.setImmediate),
    });
    try {
      await digestRun(3);
    } finally {
      Object.assign(globalThis, real);
    }
    expect(started).toEqual([]);
  });
});
