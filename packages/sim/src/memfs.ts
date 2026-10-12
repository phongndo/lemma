import { constants } from "node:fs";
import { dirname } from "node:path";
import type { FileHandle, FileStats, FileSystem } from "@lemma/contracts/fs";

/*
 * A file system in memory for the harness benchmark: an append grows a file's buffer in place (doubling it when full),
 * as a real file grows, where `SimDisk` copies the whole file to model what a crash keeps. It models no crash and no
 * fault: only what costs, so the benchmark measures the harness, not its disk's bookkeeping.
 */

const errno = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });

class Contents {
  private bytes = new Uint8Array(1024);
  length = 0;
  mtimeMs = 0;
  readonly ino: number;
  nlink = 1;

  constructor(ino: number) {
    this.ino = ino;
  }

  view(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  writeAt(source: Uint8Array, position: number): void {
    const end = position + source.length;
    if (end > this.bytes.length) {
      let capacity = this.bytes.length;
      while (capacity < end) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.view());
      this.bytes = grown;
    }
    this.bytes.set(source, position);
    this.length = Math.max(this.length, end);
  }

  truncate(length: number): void {
    if (length < this.length) this.bytes.fill(0, length, this.length);
    this.length = Math.min(this.length, length);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a `MemFs` does, counted: operations, bytes, and syncs. */
export interface DiskCounts {
  opens: number;
  reads: number;
  bytesRead: number;
  writes: number;
  bytesWritten: number;
  syncs: number;
  renames: number;
  removes: number;
}

export const newDiskCounts = (): DiskCounts => ({ opens: 0, reads: 0, bytesRead: 0, writes: 0, bytesWritten: 0, syncs: 0, renames: 0, removes: 0 });

/** A file system in memory, counting what is done to it in `counts`. */
export class MemFs implements FileSystem {
  readonly counts: DiskCounts = newDiskCounts();
  private readonly files = new Map<string, Contents>();
  private readonly directories = new Set<string>(["/"]);
  private nextIno = 2;

  async open(path: string, flags: string | number): Promise<FileHandle> {
    this.counts.opens++;
    const creates = flags === "ax" || flags === "wx" || flags === "w" || flags === "a" || (typeof flags === "number" && (flags & constants.O_CREAT) !== 0);
    const exclusive = flags === "ax" || flags === "wx";
    const appends = flags === "ax" || flags === "a" || (typeof flags === "number" && (flags & constants.O_APPEND) !== 0);
    if (this.directories.has(path)) return this.directoryHandle();
    let file = this.files.get(path);
    if (file !== undefined && exclusive) throw errno("EEXIST", `open '${path}'`);
    if (file === undefined) {
      if (!creates) throw errno("ENOENT", `open '${path}'`);
      if (!this.directories.has(dirname(path))) throw errno("ENOENT", `open '${path}'`);
      file = new Contents(this.nextIno++);
      this.files.set(path, file);
    }
    if (flags === "w") file.truncate(0);
    return this.handle(file, appends);
  }

  async readFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (file === undefined) throw errno("ENOENT", `open '${path}'`);
    this.counts.reads++;
    this.counts.bytesRead += file.length;
    return decoder.decode(file.view());
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.directories.has(path)) throw errno("ENOENT", `scandir '${path}'`);
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const entry of [...this.files.keys(), ...this.directories]) {
      if (entry !== path && entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/")) names.add(entry.slice(prefix.length));
    }
    return [...names].sort();
  }

  async stat(path: string): Promise<FileStats> {
    const file = this.files.get(path);
    if (file !== undefined) return this.statOf(file);
    if (this.directories.has(path)) return { size: 0, mtimeMs: 0, ino: 1, nlink: 1 };
    throw errno("ENOENT", `stat '${path}'`);
  }

  async mkdir(path: string): Promise<string | undefined> {
    let first: string | undefined;
    const missing: string[] = [];
    for (let at = path; !this.directories.has(at); at = dirname(at)) missing.push(at);
    for (const directory of missing.reverse()) {
      first ??= directory;
      this.directories.add(directory);
    }
    return first;
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (file === undefined) throw errno("ENOENT", `rename '${from}'`);
    this.counts.renames++;
    this.files.delete(from);
    this.files.set(to, file);
  }

  async link(existing: string, path: string): Promise<void> {
    const file = this.files.get(existing);
    if (file === undefined) throw errno("ENOENT", `link '${existing}'`);
    if (this.files.has(path)) throw errno("EEXIST", `link '${path}'`);
    file.nlink++;
    this.files.set(path, file);
  }

  async rm(path: string, options?: { readonly force?: boolean }): Promise<void> {
    const file = this.files.get(path);
    if (file === undefined) {
      if (options?.force === true) return;
      throw errno("ENOENT", `rm '${path}'`);
    }
    this.counts.removes++;
    file.nlink--;
    this.files.delete(path);
  }

  async utimes(path: string, _atime: number | Date, mtime: number | Date): Promise<void> {
    const file = this.files.get(path);
    if (file !== undefined) file.mtimeMs = typeof mtime === "number" ? mtime * 1000 : mtime.getTime();
  }

  private statOf(file: Contents): FileStats {
    return { size: file.length, mtimeMs: file.mtimeMs, ino: file.ino, nlink: file.nlink };
  }

  private directoryHandle(): FileHandle {
    const counts = this.counts;
    const none = () => Promise.reject(errno("EISDIR", "a directory"));
    return {
      read: none,
      write: none,
      appendFile: none,
      writeFile: none,
      chmod: async () => {},
      stat: async () => ({ size: 0, mtimeMs: 0, ino: 1, nlink: 1 }),
      truncate: none,
      datasync: async () => void counts.syncs++,
      sync: async () => void counts.syncs++,
      close: async () => {},
    };
  }

  private handle(file: Contents, appends: boolean): FileHandle {
    const counts = this.counts;
    const write = (bytes: Uint8Array, position: number) => {
      counts.writes++;
      counts.bytesWritten += bytes.length;
      file.writeAt(bytes, position);
    };
    return {
      read: async (buffer, offset, length, position) => {
        const bytes = file.view().subarray(position, position + length);
        buffer.set(bytes, offset);
        counts.reads++;
        counts.bytesRead += bytes.length;
        return { bytesRead: bytes.length };
      },
      write: async (buffer, offset, length, position) => {
        write(buffer.subarray(offset, offset + length), appends ? file.length : position);
        return { bytesWritten: length };
      },
      appendFile: async (text) => write(encoder.encode(text), file.length),
      writeFile: async (text) => {
        file.truncate(0);
        write(encoder.encode(text), 0);
      },
      chmod: async () => {},
      stat: async () => this.statOf(file),
      truncate: async (length) => file.truncate(length),
      datasync: async () => void counts.syncs++,
      sync: async () => void counts.syncs++,
      close: async () => {},
    };
  }
}
