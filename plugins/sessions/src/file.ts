import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Either } from "effect";
import { SessionError } from "@lemma/contracts";
import type { SessionEvent, SessionInfo } from "@lemma/contracts";
import { decodeRecord, encodeLine } from "./format.ts";
import type { Header, Line, Marks } from "./format.ts";

export const io = (sessionId: string | undefined, message: string) => (cause: unknown) =>
  new SessionError({
    ...(sessionId === undefined ? {} : { sessionId }),
    reason: "Io",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

const corrupt = (sessionId: string, file: string, message: string) => new SessionError({ sessionId, reason: "Corrupt", message: `${file}: ${message}` });

/** The `cause` of a `SessionError` saying another program changed the file: what this process read no longer describes it. */
export const CHANGED_ON_DISK = Symbol("changed on disk");

const changedOnDisk = (sessionId: string, file: string, how = "changed on disk since this process read it") =>
  new SessionError({ sessionId, reason: "Io", message: `${file} ${how}: another program wrote to it`, cause: CHANGED_ON_DISK });

/** Keeps a `SessionError` thrown inside a promise; anything else is `Io`. */
const orIo = (sessionId: string, message: string) => (cause: unknown) => (cause instanceof SessionError ? cause : io(sessionId, message)(cause));

/** What reading a file saw. */
interface Extent {
  /** End of the last line taken; bytes after it are a torn write. */
  readonly validBytes: number;
  /** Bytes read in all. */
  readonly size: number;
}

/** A file's identity when it was read: a different size, mtime, or inode means it changed since. */
interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

/** The last line a read took: where it starts, and a hash of its text. */
export interface LastLine {
  readonly lastStart: number;
  readonly lastHash: string;
}

/**
 * What `list` knows of a file: its info as of `validBytes` (`lines` lines),
 * and its stamp when read. Reading on from `validBytes` is only sound while
 * the last line is still the one read, so `lastHash` checks that first: a
 * failed write's line can be replaced after another process read it.
 */
export interface Scanned extends Stamp, LastLine {
  readonly validBytes: number;
  readonly lines: number;
  readonly info: SessionInfo;
}

export const lineHash = (text: string): string => createHash("sha1").update(text).digest("base64");

const CHUNK = 1 << 20;

/**
 * Calls `visit` with each complete line from byte `from` on, and the byte it
 * starts at, reading a chunk at a time: no string ever holds the whole file,
 * so one too big for a single string still reads. `visit` returning false
 * stops the read. Bytes after the last newline are not a line.
 */
async function readLines(file: string, from: number, visit: (text: string, start: number) => boolean): Promise<Extent & Stamp> {
  const handle = await fs.open(file, "r");
  try {
    const { mtimeMs, ino, size } = await handle.stat();
    // Small files get a small buffer: a cold `list` reads many at once.
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1 << 16, size - from)));
    /** The current line's bytes from earlier chunks. */
    let carried: Buffer[] = [];
    let position = from;
    let lineStart = from;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return { validBytes: lineStart, size: position, mtimeMs, ino };
      const view = chunk.subarray(0, bytesRead);
      let at = 0;
      for (let newline = view.indexOf(0x0a); newline !== -1; newline = view.indexOf(0x0a, at)) {
        const text = carried.length === 0 ? view.toString("utf8", at, newline) : Buffer.concat([...carried, view.subarray(at, newline)]).toString("utf8");
        carried = [];
        const start = lineStart;
        at = newline + 1;
        lineStart = position + at;
        if (!visit(text, start)) return { validBytes: lineStart, size: position + bytesRead, mtimeMs, ino };
      }
      // The chunk is reused, so a line it ends inside is copied out.
      if (at < bytesRead) carried.push(Buffer.from(view.subarray(at)));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/**
 * The lines of a file from byte `from` (line `lines + 1`) on, as JSON, to
 * `visit` in order. A last line that is not JSON is a write a crash cut short
 * (a power loss can leave one ending in a newline), so it is left out of
 * `validBytes` like a torn tail; one with lines after it is damage. Returns
 * the lines taken in all, and why reading stopped if it failed.
 */
async function readJson(
  file: string,
  from: { readonly validBytes: number; readonly lines: number } & Partial<LastLine>,
  visit: (json: unknown, line: number) => string | undefined,
): Promise<{ readonly extent: Extent & Stamp; readonly lines: number; readonly last?: LastLine; readonly failure?: string }> {
  let line = from.lines;
  let failure: string | undefined;
  let unreadable: { readonly line: number; readonly start: number } | undefined;
  /** The last line taken: where it starts, and its text. */
  let lastStart = -1;
  let lastText = "";
  const extent = await readLines(file, from.validBytes, (text, start) => {
    line++;
    if (unreadable !== undefined) {
      failure = `line ${unreadable.line}: not JSON`;
      return false;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      unreadable = { line, start };
      return true;
    }
    failure = visit(json, line);
    lastStart = start;
    lastText = text;
    return failure === undefined;
  });
  const lastLine =
    lastStart >= 0
      ? { lastStart, lastHash: lineHash(lastText) }
      : from.lastStart !== undefined && from.lastHash !== undefined
        ? { lastStart: from.lastStart, lastHash: from.lastHash }
        : undefined;
  const taken = lastLine === undefined ? {} : { last: lastLine };
  if (failure !== undefined) return { extent, lines: line, failure, ...taken };
  if (unreadable === undefined) return { extent, lines: line, ...taken };
  return { extent: { ...extent, validBytes: unreadable.start }, lines: unreadable.line - 1, ...taken };
}

/** Whether the line `from` read last is still there, unchanged and complete, so reading on from it is sound. */
async function lastLineHolds(file: string, from: Scanned): Promise<boolean> {
  const length = from.validBytes - from.lastStart;
  if (length <= 0) return false;
  const handle = await fs.open(file, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, from.lastStart);
    return bytesRead === length && bytes[length - 1] === 0x0a && lineHash(bytes.toString("utf8", 0, length - 1)) === from.lastHash;
  } finally {
    await handle.close();
  }
}

/** Where a session is filed: the latest value of each mark. */
export interface FiledAs {
  readonly pinned: boolean;
  readonly archived: boolean;
}

export const unfiled: FiledAs = { pinned: false, archived: false };

export const applyMarks = (filed: FiledAs, marks: Pick<Marks, "pinned" | "archived">): FiledAs => ({
  pinned: marks.pinned ?? filed.pinned,
  archived: marks.archived ?? filed.archived,
});

interface Loaded {
  readonly header: Header;
  readonly events: SessionEvent[];
  readonly byId: Map<string, SessionEvent>;
  readonly leaf: string | undefined;
  readonly title: string | undefined;
  readonly marks: FiledAs;
  readonly updatedAt: number;
  /** End of the lines taken; a longer file has a torn tail to cut before appending. */
  readonly validBytes: number;
  readonly size: number;
  /** What `list` would know of the file after this read. */
  readonly scanned: Scanned;
}

/**
 * Reads and validates a whole session. Any unreadable complete line but the
 * last, an event whose parent is unknown, or a checkout to nowhere is
 * `Corrupt`: skipping one would silently change what the model saw.
 */
export function load(file: string, sessionId: string): Effect.Effect<Loaded, SessionError> {
  return Effect.suspend(() => {
    let header: Header | undefined;
    const events: SessionEvent[] = [];
    const byId = new Map<string, SessionEvent>();
    let leaf: string | undefined;
    let title: string | undefined;
    let marks = unfiled;
    let updatedAt = 0;
    const visit = (json: unknown, n: number): string | undefined => {
      if (header === undefined) {
        const decoded = decodeRecord(json, true);
        if (Either.isLeft(decoded)) return `unreadable header (${decoded.left})`;
        header = decoded.right as Header;
        updatedAt = header.createdAt;
        return undefined;
      }
      const decoded = decodeRecord(json, false);
      if (Either.isLeft(decoded)) return `line ${n}: ${decoded.left}`;
      const line = decoded.right as Exclude<Line, Header>;
      if ("type" in line && line.type === "marks") {
        marks = applyMarks(marks, line);
        return undefined;
      }
      if ("type" in line) {
        if (!byId.has(line.leaf)) return `line ${n}: checkout to unknown event ${line.leaf}`;
        leaf = line.leaf;
        updatedAt = Math.max(updatedAt, line.at);
        return undefined;
      }
      if (line.seq !== events.length + 1) return `line ${n}: expected seq ${events.length + 1}, found ${line.seq}`;
      if (byId.has(line.id)) return `line ${n}: duplicate event id ${line.id}`;
      if (line.parent !== null && !byId.has(line.parent)) return `line ${n}: unknown parent ${line.parent}`;
      events.push(line);
      byId.set(line.id, line);
      leaf = line.id;
      if (line.data.type === "title") title = line.data.title;
      updatedAt = Math.max(updatedAt, line.at);
      return undefined;
    };
    return Effect.tryPromise({ try: () => readJson(file, { validBytes: 0, lines: 0 }, visit), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
      Effect.flatMap(({ extent, lines, last, failure }) => {
        if (failure !== undefined) return Effect.fail(corrupt(sessionId, file, failure));
        // The header is synced before `create` returns, so a file without one was never a session.
        if (header === undefined || last === undefined) {
          return Effect.fail(corrupt(sessionId, file, extent.size === 0 ? "missing header" : "unreadable header"));
        }
        const info = infoOf(header, { leaf, title, marks, updatedAt, lastSeq: events.length });
        return Effect.succeed({
          header,
          events,
          byId,
          leaf,
          title,
          marks,
          updatedAt,
          validBytes: extent.validBytes,
          size: extent.size,
          scanned: { size: extent.size, mtimeMs: extent.mtimeMs, ino: extent.ino, validBytes: extent.validBytes, lines, ...last, info },
        });
      }),
    );
  });
}

/**
 * The `SessionInfo` a file describes, from `JSON.parse` alone: `list` calls
 * this for every changed file, so it skips schema validation. A full `load`
 * still validates before anything is appended. Given what an earlier scan
 * found, it reads only the bytes after it, since the file is only appended
 * to; unless the line that scan read last has changed, as when a failed
 * write's line was replaced.
 */
export function scan(file: string, sessionId: string, prior?: Scanned): Effect.Effect<Scanned, SessionError> {
  return Effect.tryPromise({
    try: async () => scanFrom(file, prior !== undefined && (await lastLineHolds(file, prior)) ? prior : undefined),
    catch: io(sessionId, `Cannot read ${file}`),
  }).pipe(Effect.flatMap((result) => (typeof result === "string" ? Effect.fail(corrupt(sessionId, file, result)) : Effect.succeed(result))));
}

/** `scan` from `from` (or the start): the scan, or why the file is not a session. */
async function scanFrom(file: string, from: Scanned | undefined): Promise<Scanned | string> {
  let header: Header | undefined =
    from === undefined ? undefined : { type: "session", version: 1, id: from.info.id, cwd: from.info.cwd, createdAt: from.info.createdAt };
  let leaf = from?.info.leaf;
  let title = from?.info.title;
  let marks: FiledAs = from === undefined ? unfiled : { pinned: from.info.pinned === true, archived: from.info.archived === true };
  let updatedAt = from?.info.updatedAt ?? 0;
  let lastSeq = from?.info.lastSeq ?? 0;
  const visit = (json: unknown, n: number): string | undefined => {
    if (header === undefined) {
      const decoded = decodeRecord(json, true);
      if (Either.isLeft(decoded)) return `unreadable header (${decoded.left})`;
      header = decoded.right as Header;
      updatedAt = header.createdAt;
      return undefined;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return `line ${n}: not a record`;
    const line = json as {
      type?: string;
      leaf?: string;
      id?: string;
      seq?: number;
      at?: number;
      data?: { type?: string; title?: string };
      pinned?: boolean;
      archived?: boolean;
    };
    if (line.type === "marks") {
      marks = applyMarks(marks, line);
      return undefined;
    }
    if (typeof line.at === "number") updatedAt = Math.max(updatedAt, line.at);
    if (line.type === "checkout") {
      leaf = line.leaf;
      return undefined;
    }
    leaf = line.id;
    lastSeq = line.seq ?? lastSeq;
    if (line.data?.type === "title") title = line.data.title;
    return undefined;
  };
  const { extent, lines, last, failure } = await readJson(file, from ?? { validBytes: 0, lines: 0 }, visit);
  if (failure !== undefined) return failure;
  if (header === undefined || last === undefined) return extent.size === 0 ? "missing header" : "unreadable header";
  return {
    size: extent.size,
    mtimeMs: extent.mtimeMs,
    ino: extent.ino,
    validBytes: extent.validBytes,
    lines,
    ...last,
    info: infoOf(header, { leaf, title, marks, updatedAt, lastSeq }),
  };
}

export const infoOf = (
  header: Header,
  state: {
    readonly leaf: string | undefined;
    readonly title: string | undefined;
    readonly marks: FiledAs;
    readonly updatedAt: number;
    readonly lastSeq: number;
  },
): SessionInfo => ({
  id: header.id,
  cwd: header.cwd,
  createdAt: header.createdAt,
  updatedAt: state.updatedAt,
  ...(state.title === undefined ? {} : { title: state.title }),
  ...(state.leaf === undefined ? {} : { leaf: state.leaf }),
  lastSeq: state.lastSeq,
  ...(state.marks.pinned ? { pinned: true } : {}),
  ...(state.marks.archived ? { archived: true } : {}),
});

/**
 * Append-only handle on one file. Each write is followed by `fdatasync`, so a
 * returned append survives a crash or power loss, not just a process exit.
 * A failed write may leave bytes behind (a torn line, or a whole line that was
 * never confirmed); they are truncated away at once, or failing that before
 * the next write or by `settle`, so the file keeps matching what callers were
 * told was appended. Before each write the file must still be linked and its
 * size what this writer left: anything else means another program changed it
 * (the sessions lock keeps out only other Lemma processes), and the write
 * fails with `CHANGED_ON_DISK` instead of interleaving with it or going to a
 * deleted file.
 */
export interface Writer {
  /** Appends `text`, one encoded line (`encodeLine`). */
  readonly write: (text: string) => Effect.Effect<void, SessionError>;
  /** Cuts what a failed write left, so the file ends at the last confirmed line again; due before a reload reads it. */
  readonly settle: Effect.Effect<void, SessionError>;
  readonly close: Effect.Effect<void>;
}

const writerFor = (handle: fs.FileHandle, file: string, sessionId: string, confirmed: number): Writer => {
  let end = confirmed;
  /** Bytes a failed write may have left after `end`. */
  let unconfirmed = 0;
  const cut = async () => {
    if (unconfirmed === 0) return;
    await handle.truncate(end);
    await handle.datasync();
    unconfirmed = 0;
  };
  return {
    write: (text) =>
      Effect.tryPromise({
        try: async () => {
          const { size, nlink } = await handle.stat();
          if (nlink === 0) throw changedOnDisk(sessionId, file, "was deleted or replaced on disk");
          if (size < end || size > end + unconfirmed) throw changedOnDisk(sessionId, file);
          await cut();
          const bytes = Buffer.byteLength(text);
          unconfirmed = bytes;
          try {
            await handle.appendFile(text);
            await handle.datasync();
          } catch (cause) {
            // So a restart does not find a line whose append failed, should this be the session's last write.
            await cut().catch(() => undefined);
            throw cause;
          }
          unconfirmed = 0;
          end += bytes;
        },
        catch: orIo(sessionId, `Cannot write ${file}`),
      }),
    settle: Effect.tryPromise({ try: cut, catch: io(sessionId, `Cannot write ${file}`) }),
    close: Effect.promise(() => handle.close()).pipe(Effect.ignore),
  };
};

/** Makes a new file's directory entry durable too. Best effort: some platforms cannot fsync a directory. */
const syncDirectory = async (dir: string) => {
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported here; the data itself is still synced.
  }
};

/** Creates a session file with its header. Uninterruptible, so its handle always reaches the writer. */
export function createFile(file: string, header: Header): Effect.Effect<Writer, SessionError> {
  return Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Append mode, like `openFile`: writes land at the end even after a failed write is truncated away.
      const handle = await fs.open(file, "ax");
      try {
        await handle.appendFile(encodeLine(header));
        await handle.datasync();
      } catch (cause) {
        await handle.close();
        throw cause;
      }
      await syncDirectory(path.dirname(file));
      return handle;
    },
    catch: io(header.id, `Cannot create ${file}`),
  }).pipe(
    Effect.map((handle) => writerFor(handle, file, header.id, Buffer.byteLength(encodeLine(header)))),
    Effect.uninterruptible,
  );
}

/**
 * Opens an existing file for appending, first cutting what the read judged
 * torn (`seen` past its `validBytes`) so the next record starts on its own
 * line. A file another program changed since that read is refused
 * (`CHANGED_ON_DISK`): cutting it to `validBytes` would delete what it wrote.
 * Uninterruptible, so the handle always reaches the writer.
 */
export function openFile(file: string, sessionId: string, seen: { readonly validBytes: number; readonly size: number }): Effect.Effect<Writer, SessionError> {
  return Effect.tryPromise({
    try: async () => {
      // Without O_CREAT: a session deleted meanwhile stays deleted.
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND);
      try {
        const { size } = await handle.stat();
        if (size !== seen.size) throw changedOnDisk(sessionId, file);
        if (size > seen.validBytes) {
          await handle.truncate(seen.validBytes);
          await handle.datasync();
        }
      } catch (cause) {
        await handle.close();
        throw cause;
      }
      return handle;
    },
    catch: orIo(sessionId, `Cannot open ${file}`),
  }).pipe(
    Effect.map((handle) => writerFor(handle, file, sessionId, seen.validBytes)),
    Effect.uninterruptible,
  );
}
