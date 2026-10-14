import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { holdHostLock } from "../src/process.ts";

const home = () => mkdtempSync(join(tmpdir(), "lemma-lock-"));
const lockOf = (dir: string) => join(dir, "host.lock");
const holding = (dir: string, pid: number, startedAt: number) => writeFileSync(lockOf(dir), JSON.stringify({ pid, startedAt }));

/** A pid no process has: past Linux's and macOS's highest. */
const GONE = 2 ** 22 + 1;

describe("holdHostLock", () => {
  test("takes a free lock, naming this process", () => {
    const dir = home();
    expect(holdHostLock(dir)).toBeUndefined();
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8"))).toMatchObject({ pid: process.pid });
  });

  test("a live holder that started since boot keeps it", () => {
    const dir = home();
    holding(dir, process.ppid, Date.now());
    expect(holdHostLock(dir)).toBe(process.ppid);
  });

  test("takes over a lock whose holder is gone, or that was taken before the machine booted, whatever has its pid now", () => {
    for (const [pid, startedAt] of [
      [GONE, Date.now()],
      [process.ppid, Date.now() - uptime() * 1000 - 60_000],
    ] as const) {
      const dir = home();
      holding(dir, pid, startedAt);
      expect(holdHostLock(dir)).toBeUndefined();
      expect(JSON.parse(readFileSync(lockOf(dir), "utf8"))).toMatchObject({ pid: process.pid });
    }
  });

  test("one that names nobody holds while it may still be being written, and is taken over once old", () => {
    const dir = home();
    writeFileSync(lockOf(dir), "");
    expect(holdHostLock(dir)).toBe(-1);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockOf(dir), old, old);
    expect(holdHostLock(dir)).toBeUndefined();
  });

  test("waits out another start's takeover, then finds the lock it took", () => {
    const dir = home();
    holding(dir, GONE, Date.now());
    // A guard left by a start that crashed mid-takeover is cleared once old.
    writeFileSync(`${lockOf(dir)}.takeover`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockOf(dir)}.takeover`, old, old);
    expect(holdHostLock(dir)).toBeUndefined();
  });
});
