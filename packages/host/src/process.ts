import { mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { BOOT_SLACK_MS, bootTime, claimPidLockSync, isAlive, UNREADABLE_GRACE_MS } from "@lemma/contracts/fs";
import { hostFiles } from "./paths.ts";

/*
 * What the host keeps in its home for as long as it runs, before anything
 * else starts: one host per home, and a log of what it prints.
 */

/**
 * Takes `<home>/host.lock` (`{ pid, startedAt }`) for this process, or
 * returns the pid of the host that holds it (-1 when the lock, just made,
 * does not name it yet). The sessions store has a single
 * writer, so a second host must not start beside the first; this says so
 * before anything starts, naming it. A lock left by a host that is gone (a
 * crash, SIGKILL) is taken over (`claimPidLockSync`): its pid runs nothing, or
 * it was taken before the machine last booted, when the pid may be another
 * process's now. One that names nobody is taken over once it is too old to be
 * still being written. Released when the process exits.
 */
export const holdHostLock = (home: string): number | undefined => {
  const { lock } = hostFiles(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`;
  const bootedAt = bootTime();
  const holderOf = (found: string): { readonly pid: number; readonly startedAt: number } | undefined => {
    try {
      const { pid, startedAt } = JSON.parse(found) as { pid?: unknown; startedAt?: unknown };
      return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startedAt === "number" ? { pid, startedAt } : undefined;
    } catch {
      return undefined;
    }
  };
  const claim = claimPidLockSync({
    file: lock,
    text,
    stale: (found) => {
      const holder = holderOf(found.text);
      return holder === undefined
        ? found.age > UNREADABLE_GRACE_MS
        : holder.pid === process.pid || !isAlive(holder.pid) || holder.startedAt < bootedAt - BOOT_SLACK_MS;
    },
  });
  if (!claim.taken) return holderOf(claim.holder.text)?.pid ?? -1;
  process.on("exit", () => {
    try {
      if (readFileSync(lock, "utf8") === text) unlinkSync(lock);
    } catch {
      // Gone already.
    }
  });
  return undefined;
};

/** A log grown past this is moved to `host.log.1` when the next host starts. */
const LOG_LIMIT = 5 * 1024 * 1024;

/**
 * Copies what the process writes to stdout and stderr into
 * `<home>/logs/host.log`, so `lemma logs` reads it however the host was
 * started (a terminal, `serve --detach`, the desktop app, a service). The
 * last run's log is kept beside it once it grows past `LOG_LIMIT`. A write the
 * log refuses (a full disk) never fails the host. What a worker thread writes
 * to the file descriptor itself (a stall's report) is not copied.
 */
export const teeLog = (home: string, header: string): void => {
  const { log, previousLog, logs } = hostFiles(home);
  try {
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    try {
      if (statSync(log).size > LOG_LIMIT) renameSync(log, previousLog);
    } catch {
      // No log yet.
    }
    const fd = openSync(log, "a", 0o600);
    const append = (chunk: unknown) => {
      try {
        if (typeof chunk === "string") writeSync(fd, chunk);
        else writeSync(fd, chunk as Uint8Array);
      } catch {
        // A full disk, say: the host goes on.
      }
    };
    append(`${header}\n`);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        append(chunk);
        return write(chunk, ...rest);
      }) as typeof stream.write;
    }
  } catch {
    // No log: the host still runs, printing as it always did.
  }
};
