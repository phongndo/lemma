import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { uptime } from "node:os";
import { hostFiles } from "./paths.ts";

/*
 * What the host keeps in its home for as long as it runs, before anything
 * else starts: one host per home, and a log of what it prints.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, but another user's: not ours to judge stale.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Slack for the boot time, which uptime gives to the second, and for a clock set at boot. */
const BOOT_SLACK_MS = 10_000;
/** How old a lock that names nobody, or a takeover guard, must be before it is taken over: writing one takes far less. */
const UNREADABLE_GRACE_MS = 10_000;

/** The file's text and age in milliseconds, or undefined when there is none. */
const inspect = (file: string): { readonly text: string; readonly age: number } | undefined => {
  try {
    const { mtimeMs } = statSync(file);
    return { text: readFileSync(file, "utf8"), age: Date.now() - mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Creates `file` holding `text`; false when it exists. */
const createNew = (file: string, text: string): boolean => {
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const removeFile = (file: string) => {
  try {
    unlinkSync(file);
  } catch {
    // Gone already.
  }
};

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Takes `<home>/host.lock` (`{ pid, startedAt }`) for this process, or
 * returns the pid of the host that holds it (-1 when the lock, just made,
 * does not name it yet). The sessions store has a single
 * writer, so a second host must not start beside the first; this says so
 * before anything starts, naming it. Created exclusively, so two hosts
 * starting at once cannot both take it. One left by a host that is gone (a
 * crash, SIGKILL) is taken over: its pid runs nothing, or it was taken before
 * the machine last booted, when the pid may be another process's now. One
 * that names nobody is taken over once it is too old to be still being
 * written. Only the start that creates `host.lock.takeover` takes a stale
 * lock over, and only if it is still the lock found stale, so two cannot both
 * take it; a guard left by a crash is cleared once it is old. Released when
 * the process exits.
 */
export const holdHostLock = (home: string): number | undefined => {
  const { lock } = hostFiles(home);
  const guard = `${lock}.takeover`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`;
  const bootedAt = Date.now() - uptime() * 1000;
  const holderOf = (found: string): { readonly pid: number; readonly startedAt: number } | undefined => {
    try {
      const { pid, startedAt } = JSON.parse(found) as { pid?: unknown; startedAt?: unknown };
      return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startedAt === "number" ? { pid, startedAt } : undefined;
    } catch {
      return undefined;
    }
  };
  for (;;) {
    if (createNew(lock, text)) break;
    const found = inspect(lock);
    // Released meanwhile.
    if (found === undefined) continue;
    const holder = holderOf(found.text);
    const stale =
      holder === undefined ? found.age > UNREADABLE_GRACE_MS : holder.pid === process.pid || !alive(holder.pid) || holder.startedAt < bootedAt - BOOT_SLACK_MS;
    if (!stale) return holder?.pid ?? -1;
    if (!createNew(guard, text)) {
      // Another start is taking it over; or one crashed doing so, and its guard is old.
      const other = inspect(guard);
      if (other !== undefined && other.age > UNREADABLE_GRACE_MS) removeFile(guard);
      else pause(50);
      continue;
    }
    let taken = false;
    try {
      // Replaced only if it is still the lock found stale: another start may have taken it over meanwhile.
      if (inspect(lock)?.text === found.text) {
        writeFileSync(lock, text, { mode: 0o600 });
        taken = true;
      }
    } finally {
      removeFile(guard);
    }
    if (taken) break;
  }
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
