import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/*
 * Node only, apart from the package root (which clients load in browsers):
 * `@lemma/contracts/fs`.
 */

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
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw cause;
    }
  } finally {
    // Gone already after a rename; a link or a failure leaves it.
    await rm(temp, { force: true });
  }
}
