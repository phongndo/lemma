import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Effect, Either } from "effect";
import { SessionError } from "@lemma/contracts";
import type { SessionEvent, SessionInfo } from "@lemma/contracts";
import { decodeLine, encodeLine } from "./format.ts";
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

/** Complete lines of a file and where they end. Bytes after the last newline are a torn write and are ignored. */
function splitComplete(buffer: Buffer): { readonly lines: string[]; readonly validBytes: number } {
  const end = buffer.lastIndexOf(0x0a) + 1;
  const text = buffer.subarray(0, end).toString("utf8");
  const lines = text.split("\n");
  lines.pop();
  return { lines, validBytes: end };
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
  /** Length of the file's complete lines; a longer file has a torn tail to cut before appending. */
  readonly validBytes: number;
  readonly size: number;
}

/**
 * Reads and validates a whole session. Any unreadable complete line, an event
 * whose parent is unknown, or a checkout to nowhere is `Corrupt`: skipping one
 * would silently change what the model saw.
 */
export function load(file: string, sessionId: string): Effect.Effect<Loaded, SessionError> {
  return Effect.tryPromise({ try: () => fs.readFile(file), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
    Effect.flatMap((buffer) =>
      Effect.suspend(() => {
        const { lines, validBytes } = splitComplete(buffer);
        if (lines.length === 0) return Effect.fail(corrupt(sessionId, file, "missing header"));
        const first = decodeLine(lines[0]!, true);
        if (Either.isLeft(first)) return Effect.fail(corrupt(sessionId, file, `unreadable header (${first.left})`));
        const header = first.right as Header;
        const events: SessionEvent[] = [];
        const byId = new Map<string, SessionEvent>();
        let leaf: string | undefined;
        let title: string | undefined;
        let marks = unfiled;
        let updatedAt = header.createdAt;
        for (let i = 1; i < lines.length; i++) {
          const decoded = decodeLine(lines[i]!, false);
          if (Either.isLeft(decoded)) return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: ${decoded.left}`));
          const line = decoded.right as Exclude<Line, Header>;
          if ("type" in line && line.type === "marks") {
            marks = applyMarks(marks, line);
            continue;
          }
          if ("type" in line) {
            if (!byId.has(line.leaf)) return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: checkout to unknown event ${line.leaf}`));
            leaf = line.leaf;
            updatedAt = Math.max(updatedAt, line.at);
            continue;
          }
          if (line.seq !== events.length + 1)
            return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: expected seq ${events.length + 1}, found ${line.seq}`));
          if (byId.has(line.id)) return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: duplicate event id ${line.id}`));
          if (line.parent !== null && !byId.has(line.parent)) return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: unknown parent ${line.parent}`));
          events.push(line);
          byId.set(line.id, line);
          leaf = line.id;
          if (line.data.type === "title") title = line.data.title;
          updatedAt = Math.max(updatedAt, line.at);
        }
        return Effect.succeed({ header, events, byId, leaf, title, marks, updatedAt, validBytes, size: buffer.length });
      }),
    ),
  );
}

/**
 * The `SessionInfo` a file describes, from `JSON.parse` alone: `list` calls
 * this for every changed file, so it skips schema validation. A full `load`
 * still validates before anything is appended.
 */
export function scan(file: string, sessionId: string): Effect.Effect<SessionInfo, SessionError> {
  return Effect.tryPromise({ try: () => fs.readFile(file), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
    Effect.flatMap((buffer) =>
      Effect.suspend(() => {
        const { lines } = splitComplete(buffer);
        const first = lines.length === 0 ? Either.left("missing header") : decodeLine(lines[0]!, true);
        if (Either.isLeft(first)) return Effect.fail(corrupt(sessionId, file, `unreadable header (${first.left})`));
        const header = first.right as Header;
        let leaf: string | undefined;
        let title: string | undefined;
        let marks = unfiled;
        let updatedAt = header.createdAt;
        let lastSeq = 0;
        for (let i = 1; i < lines.length; i++) {
          let line: {
            type?: string;
            leaf?: string;
            id?: string;
            seq?: number;
            at?: number;
            data?: { type?: string; title?: string };
            pinned?: boolean;
            archived?: boolean;
          };
          try {
            line = JSON.parse(lines[i]!);
          } catch {
            return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: not JSON`));
          }
          if (typeof line !== "object" || line === null || Array.isArray(line)) {
            return Effect.fail(corrupt(sessionId, file, `line ${i + 1}: not a record`));
          }
          if (line.type === "marks") {
            marks = applyMarks(marks, line);
            continue;
          }
          if (typeof line.at === "number") updatedAt = Math.max(updatedAt, line.at);
          if (line.type === "checkout") {
            leaf = line.leaf;
            continue;
          }
          leaf = line.id;
          lastSeq = line.seq ?? lastSeq;
          if (line.data?.type === "title") title = line.data.title;
        }
        return Effect.succeed(infoOf(header, { leaf, title, marks, updatedAt, lastSeq }));
      }),
    ),
  );
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
 * never confirmed); the next write first truncates back to the last confirmed
 * line, so the file keeps matching what callers were told was appended.
 */
export interface Writer {
  readonly write: (line: Line) => Effect.Effect<void, SessionError>;
  /** Cuts what a failed write left, so the file ends at the last confirmed line again; due before a reload reads it. */
  readonly settle: Effect.Effect<void, SessionError>;
  readonly close: Effect.Effect<void>;
}

const writerFor = (handle: fs.FileHandle, file: string, sessionId: string, confirmed: number): Writer => {
  let end = confirmed;
  let dirty = false;
  const cut = async () => {
    if (!dirty) return;
    await handle.truncate(end);
    await handle.datasync();
    dirty = false;
  };
  return {
    write: (line) =>
      Effect.tryPromise({
        try: async () => {
          await cut();
          const text = encodeLine(line);
          dirty = true;
          await handle.appendFile(text);
          await handle.datasync();
          dirty = false;
          end += Buffer.byteLength(text);
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
