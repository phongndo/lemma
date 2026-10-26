import { promises as nodeFs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Option, Schema } from "effect";

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
