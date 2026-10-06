import { constants } from "node:fs";
import { posix as path } from "node:path";
import type { FileHandle, FileStats, FileSystem } from "@lemma/contracts/fs";

/**
 * A disk in memory for crash tests, after SQLite's crash VFS and FoundationDB's
 * simulator: what a file holds now and what of it would survive a power loss are
 * kept apart, and `crash` decides, from the disk's random source, what survives.
 *
 * - Data is durable once `datasync` (or `sync`) returns on a handle of its file.
 *   At a crash, a file appended to since keeps its durable bytes plus some prefix
 *   of the rest, which may end mid-line and may be followed by zeros (a size
 *   that reached the disk before the data did, as ext4 can leave).
 * - A name (created, renamed, or removed) is durable once its directory is
 *   synced (`open(dir, "r")` then `sync()`); otherwise a crash may undo it.
 * - `faults` makes operations fail as a full or failing disk does, with
 *   probabilities a test draws per run (TigerBeetle's swarm testing).
 * - `outside` changes files as another program would.
 *
 * Only what `FileSystem` covers is modelled: one process, regular files and
 * directories, POSIX paths. `mount` returns the view a process uses; after
 * `crash`, every operation through an earlier mount fails, as the process that
 * held it is gone.
 */
export class SimDisk {
  readonly faults: Faults = {};
  /** Operations that failed by injection, by name: lets a test check its faults fired. */
  readonly injected = new Map<string, number>();
  private readonly files = new Map<number, Inode>();
  /** Names now, and the names a crash would leave. */
  private names = new Map<string, number>();
  private durableNames = new Map<string, number>();
  private nextIno = 2;
  private generation = 0;
  /** Operations left before a crash `crashAfter` scheduled. */
  private countdown: number | undefined;
  private clock = 1_700_000_000_000;
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
    this.names.set("/", this.mkInode("dir"));
    this.durableNames = new Map(this.names);
  }

  /** The file system as one process sees it, until the next crash. */
  mount(): FileSystem {
    const generation = this.generation;
    const guard = <A>(operation: () => A): Promise<Awaited<A>> =>
      Promise.resolve().then(() => {
        this.step(generation, "the process that mounted this disk crashed");
        return operation();
      }) as Promise<Awaited<A>>;
    return {
      open: (file, flags, mode) => guard(() => this.open(file, flags, mode, generation)),
      readFile: (file) => guard(() => new TextDecoder().decode(this.fileAt(file, "readFile").data)),
      readdir: (dir) => guard(() => this.readdir(dir)),
      stat: (file) => guard(() => this.statOf(this.inodeAt(file, "stat"))),
      mkdir: (dir, options) => guard(() => this.mkdir(dir, options.recursive)),
      rename: (from, to) => guard(() => this.rename(from, to)),
      link: (existing, file) => guard(() => this.link(existing, file)),
      rm: (file, options) => guard(() => this.rm(file, options?.force === true)),
      utimes: (file, _atime, mtime) =>
        guard(() => {
          this.inodeAt(file, "utimes").mtimeMs = typeof mtime === "number" ? mtime * 1000 : mtime.getTime();
        }),
    };
  }

  /**
   * A power loss in the middle of what the process is doing: after `operations`
   * more operations succeed, the next one finds the disk crashed (`crash`).
   */
  crashAfter(operations: number): void {
    this.countdown = operations;
  }

  /** Whether a crash `crashAfter` scheduled is still to come. */
  get crashPending(): boolean {
    return this.countdown !== undefined;
  }

  /**
   * A power loss: unsynced data and names are lost or torn, decided by the
   * random source, and every earlier mount stops working.
   */
  crash(): void {
    this.countdown = undefined;
    this.generation++;
    for (const inode of this.files.values()) {
      if (inode.kind !== "file") continue;
      inode.data = this.survivor(inode);
      inode.durable = inode.data;
    }
    // A name created since its directory's last sync may be gone; one removed or replaced may be back.
    const names = new Map<string, number>();
    for (const [name, ino] of this.durableNames) names.set(name, ino);
    for (const [name, ino] of this.names) {
      if (this.durableNames.get(name) !== ino && this.random() < 0.5) names.set(name, ino);
    }
    for (const [name] of this.durableNames) {
      if (!this.names.has(name) && this.random() < 0.5) names.delete(name);
    }
    // A name only survives with its directory, and that with its own: kept from the root down.
    const kept = new Map<string, number>();
    const depth = (name: string) => (name === "/" ? 0 : name.split("/").length);
    for (const [name, ino] of [...names].sort(([a], [b]) => depth(a) - depth(b))) {
      if (name === "/" || kept.has(path.dirname(name))) kept.set(name, ino);
    }
    this.names = kept;
    this.durableNames = new Map(this.names);
    for (const inode of this.files.values()) inode.nlink = 0;
    for (const ino of this.names.values()) this.files.get(ino)!.nlink++;
  }

  /** What another program can do to a file meanwhile. Each change is durable at once. */
  readonly outside = {
    append: (file: string, text: string) => this.outsideWrite(file, (data) => concat(data, encode(text))),
    /** Same length, different bytes: only a hash of the content notices. */
    rewrite: (file: string, text: string) => this.outsideWrite(file, () => encode(text)),
    truncate: (file: string, length: number) => this.outsideWrite(file, (data) => data.slice(0, length)),
    /** A new file renamed over the old name, as editors save: open handles keep the old one. */
    replace: (file: string, text: string) => {
      const inode = this.mkInode("file");
      const created = this.files.get(inode)!;
      created.data = created.durable = encode(text);
      this.unlinkName(file);
      this.names.set(file, inode);
      this.durableNames.set(file, inode);
      created.nlink = 1;
    },
    remove: (file: string) => {
      this.unlinkName(file);
      this.durableNames.delete(file);
    },
  };

  /** The bytes a name holds now, or undefined: for assertions, outside any process. */
  read(file: string): string | undefined {
    const ino = this.names.get(path.normalize(file));
    const inode = ino === undefined ? undefined : this.files.get(ino);
    return inode?.kind === "file" ? new TextDecoder().decode(inode.data) : undefined;
  }

  /** Every file's path, sorted. */
  list(): string[] {
    return [...this.names]
      .filter(([, ino]) => this.files.get(ino)!.kind === "file")
      .map(([name]) => name)
      .sort();
  }

  // --- internals ---

  /** Before each operation: fails one from a crashed process, and runs a scheduled crash when it is due. */
  private step(generation: number, message: string): void {
    if (this.countdown !== undefined && generation === this.generation && this.countdown-- === 0) this.crash();
    if (generation !== this.generation) throw errno("EIO", message);
  }

  private survivor(inode: Inode): Uint8Array {
    const { data, durable } = inode;
    if (equal(data, durable)) return data;
    if (startsWith(data, durable)) {
      // Appended to since the last sync: some prefix of the new bytes reached the disk, perhaps then zeros.
      // Mostly all or none, as whole pages reach the disk; otherwise anywhere, mid-line included.
      const pending = data.length - durable.length;
      const draw = this.random();
      const kept = draw < 0.35 ? 0 : draw < 0.7 ? pending : Math.floor(this.random() * (pending + 1));
      const zeros = this.random() < 0.25 ? Math.floor(this.random() * (pending - kept + 1)) : 0;
      return concat(durable, data.slice(durable.length, durable.length + kept), new Uint8Array(zeros));
    }
    // Truncated or overwritten since the last sync: either state may be on the disk.
    return this.random() < 0.5 ? durable : data;
  }

  private fault(operation: keyof Faults, code: string): void {
    const probability = this.faults[operation] ?? 0;
    if (probability > 0 && this.random() < probability) {
      this.injected.set(operation, (this.injected.get(operation) ?? 0) + 1);
      throw errno(code, `injected ${operation} fault`);
    }
  }

  private mkInode(kind: Inode["kind"]): number {
    const ino = this.nextIno++;
    this.files.set(ino, { ino, kind, data: new Uint8Array(), durable: new Uint8Array(), nlink: 0, mtimeMs: this.tick() });
    return ino;
  }

  private tick(): number {
    return ++this.clock;
  }

  private inodeAt(file: string, operation: string): Inode {
    const name = path.normalize(file);
    const ino = this.names.get(name);
    if (ino === undefined) throw errno("ENOENT", `${operation} '${name}'`);
    return this.files.get(ino)!;
  }

  private fileAt(file: string, operation: string): Inode {
    const inode = this.inodeAt(file, operation);
    if (inode.kind !== "file") throw errno("EISDIR", `${operation} '${file}'`);
    return inode;
  }

  private parentOf(file: string, operation: string): string {
    const dir = path.dirname(path.normalize(file));
    const ino = this.names.get(dir);
    if (ino === undefined) throw errno("ENOENT", `${operation} '${file}'`);
    if (this.files.get(ino)!.kind !== "dir") throw errno("ENOTDIR", `${operation} '${file}'`);
    return dir;
  }

  private statOf(inode: Inode): FileStats {
    return { size: inode.data.length, mtimeMs: inode.mtimeMs, ino: inode.ino, nlink: inode.nlink };
  }

  private open(file: string, flags: string | number, _mode: number | undefined, generation: number): FileHandle {
    const name = path.normalize(file);
    const mode = parseFlags(flags);
    this.fault("open", "EMFILE");
    let ino = this.names.get(name);
    if (ino !== undefined && mode.exclusive) throw errno("EEXIST", `open '${name}'`);
    if (ino === undefined) {
      if (!mode.create) throw errno("ENOENT", `open '${name}'`);
      this.parentOf(name, "open");
      ino = this.mkInode("file");
      this.names.set(name, ino);
      this.files.get(ino)!.nlink = 1;
    }
    const inode = this.files.get(ino)!;
    if (inode.kind === "dir" && mode.write) throw errno("EISDIR", `open '${name}'`);
    if (mode.truncate) this.change(inode, new Uint8Array());
    let closed = false;
    const live = () => {
      this.step(generation, "the process that opened this file crashed");
      if (closed) throw errno("EBADF", "file handle closed");
    };
    const op = <A>(operation: () => A): Promise<A> => Promise.resolve().then(() => (live(), operation()));
    const append = (bytes: Uint8Array) => {
      // A full disk can take part of a write before failing.
      if ((this.faults.write ?? 0) > 0 && this.random() < this.faults.write!) {
        this.injected.set("write", (this.injected.get("write") ?? 0) + 1);
        this.change(inode, concat(inode.data, bytes.slice(0, Math.floor(this.random() * bytes.length))));
        throw errno("ENOSPC", "injected write fault");
      }
      this.change(inode, concat(inode.data, bytes));
    };
    return {
      read: (buffer, offset, length, position) =>
        op(() => {
          const bytes = inode.data.subarray(position, position + length);
          buffer.set(bytes, offset);
          return { bytesRead: bytes.length };
        }),
      appendFile: (text) => op(() => append(encode(text))),
      writeFile: (text) =>
        op(() => {
          this.change(inode, new Uint8Array());
          append(encode(text));
        }),
      chmod: () => op(() => undefined),
      stat: () => op(() => this.statOf(inode)),
      truncate: (length) =>
        op(() => {
          this.fault("truncate", "EIO");
          this.change(inode, inode.data.slice(0, length));
        }),
      datasync: () =>
        op(() => {
          // A failed sync leaves it unknown what reached the disk: nothing is promised.
          this.fault("sync", "EIO");
          inode.durable = inode.data;
        }),
      sync: () =>
        op(() => {
          this.fault("sync", "EIO");
          if (inode.kind === "file") inode.durable = inode.data;
          else this.syncDirectory(name);
        }),
      close: () =>
        op(() => {
          closed = true;
        }),
    };
  }

  private change(inode: Inode, data: Uint8Array): void {
    inode.data = data;
    inode.mtimeMs = this.tick();
  }

  private syncDirectory(dir: string): void {
    const inDir = (name: string) => name !== "/" && path.dirname(name) === dir;
    for (const name of this.durableNames.keys()) if (inDir(name) && !this.names.has(name)) this.durableNames.delete(name);
    for (const [name, ino] of this.names) if (inDir(name)) this.durableNames.set(name, ino);
  }

  private readdir(dir: string): string[] {
    const name = path.normalize(dir);
    const inode = this.inodeAt(name, "scandir");
    if (inode.kind !== "dir") throw errno("ENOTDIR", `scandir '${name}'`);
    return [...this.names.keys()]
      .filter((entry) => entry !== "/" && path.dirname(entry) === name)
      .map((entry) => path.basename(entry))
      .sort();
  }

  /** As Node's: with `recursive`, the first directory it created, if any. */
  private mkdir(dir: string, recursive: boolean): string | undefined {
    const name = path.normalize(dir);
    const existing = this.names.get(name);
    if (existing !== undefined) {
      if (recursive && this.files.get(existing)!.kind === "dir") return undefined;
      throw errno("EEXIST", `mkdir '${name}'`);
    }
    const first = recursive && !this.names.has(path.dirname(name)) ? this.mkdir(path.dirname(name), true) : undefined;
    this.parentOf(name, "mkdir");
    const ino = this.mkInode("dir");
    this.names.set(name, ino);
    this.files.get(ino)!.nlink = 1;
    return first ?? name;
  }

  private rename(from: string, to: string): void {
    const source = path.normalize(from);
    const target = path.normalize(to);
    this.fault("rename", "EIO");
    const ino = this.names.get(source);
    if (ino === undefined) throw errno("ENOENT", `rename '${source}' -> '${target}'`);
    this.parentOf(target, "rename");
    this.unlinkName(target);
    this.names.delete(source);
    this.names.set(target, ino);
  }

  private link(existing: string, file: string): void {
    const source = path.normalize(existing);
    const target = path.normalize(file);
    const ino = this.names.get(source);
    if (ino === undefined) throw errno("ENOENT", `link '${source}' -> '${target}'`);
    if (this.names.has(target)) throw errno("EEXIST", `link '${source}' -> '${target}'`);
    this.parentOf(target, "link");
    this.names.set(target, ino);
    this.files.get(ino)!.nlink++;
  }

  private rm(file: string, force: boolean): void {
    const name = path.normalize(file);
    const ino = this.names.get(name);
    if (ino === undefined) {
      if (force) return;
      throw errno("ENOENT", `rm '${name}'`);
    }
    if (this.files.get(ino)!.kind === "dir") throw errno("EISDIR", `rm '${name}'`);
    this.unlinkName(name);
  }

  private unlinkName(name: string): void {
    const ino = this.names.get(name);
    if (ino === undefined) return;
    this.names.delete(name);
    const inode = this.files.get(ino)!;
    inode.nlink = Math.max(0, inode.nlink - 1);
  }

  private outsideWrite(file: string, change: (data: Uint8Array) => Uint8Array): void {
    const inode = this.fileAt(file, "outside");
    this.change(inode, change(inode.data));
    inode.durable = inode.data;
  }
}

/** Probabilities, each 0 to 1, that an operation of a kind fails. */
export interface Faults {
  /** ENOSPC, after writing part of the bytes. */
  write?: number;
  /** EIO from `datasync`/`sync`; nothing more becomes durable. */
  sync?: number;
  truncate?: number;
  rename?: number;
  /** EMFILE. */
  open?: number;
}

interface Inode {
  readonly ino: number;
  readonly kind: "file" | "dir";
  data: Uint8Array;
  /** What a crash keeps, at least. */
  durable: Uint8Array;
  nlink: number;
  mtimeMs: number;
}

function parseFlags(flags: string | number): { write: boolean; create: boolean; exclusive: boolean; truncate: boolean } {
  if (typeof flags === "number") {
    const write = (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0;
    return { write, create: (flags & constants.O_CREAT) !== 0, exclusive: (flags & constants.O_EXCL) !== 0, truncate: (flags & constants.O_TRUNC) !== 0 };
  }
  switch (flags) {
    case "r":
      return { write: false, create: false, exclusive: false, truncate: false };
    case "r+":
      return { write: true, create: false, exclusive: false, truncate: false };
    case "a":
    case "a+":
      return { write: true, create: true, exclusive: false, truncate: false };
    case "ax":
    case "ax+":
    case "wx":
    case "wx+":
      return { write: true, create: true, exclusive: true, truncate: flags.startsWith("w") };
    case "w":
    case "w+":
      return { write: true, create: true, exclusive: false, truncate: true };
    default:
      throw new Error(`SimDisk: unsupported open flags "${flags}"`);
  }
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && startsWith(a, b);
}

/** A seeded random source (mulberry32): the same seed, the same crashes and faults. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
