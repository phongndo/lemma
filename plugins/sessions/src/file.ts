import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Either } from "effect";
import { SessionError } from "@lemma/contracts";
import type { SessionEvent, SessionInfo } from "@lemma/contracts";
import { decodeRecord, encodeLine } from "./format.ts";
import type { Header, Line, Marks } from "./format.ts";

export const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : undefined;

export const io = (sessionId: string | undefined, message: string) => (cause: unknown) =>
  new SessionError({
    ...(sessionId === undefined ? {} : { sessionId }),
    reason: "Io",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

const corrupt = (sessionId: string, file: string, message: string) => new SessionError({ sessionId, reason: "Corrupt", message: `${file}: ${message}` });

/** What reading a file saw. */
export interface Extent {
  /** End of the last line taken; bytes after it are a torn write. */
  readonly validBytes: number;
  /** Bytes read in all. */
  readonly size: number;
}

const CHUNK = 1 << 20;

/**
 * Calls `visit` with each complete line, and the byte it starts at, reading a
 * chunk at a time: no string ever holds the whole file, so one too big for a
 * single string still reads. `visit` returning false stops the read. Bytes
 * after the last newline are not a line.
 */
async function readLines(file: string, visit: (text: string, start: number) => boolean): Promise<Extent> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    // Small files get a small buffer: a cold `list` reads many at once.
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1 << 16, size)));
    /** The current line's bytes from earlier chunks. */
    let carried: Buffer[] = [];
    let position = 0;
    let lineStart = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return { validBytes: lineStart, size: position };
      const view = chunk.subarray(0, bytesRead);
      let at = 0;
      for (let newline = view.indexOf(0x0a); newline !== -1; newline = view.indexOf(0x0a, at)) {
        const text = carried.length === 0 ? view.toString("utf8", at, newline) : Buffer.concat([...carried, view.subarray(at, newline)]).toString("utf8");
        carried = [];
        const start = lineStart;
        at = newline + 1;
        lineStart = position + at;
        if (!visit(text, start)) return { validBytes: lineStart, size: position + bytesRead };
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
 * The lines of a file as JSON, to `visit` in order. A last line that is not
 * JSON is a write a crash cut short (a power loss can leave one ending in a
 * newline), so it is left out of `validBytes` like a torn tail; one with lines
 * after it is damage. Returns why reading stopped, if it failed.
 */
async function readJson(
  file: string,
  visit: (json: unknown, line: number) => string | undefined,
): Promise<{ readonly extent: Extent; readonly failure?: string }> {
  let line = 0;
  let failure: string | undefined;
  let unreadable: { readonly line: number; readonly start: number } | undefined;
  const extent = await readLines(file, (text, start) => {
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
    return failure === undefined;
  });
  if (failure !== undefined) return { extent, failure };
  return { extent: unreadable === undefined ? extent : { ...extent, validBytes: unreadable.start } };
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

export interface Loaded {
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
    return Effect.tryPromise({ try: () => readJson(file, visit), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
      Effect.flatMap(({ extent, failure }) => {
        if (failure !== undefined) return Effect.fail(corrupt(sessionId, file, failure));
        // The header is synced before `create` returns, so a file without one was never a session.
        if (header === undefined) return Effect.fail(corrupt(sessionId, file, extent.size === 0 ? "missing header" : "unreadable header"));
        return Effect.succeed({ header, events, byId, leaf, title, marks, updatedAt, validBytes: extent.validBytes, size: extent.size });
      }),
    );
  });
}

/**
 * The `SessionInfo` a file describes, from `JSON.parse` alone: `list` calls
 * this for every changed file, so it skips schema validation. A full `load`
 * still validates before anything is appended.
 */
export function scan(file: string, sessionId: string): Effect.Effect<SessionInfo, SessionError> {
  return Effect.suspend(() => {
    let header: Header | undefined;
    let leaf: string | undefined;
    let title: string | undefined;
    let marks = unfiled;
    let updatedAt = 0;
    let lastSeq = 0;
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
    return Effect.tryPromise({ try: () => readJson(file, visit), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
      Effect.flatMap(({ extent, failure }) => {
        if (failure !== undefined) return Effect.fail(corrupt(sessionId, file, failure));
        if (header === undefined) return Effect.fail(corrupt(sessionId, file, extent.size === 0 ? "missing header" : "unreadable header"));
        return Effect.succeed(infoOf(header, { leaf, title, marks, updatedAt, lastSeq }));
      }),
    );
  });
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
 * told was appended.
 */
export interface Writer {
  readonly write: (line: Line) => Effect.Effect<void, SessionError>;
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
    write: (line) =>
      Effect.tryPromise({
        try: async () => {
          await cut();
          const text = encodeLine(line);
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
        catch: io(sessionId, `Cannot write ${file}`),
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
  }).pipe(Effect.map((handle) => writerFor(handle, file, header.id, Buffer.byteLength(encodeLine(header)))));
}

/** Opens an existing file for appending, first cutting a torn final line so the next record starts on its own line. */
export function openFile(file: string, sessionId: string, validBytes: number): Effect.Effect<Writer, SessionError> {
  return Effect.tryPromise({
    try: async () => {
      const handle = await fs.open(file, "a");
      try {
        const { size } = await handle.stat();
        if (size > validBytes) {
          await handle.truncate(validBytes);
          await handle.datasync();
        }
      } catch (cause) {
        await handle.close();
        throw cause;
      }
      return handle;
    },
    catch: io(sessionId, `Cannot open ${file}`),
  }).pipe(Effect.map((handle) => writerFor(handle, file, sessionId, validBytes)));
}
