import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
  stat(path).then(
    (info) => (info.isFile() ? "file" : info.isDirectory() ? "directory" : "other"),
    () => undefined,
  );

/** The file at `path` as JSON of `schema`; undefined when it is missing, unreadable, or does not decode. */
export const readJsonFile = async <A, I>(path: string, schema: Schema.Schema<A, I>): Promise<A | undefined> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.parseJson(schema))(text));
};

export interface AtomicWriteOptions {
  /** The file's mode, set explicitly since the creation mode is subject to umask. Default 0600. */
  readonly mode?: number;
  /** The directory's mode when it has to be created. Default 0700. */
  readonly dirMode?: number;
  /** Syncs the data before it takes the file's place, so a power loss cannot leave it empty. */
  readonly sync?: boolean;
  /** Only creates the file: one that exists is left as it is, and the call returns false. */
  readonly exclusive?: boolean;
}

/**
 * Writes `text` to `path` whole or not at all: to a temporary file beside it,
 * then renamed into place (or, `exclusive`, linked, which unlike a rename
 * fails when the name exists), so a reader never sees a partial file. The
 * temporary file never outlives the call, whatever fails. True when written.
 */
export async function writeFileAtomic(path: string, text: string, options: AtomicWriteOptions = {}): Promise<boolean> {
  const mode = options.mode ?? 0o600;
  await mkdir(dirname(path), { recursive: true, mode: options.dirMode ?? 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.chmod(mode);
      await handle.writeFile(text);
      if (options.sync === true) await handle.datasync();
    } finally {
      await handle.close();
    }
    if (options.exclusive !== true) {
      await rename(temp, path);
      return true;
    }
    try {
      await link(temp, path);
      return true;
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") return false;
      throw cause;
    }
  } finally {
    // Gone already after a rename; a link or a failure leaves it.
    await rm(temp, { force: true });
  }
}
