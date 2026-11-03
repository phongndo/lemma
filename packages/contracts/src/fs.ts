import { closeSync, promises as nodeFs, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, uptime } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Cause, Data, Duration, Effect, Exit, Option, Result, Schedule, Schema } from "effect";
import type { Scope } from "effect";
import { errorMessage } from "./host.ts";

/*
 * Node only, apart from the package root (which clients load in browsers):
 * `@lemma/contracts/fs`.
 */

/** A Node error's `code` (`ENOENT`, `EEXIST`), if it has one. */
export const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : undefined;

/** Whether process `pid` runs on this machine, as this user or (refusing the signal) another. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
};

/** `~` and `~/…` against `home`, normalized when absolute; anything still relative is returned as is. */
export const expandHome = (path: string, home: string): string => {
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : expanded;
};

/** Whether `path` is `root` or inside it, by their resolved paths (symlinks are not followed). */
export const isInside = (root: string, path: string): boolean => {
  const inside = relative(resolve(root), resolve(path));
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

/** What is at `path`, following symlinks: undefined when nothing is, or it cannot be read. */
export const kindOf = (path: string): Promise<"file" | "directory" | "other" | undefined> =>
  nodeFs.stat(path).then(
    (info) => (info.isFile() ? "file" : info.isDirectory() ? "directory" : "other"),
    () => undefined,
  );

/** The file at `path` as JSON of `schema`; undefined when it is missing, unreadable, or does not decode. */
export const readJsonFile = async <A, I>(path: string, schema: Schema.Codec<A, I>, fs: FileSystem = nodeFileSystem): Promise<A | undefined> => {
  const text = await fs.readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text));
};

/** What storage code reads of a file's metadata. */
export interface FileStats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  /** 0 once the file's name was removed or replaced while it was open. */
  readonly nlink: number;
}

/** The `FileHandle` operations Lemma's storage code uses. */
export interface FileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  /** Writes `length` bytes of `buffer` from `offset` at `position` in the file, over what is there. */
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesWritten: number }>;
  appendFile(data: string): Promise<void>;
  writeFile(data: string): Promise<void>;
  chmod(mode: number): Promise<void>;
  stat(): Promise<FileStats>;
  truncate(length: number): Promise<void>;
  /**
   * Makes the data written so far survive a crash. After one fails, bytes it did not write may stay readable yet be
   * left out of every later sync (Linux marks such pages clean): only writing them again makes them durable.
   */
  datasync(): Promise<void>;
  /** As `datasync`, plus metadata; on a directory, makes its entries (created, renamed, removed names) survive a crash. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The `node:fs/promises` operations Lemma's storage code uses: a seam, so a
 * test can run that code on a simulated disk that crashes, tears writes, and
 * fails (`@lemma/testing`). `nodeFileSystem` is the real one.
 */
export interface FileSystem {
  open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStats>;
  mkdir(path: string, options: { readonly recursive: true; readonly mode?: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, path: string): Promise<void>;
  rm(path: string, options?: { readonly force?: boolean }): Promise<void>;
  utimes(path: string, atime: number | Date, mtime: number | Date): Promise<void>;
}

/** Looks each operation up when called, so a test that spies on `node:fs`'s `promises` reaches code given this. */
export const nodeFileSystem: FileSystem = {
  open: (path, flags, mode) => nodeFs.open(path, flags, mode),
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  readdir: (path) => nodeFs.readdir(path),
  stat: (path) => nodeFs.stat(path),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  rename: (from, to) => nodeFs.rename(from, to),
  link: (existing, path) => nodeFs.link(existing, path),
  rm: (path, options) => nodeFs.rm(path, options),
  utimes: (path, atime, mtime) => nodeFs.utimes(path, atime, mtime),
};

/** What a platform that cannot open or sync a directory answers (Windows, some network file systems). */
const UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/** Rethrows `cause` unless it says the platform cannot do the sync asked for, which is then skipped. */
export const unsupportedSync = (cause: unknown): void => {
  if (!UNSUPPORTED.has(errorCode(cause) ?? "")) throw cause;
};

/**
 * Makes the names in a directory durable: a new file's, or a removed one's absence. Skipped where the platform
 * cannot sync a directory (the data itself is still synced); any other failure, such as EIO, is thrown, since a
 * name that may not survive a crash must not be reported written.
 */
export const syncDirectory = async (fs: FileSystem, dir: string): Promise<void> => {
  const handle = await fs.open(dir, "r").catch(unsupportedSync);
  if (handle === undefined) return;
  try {
    await handle.sync().catch(unsupportedSync);
  } finally {
    await handle.close();
  }
};

/**
 * Syncs every directory above `dir`, so `dir` and each of its ancestors keep their names in a crash, whichever of
 * them an earlier run made and then failed to sync.
 */
export const syncAncestors = async (fs: FileSystem, dir: string): Promise<void> => {
  for (let at = dir; dirname(at) !== at; at = dirname(at)) await syncDirectory(fs, dirname(at));
};

/**
 * Syncs the parent of `dir`, and of each directory above it up to `created` (what `mkdir(dir, { recursive: true })`
 * returned: the first directory it made, if any). A directory's own name survives a crash only once its parent is
 * synced, and `dir` may have been made by an earlier call that failed before syncing it.
 */
export const syncParents = async (fs: FileSystem, dir: string, created: unknown): Promise<void> => {
  for (let at = dir; ; at = dirname(at)) {
    await syncDirectory(fs, dirname(at));
    if (typeof created !== "string" || at === created || dirname(at) === at) return;
  }
};

/**
 * Removes the file at `path` if there is one; `sync`, its absence survives a crash before this returns. The directory
 * is synced even when the file is gone already, as an earlier removal may not have been; only a directory that is
 * not there has nothing to sync.
 */
export async function removeFile(path: string, options: { readonly sync?: boolean; readonly fs?: FileSystem } = {}): Promise<void> {
  const fs = options.fs ?? nodeFileSystem;
  await fs.rm(path, { force: true });
  if (options.sync === true) {
    await syncDirectory(fs, dirname(path)).catch((cause: unknown) => {
      if (errorCode(cause) !== "ENOENT") throw cause;
    });
  }
}

export interface AtomicWriteOptions {
  /** The file's mode, set explicitly since the creation mode is subject to umask. Default 0600. */
  readonly mode?: number;
  /** The directory's mode when it has to be created. Default 0700. */
  readonly dirMode?: number;
  /**
   * Makes the write survive a crash before the call returns: the data is synced before it takes the file's place,
   * so a power loss cannot leave it empty, and the directory after, so it cannot undo the rename (or the link).
   * A directory the call created has its name synced too.
   */
  readonly sync?: boolean;
  /** Only creates the file: one that exists is left as it is, and the call returns false. */
  readonly exclusive?: boolean;
  /** Default `nodeFileSystem`. */
  readonly fs?: FileSystem;
}

/** Temporary files this process has made: their names are its pid and a count, drawing on no random source. */
let temps = 0;
/** A new temporary file beside `path`. A name left by a crashed process whose pid this one has now is skipped. */
const openTemp = async (fs: FileSystem, path: string, mode: number): Promise<{ readonly temp: string; readonly handle: FileHandle }> => {
  for (let attempt = 1; ; attempt++) {
    const temp = `${path}.${process.pid}-${++temps}.tmp`;
    try {
      return { temp, handle: await fs.open(temp, "wx", mode) };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST" || attempt === 16) throw cause;
    }
  }
};

/** Writes `data` into a new, empty file: text as UTF-8, bytes as they are, until every one is written. */
const writeAll = async (handle: FileHandle, data: string | Uint8Array): Promise<void> => {
  if (typeof data === "string") return handle.writeFile(data);
  for (let at = 0; at < data.length;) at += (await handle.write(data, at, data.length - at, at)).bytesWritten;
};

/**
 * Writes `data` (text, or bytes) to `path` whole or not at all: to a temporary
 * file beside it, then renamed into place (or, `exclusive`, linked, which
 * unlike a rename fails when the name exists), so a reader never sees a
 * partial file. The temporary file never outlives the call, whatever fails.
 * True when written.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<boolean> {
  const fs = options.fs ?? nodeFileSystem;
  const mode = options.mode ?? 0o600;
  const sync = options.sync === true;
  const created = await fs.mkdir(dirname(path), { recursive: true, mode: options.dirMode ?? 0o700 });
  if (sync && created !== undefined) await syncParents(fs, dirname(path), created);
  const { temp, handle } = await openTemp(fs, path, mode);
  try {
    try {
      await handle.chmod(mode);
      await writeAll(handle, data);
      if (sync) await handle.datasync();
    } finally {
      await handle.close();
    }
    if (options.exclusive !== true) {
      await fs.rename(temp, path);
      if (sync) await syncDirectory(fs, dirname(path));
      return true;
    }
    try {
      await fs.link(temp, path);
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") return false;
      throw cause;
    }
    // The temporary name is removed below; synced after that, the directory keeps only the link.
    await fs.rm(temp, { force: true });
    if (sync) await syncDirectory(fs, dirname(path));
    return true;
  } finally {
    // Gone already after a rename; a link or a failure leaves it.
    await fs.rm(temp, { force: true });
  }
}

/*
 * Pid locks: a file naming the one process that holds it, kept while that
 * process runs, as a host keeps its home and a sessions store its directory.
 * They are a convention between Lemma processes, not protection against other
 * programs.
 */

/** Slack for the boot time, which uptime gives to the second, and for a clock set at boot. */
export const BOOT_SLACK_MS = 10_000;
/** How old a lock that names nobody, or a takeover guard, must be before it is taken over: writing one takes far less. */
export const UNREADABLE_GRACE_MS = 10_000;

/** Epoch ms this machine booted: a lock taken before then (less `BOOT_SLACK_MS`) names a process that is gone, whatever has its pid now. */
export const bootTime = (): number => Date.now() - uptime() * 1000;

/** A lock file as it was found: its text, and how long ago it was last modified. */
export interface FoundLock {
  readonly text: string;
  readonly age: number;
}

/** A pid lock to take. */
export interface PidLock {
  /** The lock file. A process taking a stale one over holds `<file>.takeover` beside it while it does. */
  readonly file: string;
  /** What this process writes in it, naming itself. */
  readonly text: string;
  /**
   * Whether the lock found is abandoned, so it may be taken over: its holder is gone, or it names nobody and is older
   * than `UNREADABLE_GRACE_MS`, too old to be still being written.
   */
  readonly stale: (found: FoundLock) => boolean;
}

/** The file operations taking a pid lock uses, as Effects, so the one way of taking it runs on synchronous calls or a `FileSystem`. */
export interface PidLockFiles<E> {
  /** Creates the file holding `text`; false when it exists. */
  readonly create: (file: string, text: string) => Effect.Effect<boolean, E>;
  /** The file as found; undefined when there is none. */
  readonly inspect: (file: string) => Effect.Effect<FoundLock | undefined, E>;
  /** Writes `text` over the file. */
  readonly replace: (file: string, text: string) => Effect.Effect<void, E>;
  /** Removes the file if it is there. */
  readonly remove: (file: string) => Effect.Effect<void, E>;
  /** Waits a moment while another process takes the lock over. */
  readonly pause: Effect.Effect<void>;
}

/** The lock taken, or else the lock that holds it, as found. */
export type PidLockClaim = { readonly taken: true } | { readonly taken: false; readonly holder: FoundLock };

/**
 * Takes `lock.file` for this process, or finds the lock that holds it. The
 * file is created exclusively, so two processes cannot both take a free lock.
 * One found `stale` is taken over only by the process that creates the guard
 * beside it (`<file>.takeover`), and only if it is still the lock found stale,
 * so two cannot both take it over. A guard a crash left is cleared once it is
 * older than `UNREADABLE_GRACE_MS`; two processes clearing one at the same
 * instant could both go on, a window this convention accepts.
 */
export const claimPidLock = <E>(files: PidLockFiles<E>, lock: PidLock): Effect.Effect<PidLockClaim, E> =>
  Effect.gen(function* () {
    const guard = `${lock.file}.takeover`;
    for (;;) {
      if (yield* files.create(lock.file, lock.text)) return { taken: true } as const;
      const found = yield* files.inspect(lock.file);
      // Released meanwhile.
      if (found === undefined) continue;
      if (!lock.stale(found)) return { taken: false, holder: found } as const;
      if (!(yield* files.create(guard, lock.text))) {
        // Another process is taking it over; or one crashed doing so, and its guard is old.
        const other = yield* files.inspect(guard);
        if (other !== undefined && other.age > UNREADABLE_GRACE_MS) yield* files.remove(guard);
        else yield* files.pause;
        continue;
      }
      // Replaced only if it is still the lock found stale: another process may have taken it over meanwhile.
      const taken = yield* Effect.gen(function* () {
        if ((yield* files.inspect(lock.file))?.text !== found.text) return false;
        yield* files.replace(lock.file, lock.text);
        return true;
      }).pipe(Effect.ensuring(Effect.ignore(files.remove(guard))));
      if (taken) return { taken: true } as const;
    }
  });

/** A pid lock's files on `node:fs`'s synchronous calls. What they throw is a defect. */
const syncLockFiles: PidLockFiles<never> = {
  create: (file, text) =>
    Effect.sync(() => {
      try {
        const fd = openSync(file, "wx", 0o600);
        try {
          writeSync(fd, text);
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (cause) {
        if (errorCode(cause) === "EEXIST") return false;
        throw cause;
      }
    }),
  inspect: (file) =>
    Effect.sync(() => {
      try {
        const { mtimeMs } = statSync(file);
        return { text: readFileSync(file, "utf8"), age: Date.now() - mtimeMs };
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return undefined;
        throw cause;
      }
    }),
  replace: (file, text) => Effect.sync(() => writeFileSync(file, text, { mode: 0o600 })),
  remove: (file) =>
    Effect.sync(() => {
      try {
        unlinkSync(file);
      } catch {
        // Gone already.
      }
    }),
  pause: Effect.sync(() => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)),
};

/**
 * `claimPidLock` on `node:fs`'s synchronous calls, for a process that takes its
 * lock before anything else starts. It throws what those calls throw. Its
 * writes are not synced.
 */
export const claimPidLockSync = (lock: PidLock): PidLockClaim => {
  const exit = Effect.runSyncExit(claimPidLock(syncLockFiles, lock));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

/*
 * File locks: a file held while a piece of work runs, so processes take turns
 * at a read-modify-write.
 */

export interface FileLockOptions {
  /** Give up with `Locked` after waiting this long for another holder. Default 10s. */
  readonly waitMs?: number;
  /** A lock whose file has not been touched for this long is abandoned. Holders touch it at a third of this. Default 30s. */
  readonly staleMs?: number;
}

/** A file lock was not taken: `Locked`, another process held it for all of `waitMs`; `Io`, its file or directory could not be made. */
export class FileLockError extends Data.TaggedError("FileLockError")<{
  readonly reason: "Locked" | "Io";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** What a file lock holds: its holder's process, machine, and a nonce no other holder has. */
interface FileLockOwner {
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
}

/**
 * Holds the file `lock` for the scope, so processes take turns at what runs in
 * it. The lock is created with O_EXCL and holds `{ pid, host, nonce }`; its
 * directory is made (0700) if missing. The holder touches it every third of
 * `staleMs`, a heartbeat that stops with the scope even when the work in it
 * runs uninterruptibly. A lock is abandoned when its process is gone (same
 * host) or it has not been touched within `staleMs`; a crash between creating
 * and writing it leaves an empty one, abandoned once stale like any other. A
 * waiter removes exactly the lock it judged abandoned (matched by content), and
 * two racing to remove one leave a narrow window this convention accepts.
 * Waiting polls with jitter and fails `Locked` after `waitMs`. It does not
 * guard against programs that ignore the lock.
 */
export const holdFileLock = (lock: string, options: FileLockOptions = {}): Effect.Effect<void, FileLockError, Scope.Scope> => {
  const waitMs = options.waitMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const owner: FileLockOwner = { pid: process.pid, host: hostname(), nonce: randomUUID() };
  const io = (what: string) => (cause: unknown) => new FileLockError({ reason: "Io", message: `Cannot create ${what}: ${errorMessage(cause)}`, cause });

  const tryCreate = Effect.tryPromise({
    try: async () => {
      const handle = await nodeFs.open(lock, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.result);

  /** The current holder's text if it is abandoned, `vanished` if the lock disappeared meanwhile, else undefined. */
  const abandoned = Effect.promise(async (): Promise<{ readonly text: string } | "vanished" | undefined> => {
    try {
      const handle = await nodeFs.open(lock, "r");
      try {
        const [info, text] = await Promise.all([handle.stat(), handle.readFile("utf8")]);
        if (Date.now() - info.mtimeMs > staleMs) return { text };
        const holder = Result.getOrUndefined(Result.try(() => JSON.parse(text) as Partial<FileLockOwner>));
        if (holder?.host === owner.host && typeof holder.pid === "number" && !isAlive(holder.pid)) return { text };
        return undefined;
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return "vanished";
      throw cause;
    }
  });

  const removeIfUnchanged = (text: string) =>
    Effect.promise(async () => {
      const current = await nodeFs.readFile(lock, "utf8").catch(() => undefined);
      if (current !== undefined && current === text) await nodeFs.rm(lock, { force: true });
    });

  const acquire = Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => nodeFs.mkdir(dirname(lock), { recursive: true, mode: 0o700 }), catch: io(dirname(lock)) });
    const deadline = Date.now() + waitMs;
    while (true) {
      const created = yield* tryCreate;
      if (Result.isSuccess(created)) return;
      if (errorCode(created.failure) !== "EEXIST") return yield* io(lock)(created.failure);
      const stale = yield* abandoned;
      if (stale === "vanished") continue;
      if (stale !== undefined) yield* removeIfUnchanged(stale.text);
      // Also bounds retries when an abandoned lock cannot be removed.
      if (Date.now() >= deadline) {
        return yield* new FileLockError({ reason: "Locked", message: `${lock} is held by another process; gave up after ${waitMs}ms` });
      }
      if (stale === undefined) yield* Effect.sleep(Duration.millis(20 + Math.random() * 60));
    }
  });

  const release = Effect.promise(async () => {
    const current = await nodeFs.readFile(lock, "utf8").catch(() => undefined);
    if (current === JSON.stringify(owner)) await nodeFs.rm(lock, { force: true });
  });

  const heartbeat = Effect.promise(() => {
    const now = new Date();
    return nodeFs.utimes(lock, now, now).catch(() => undefined);
  }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(staleMs / 3))));

  return Effect.gen(function* () {
    yield* Effect.acquireRelease(acquire, () => release);
    // Interruptible even when the work is not (a token refresh that must not lose its rotated token): closing the
    // scope interrupts this fiber and waits for it, so it must never run uninterruptibly.
    yield* Effect.forkScoped(Effect.interruptible(heartbeat));
  });
};
