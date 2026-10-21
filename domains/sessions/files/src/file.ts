import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as path from "node:path";
import { Effect, Result } from "effect";
import { searchLog, SessionError } from "@lemma/sessions";
import type { Contribution, SessionEvent, SessionInfo, SessionSearchMatch } from "@lemma/sessions";
import { errorCode, syncDirectory, syncParents, unsupportedSync } from "@lemma/contracts/fs";
import type { FileHandle, FileSystem } from "@lemma/contracts/fs";
import { decodeRecord, encodeLine, FORMAT_VERSION } from "./format.ts";
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
 * Where the last complete line among the bytes from `from` to `size` starts (after the newline before the last one), or
 * `size` when there is none: the one line a crash can have left torn.
 */
async function lastLineStart(handle: FileHandle, from: number, size: number): Promise<number> {
  let newlines = 0;
  // From the end back, in blocks that double from 4 KiB: most last lines are short, a few are an image.
  for (let end = size, length = 1 << 12; end > from; length = Math.min(length * 2, CHUNK)) {
    const start = Math.max(from, end - length);
    const block = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(block, 0, block.length, start);
    for (let i = bytesRead - 1; i >= 0; i--) if (block[i] === 0x0a && ++newlines === 2) return start + i + 1;
    end = start;
  }
  return newlines === 1 ? from : size;
}

/**
 * Calls `visit` with each complete line's bytes from byte `from` on (valid only during the call), and the byte it
 * starts at, reading a chunk at a time: no string ever holds the whole file, so one too big for a single string still
 * reads. With `followed`, `visit` is told of each line whether a later one followed it when the file was opened, so it
 * cannot be a write a crash cut short. `visit` returning false stops the read. Bytes after the last newline are not a
 * line.
 */
async function readLines(
  fs: FileSystem,
  file: string,
  from: number,
  visit: (bytes: Buffer, start: number, followed: boolean) => boolean,
  followed = false,
): Promise<Extent & Stamp> {
  const handle = await fs.open(file, "r");
  try {
    const { mtimeMs, ino, size } = await handle.stat();
    const last = followed ? await lastLineStart(handle, from, size) : from;
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
        const bytes = carried.length === 0 ? view.subarray(at, newline) : Buffer.concat([...carried, view.subarray(at, newline)]);
        carried = [];
        const start = lineStart;
        at = newline + 1;
        lineStart = position + at;
        if (!visit(bytes, start, start < last)) return { validBytes: lineStart, size: position + bytesRead, mtimeMs, ino };
      }
      // The chunk is reused, so a line it ends inside is copied out.
      if (at < bytesRead) carried.push(Buffer.from(view.subarray(at)));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** An event line's leading fields, read from its first bytes (`eventHead`) rather than by parsing the line. */
export interface EventHead {
  readonly seq: number;
  readonly id: string;
  readonly parent: string | null;
  readonly at: number;
  /** `data.type`. */
  readonly type: string;
  /** A message's `role`. */
  readonly role?: string;
}

/**
 * How an event line this store writes begins: `encodeLine` of a decoded event, its fields in the schema's order (`seq`,
 * `id`, `parent`, `at`, then `data`, whose `type` comes first, as a message's `role` does). Ids are url-safe, so they
 * hold nothing JSON escapes. A line that begins any other way (another writer's) is parsed instead.
 */
const HEAD = /^\{"seq":(\d+),"id":"([\w-]+)","parent":(?:null|"([\w-]+)"),"at":(\d+),"data":\{"type":"([a-z-]+)"(?:,"message":\{"role":"([A-Za-z]+)")?/;
/** How much of a line `eventHead` reads: more than any head this store writes. */
const HEAD_BYTES = 256;

const eventHead = (bytes: Buffer): EventHead | undefined => {
  const match = HEAD.exec(bytes.toString("latin1", 0, Math.min(bytes.length, HEAD_BYTES)));
  if (match === null) return undefined;
  const [, seq, id, parent, at, type, role] = match;
  return { seq: Number(seq), id: id!, parent: parent ?? null, at: Number(at), type: type!, ...(role === undefined ? {} : { role }) };
};

/**
 * What a reader does with the event lines it need not parse (`readJson`): `take` says from a line's head whether the
 * head is enough, and `visit` then reads that line from it, and from its bytes (valid only during the call) if it wants
 * more. Reading a head is a few times cheaper than parsing a short line, and costs the same for a long one.
 */
interface Sniffing {
  readonly take: (head: EventHead) => boolean;
  readonly visit: (head: EventHead, bytes: Buffer, line: number) => string | undefined;
}

/**
 * The lines of a file from byte `from` (line `lines + 1`) on, as JSON, to
 * `visit` in order. A last line that is not JSON is a write a crash cut short
 * (a power loss can leave one ending in a newline), so it is left out of
 * `validBytes` like a torn tail; one with lines after it is damage. Returns
 * the lines taken in all and the last of them, and if reading failed why, and
 * where the line it failed on is (`failedAt`): what came before it is sound.
 *
 * With `sniffing`, an event line with a later line after it is not parsed
 * when its head is enough (`Sniffing.take`), so whether the rest of it is JSON
 * goes unchecked. The last line is always parsed: it is the one a crash can
 * have torn.
 */
async function readJson(
  fs: FileSystem,
  file: string,
  from: { readonly validBytes: number; readonly lines: number } & Partial<LastLine>,
  visit: (json: unknown, line: number) => string | undefined,
  sniffing?: Sniffing,
): Promise<{
  readonly extent: Extent & Stamp;
  readonly lines: number;
  readonly last?: LastLine;
  readonly failure?: string;
  readonly failedAt?: { readonly line: number; readonly start: number };
}> {
  let line = from.lines;
  let failure: string | undefined;
  let failedAt: { readonly line: number; readonly start: number } | undefined;
  let unreadable: { readonly line: number; readonly start: number } | undefined;
  /** The last line taken: where it starts, its length, and its text unless it was sniffed (then read again for its hash). */
  let lastStart = -1;
  let lastLength = 0;
  let lastText: string | undefined;
  const extent = await readLines(
    fs,
    file,
    from.validBytes,
    (bytes, start, followed) => {
      line++;
      if (unreadable !== undefined) {
        failure = `line ${unreadable.line}: not JSON`;
        failedAt = unreadable;
        return false;
      }
      const head = sniffing !== undefined && followed ? eventHead(bytes) : undefined;
      let text: string | undefined;
      if (head !== undefined && sniffing!.take(head)) failure = sniffing!.visit(head, bytes, line);
      else {
        text = bytes.toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          unreadable = { line, start };
          return true;
        }
        failure = visit(json, line);
      }
      if (failure !== undefined) {
        failedAt = { line, start };
        return false;
      }
      lastStart = start;
      lastLength = bytes.length;
      lastText = text;
      return true;
    },
    sniffing !== undefined,
  );
  if (lastStart >= 0 && lastText === undefined) lastText = await readText(fs, file, lastStart, lastLength);
  const lastLine =
    lastStart >= 0
      ? { lastStart, lastHash: lineHash(lastText!) }
      : from.lastStart !== undefined && from.lastHash !== undefined
        ? { lastStart: from.lastStart, lastHash: from.lastHash }
        : undefined;
  const taken = lastLine === undefined ? {} : { last: lastLine };
  if (failure !== undefined && failedAt !== undefined) return { extent, lines: failedAt.line - 1, failure, failedAt, ...taken };
  if (unreadable === undefined) return { extent, lines: line, ...taken };
  return { extent: { ...extent, validBytes: unreadable.start }, lines: unreadable.line - 1, ...taken };
}

/** `length` bytes of `file` from byte `start`, as text. */
async function readText(fs: FileSystem, file: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, start);
    return bytes.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Whether the line `from` read last is still there, unchanged and complete, so reading on from it is sound. */
async function lastLineHolds(fs: FileSystem, file: string, from: Scanned): Promise<boolean> {
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

/** What opening a file to write answers when it is read-only: archived, another user's, on a read-only mount. */
const READ_ONLY = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Makes a session's last line durable before it is served. Each write is one line, and one whose sync failed is cut
 * before the next, so only the last line can be one whose sync and cut both failed (a failing disk): still readable,
 * from the page cache, but not durable. A sync alone would not write it, as Linux marks the pages of a failed writeback
 * clean; so it is written again, as it reads, then synced. A file that cannot be opened to write is served as it is, and
 * a sync the platform does not support is skipped, as `syncDirectory` skips one; any other failure, such as EIO, is
 * thrown. Due once per file per process: the sessions lock keeps any other Lemma process out meanwhile.
 */
export const confirmLast = async (fs: FileSystem, file: string, from: Pick<Scanned, "lastStart" | "validBytes">) => {
  const length = from.validBytes - from.lastStart;
  if (from.lastStart < 0 || length <= 0) return;
  const handle = await fs.open(file, "r+").catch((cause) => {
    if (!READ_ONLY.has(errorCode(cause) ?? "")) throw cause;
  });
  if (handle === undefined) return;
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, from.lastStart);
    await handle.write(bytes, 0, bytesRead, from.lastStart);
    await handle.datasync().catch(unsupportedSync);
  } finally {
    await handle.close();
  }
};

/** Where a session is filed: the latest value of each mark, and the directory it was moved to, if it was. */
export interface FiledAs {
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly kept: boolean;
  readonly cwd?: string;
}

export const unfiled: FiledAs = { pinned: false, archived: false, kept: false };

export const applyMarks = (filed: FiledAs, marks: Pick<Marks, "pinned" | "archived" | "kept" | "cwd">): FiledAs => {
  const cwd = marks.cwd ?? filed.cwd;
  return {
    pinned: marks.pinned ?? filed.pinned,
    archived: marks.archived ?? filed.archived,
    kept: marks.kept ?? filed.kept,
    ...(cwd === undefined ? {} : { cwd }),
  };
};

/** Where a session's log stops reading: the line, and why. What comes before it is served, read-only. */
export interface Damage {
  readonly line: number;
  readonly reason: string;
}

/**
 * `event`, its request's contributions the array `previous` when they are the same: an agent logs every request's in
 * full, and most repeat the last ones, so one array for all of them keeps a long session's heap about a tenth smaller.
 * Sound, as an event is never changed once read.
 */
export const shareContributions = (event: SessionEvent, previous: readonly Contribution[] | undefined): SessionEvent => {
  const data = event.data;
  if (data.type !== "request" || previous === undefined || data.contributions === previous || data.contributions.length !== previous.length) return event;
  const same = data.contributions.every((part, i) => {
    const before = previous[i]!;
    return part.source === before.source && part.kind === before.kind && part.label === before.label && part.chars === before.chars;
  });
  return same ? { ...event, data: { ...data, contributions: previous } } : event;
};

interface Loaded {
  readonly header: Header;
  readonly events: SessionEvent[];
  readonly byId: Map<string, SessionEvent>;
  /** The last request's contributions, which the next one most often repeats (`shareContributions`). */
  readonly contributions: readonly Contribution[] | undefined;
  readonly leaf: string | undefined;
  readonly title: string | undefined;
  readonly marks: FiledAs;
  readonly updatedAt: number;
  /** End of the lines taken; a longer file has a torn tail to cut before appending. */
  readonly validBytes: number;
  readonly size: number;
  /** What `list` would know of the file after this read. */
  readonly scanned: Scanned;
  /** Set when a complete line does not read: the session is what came before it, and takes no writes. */
  readonly damage?: Damage;
}

/**
 * Reads and validates a whole session. Any unreadable complete line but the
 * last, an event whose parent is unknown, a seq gap, a duplicate id, or a
 * checkout to nowhere is damage: skipping it and reading on would silently
 * change what the model saw, so the session is what came before it, read-only
 * (`damage`). A file whose header does not read is `Corrupt`: nothing of it is
 * known to be a session.
 */
export function load(fs: FileSystem, file: string, sessionId: string): Effect.Effect<Loaded, SessionError> {
  return Effect.suspend(() => {
    let header: Header | undefined;
    const events: SessionEvent[] = [];
    const byId = new Map<string, SessionEvent>();
    let leaf: string | undefined;
    let title: string | undefined;
    let marks = unfiled;
    let updatedAt = 0;
    let contributions: readonly Contribution[] | undefined;
    const visit = (json: unknown, n: number): string | undefined => {
      if (header === undefined) {
        const decoded = decodeRecord(json, true);
        if (Result.isFailure(decoded)) return decoded.failure;
        header = decoded.success as Header;
        updatedAt = header.createdAt;
        return undefined;
      }
      const decoded = decodeRecord(json, false);
      if (Result.isFailure(decoded)) return `line ${n}: ${decoded.failure}`;
      const line = decoded.success as Exclude<Line, Header>;
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
      const event = shareContributions(line, contributions);
      events.push(event);
      byId.set(event.id, event);
      leaf = event.id;
      if (event.data.type === "title") title = event.data.title;
      if (event.data.type === "request") contributions = event.data.contributions;
      updatedAt = Math.max(updatedAt, event.at);
      return undefined;
    };
    return Effect.tryPromise({ try: () => readJson(fs, file, { validBytes: 0, lines: 0 }, visit), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
      Effect.flatMap(({ extent: read, lines, last, failure, failedAt }) => {
        // The header is synced before `create` returns, so a file without one was never a session.
        if (header === undefined || last === undefined) {
          return Effect.fail(corrupt(sessionId, file, failure ?? (read.size === 0 ? "missing header" : "unreadable header")));
        }
        // Damaged: the session is what came before the line that does not read, which stays where it is.
        const damage = failure === undefined || failedAt === undefined ? undefined : { line: failedAt.line, reason: failure };
        const extent = damage === undefined ? read : { ...read, validBytes: failedAt!.start };
        const info = infoOf(header, { leaf, title, marks, updatedAt, lastSeq: events.length, ...(damage === undefined ? {} : { damage }) });
        return Effect.succeed({
          header,
          events,
          byId,
          contributions,
          leaf,
          title,
          marks,
          updatedAt,
          validBytes: extent.validBytes,
          size: extent.size,
          scanned: { size: extent.size, mtimeMs: extent.mtimeMs, ino: extent.ino, validBytes: extent.validBytes, lines, ...last, info },
          ...(damage === undefined ? {} : { damage }),
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
export function scan(fs: FileSystem, file: string, sessionId: string, prior?: Scanned): Effect.Effect<Scanned, SessionError> {
  return Effect.tryPromise({
    try: async () => scanFrom(fs, file, prior !== undefined && (await lastLineHolds(fs, file, prior)) ? prior : undefined),
    catch: io(sessionId, `Cannot read ${file}`),
  }).pipe(Effect.flatMap((result) => (typeof result === "string" ? Effect.fail(corrupt(sessionId, file, result)) : Effect.succeed(result))));
}

/** `scan` from `from` (or the start): the scan, or why the file is not a session. */
async function scanFrom(fs: FileSystem, file: string, from: Scanned | undefined): Promise<Scanned | string> {
  let header: Header | undefined =
    from === undefined ? undefined : { type: "session", version: FORMAT_VERSION, id: from.info.id, cwd: from.info.cwd, createdAt: from.info.createdAt };
  let leaf = from?.info.leaf;
  let title = from?.info.title;
  // A moved session's directory is already the header's here (`info.cwd`).
  let marks: FiledAs =
    from === undefined ? unfiled : { pinned: from.info.pinned === true, archived: from.info.archived === true, kept: from.info.kept === true };
  let updatedAt = from?.info.updatedAt ?? 0;
  let lastSeq = from?.info.lastSeq ?? 0;
  const visit = (json: unknown, n: number): string | undefined => {
    if (header === undefined) {
      const decoded = decodeRecord(json, true);
      if (Result.isFailure(decoded)) return decoded.failure;
      header = decoded.success as Header;
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
      kept?: boolean;
      cwd?: string;
    };
    if (line.type === "marks") {
      marks = applyMarks(marks, line);
      return undefined;
    }
    if (line.type === "checkout") {
      if (typeof line.at === "number") updatedAt = Math.max(updatedAt, line.at);
      leaf = line.leaf;
      return undefined;
    }
    const failure = event(line.seq, line.id, line.at, n);
    if (failure === undefined && line.data?.type === "title") title = line.data.title;
    return failure;
  };
  const event = (seq: number | undefined, id: string | undefined, at: number | undefined, n: number): string | undefined => {
    // The one check `load` makes that costs nothing here: a gap would have `list` describe events `load` refuses.
    if (seq !== lastSeq + 1) return `line ${n}: expected seq ${lastSeq + 1}, found ${String(seq)}`;
    if (typeof at === "number") updatedAt = Math.max(updatedAt, at);
    leaf = id;
    lastSeq = seq;
    return undefined;
  };
  // An event line's head says all the listing needs of it but a title's text.
  const sniffing: Sniffing = { take: (head) => head.type !== "title", visit: (head, _, n) => event(head.seq, head.id, head.at, n) };
  const { extent, lines, last, failure, failedAt } = await readJson(fs, file, from ?? { validBytes: 0, lines: 0 }, visit, sniffing);
  if (header === undefined || last === undefined) return failure ?? (extent.size === 0 ? "missing header" : "unreadable header");
  // Damaged: listed as what reads, said to be damaged, so it can be opened read-only and forked rather than vanish.
  const damage = failure === undefined || failedAt === undefined ? undefined : { line: failedAt.line, reason: failure };
  return {
    size: extent.size,
    mtimeMs: extent.mtimeMs,
    ino: extent.ino,
    validBytes: damage === undefined ? extent.validBytes : failedAt!.start,
    lines,
    ...last,
    info: infoOf(header, { leaf, title, marks, updatedAt, lastSeq, ...(damage === undefined ? {} : { damage }) }),
  };
}

/**
 * Whether a message's text holding `word` (lower-cased, as `searchLog` compares) means its line, lower-cased, holds it
 * too, so a line without it need not be parsed: unless the word has a character JSON escapes (a quote, a backslash, a
 * control character, half of a surrogate pair) or a sigma, whose lower case depends on the letter before it.
 */
const foundInLine = (word: string): boolean => {
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    if (code < 0x20 || code === 0x22 || code === 0x5c || (code >= 0xd800 && code <= 0xdfff) || code === 0x3a3 || code === 0x3c2 || code === 0x3c3) return false;
  }
  return true;
};

/**
 * `searchLog` of a session's current branch, read from its file for what a search needs and let go: the branch's shape
 * from every line (seqs, ids, parents, checkouts), and the prompts and replies whose line holds every one of `words`.
 * Every other event line is read from its head (`eventHead`), so a search reads a log for a fraction of what opening it
 * costs. It stops where `load` would at a seq gap, a duplicate id, an unknown parent, a checkout to nowhere, or a prompt
 * or reply that does not decode; a line whose rest is no event, which only `load` checks, it reads past, so a session
 * known to be damaged is searched through `load`. Undefined for a file that is not a session.
 */
export function searchFile(
  fs: FileSystem,
  file: string,
  sessionId: string,
  words: readonly string[],
): Effect.Effect<SessionSearchMatch | undefined, SessionError> {
  return Effect.tryPromise({ try: () => searchFrom(fs, file, sessionId, words), catch: io(sessionId, `Cannot read ${file}`) });
}

async function searchFrom(fs: FileSystem, file: string, sessionId: string, words: readonly string[]): Promise<SessionSearchMatch | undefined> {
  let header = false;
  /** Each event's parent, in file order. */
  const parents = new Map<string, string | null>();
  let leaf: string | undefined;
  /** The prompts and replies that may match, by id. */
  const said = new Map<string, SessionEvent>();
  const filtered = words.every(foundInLine);
  const event = (seq: unknown, id: unknown, parent: unknown, n: number): string | undefined => {
    if (seq !== parents.size + 1) return `line ${n}: expected seq ${parents.size + 1}, found ${String(seq)}`;
    if (typeof id !== "string" || parents.has(id)) return `line ${n}: duplicate event id ${String(id)}`;
    if (parent !== null && (typeof parent !== "string" || !parents.has(parent))) return `line ${n}: unknown parent ${String(parent)}`;
    parents.set(id, parent);
    leaf = id;
    return undefined;
  };
  const message = (json: unknown, n: number): string | undefined => {
    const decoded = decodeRecord(json, false);
    if (Result.isFailure(decoded)) return `line ${n}: ${decoded.failure}`;
    const found = decoded.success as SessionEvent;
    said.set(found.id, found);
    return undefined;
  };
  const visit = (json: unknown, n: number): string | undefined => {
    if (!header) {
      const decoded = decodeRecord(json, true);
      if (Result.isFailure(decoded)) return decoded.failure;
      header = true;
      return undefined;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return `line ${n}: not a record`;
    const line = json as {
      type?: unknown;
      leaf?: unknown;
      seq?: unknown;
      id?: unknown;
      parent?: unknown;
      data?: { type?: unknown; message?: { role?: unknown } };
    };
    if (line.type === "marks") return undefined;
    if (line.type === "checkout") {
      if (typeof line.leaf !== "string" || !parents.has(line.leaf)) return `line ${n}: checkout to unknown event ${String(line.leaf)}`;
      leaf = line.leaf;
      return undefined;
    }
    const failure = event(line.seq, line.id, line.parent, n);
    if (failure !== undefined) return failure;
    const role = line.data?.type === "message" ? line.data.message?.role : undefined;
    return role === "user" || role === "assistant" ? message(json, n) : undefined;
  };
  const sniffing: Sniffing = {
    // A message whose role its head does not say (another writer's layout) is parsed.
    take: (head) => head.type !== "message" || head.role !== undefined,
    visit: (head, bytes, n) => {
      const failure = event(head.seq, head.id, head.parent, n);
      if (failure !== undefined || head.type !== "message" || (head.role !== "user" && head.role !== "assistant")) return failure;
      const text = bytes.toString("utf8");
      if (filtered) {
        const lower = text.toLowerCase();
        if (!words.every((word) => lower.includes(word))) return undefined;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return `line ${n}: not JSON`;
      }
      return message(json, n);
    },
  };
  const { last } = await readJson(fs, file, { validBytes: 0, lines: 0 }, visit, sniffing);
  if (!header || last === undefined) return undefined;
  // The branch from its root to its leaf, of the messages that may match: what `searchLog` would find on the whole branch.
  const branch: SessionEvent[] = [];
  for (let at = leaf; at !== undefined;) {
    const found = said.get(at);
    if (found !== undefined) branch.push(found);
    const parent = parents.get(at);
    at = parent === null ? undefined : parent;
  }
  return searchLog(sessionId, branch.reverse(), words);
}

export const infoOf = (
  header: Header,
  state: {
    readonly leaf: string | undefined;
    readonly title: string | undefined;
    readonly marks: FiledAs;
    readonly updatedAt: number;
    readonly lastSeq: number;
    readonly damage?: Damage;
  },
): SessionInfo => ({
  id: header.id,
  cwd: state.marks.cwd ?? header.cwd,
  createdAt: header.createdAt,
  updatedAt: state.updatedAt,
  ...(state.title === undefined ? {} : { title: state.title }),
  ...(state.leaf === undefined ? {} : { leaf: state.leaf }),
  lastSeq: state.lastSeq,
  ...(state.marks.pinned ? { pinned: true } : {}),
  ...(state.marks.archived ? { archived: true } : {}),
  ...(state.marks.kept ? { kept: true } : {}),
  ...(state.damage === undefined ? {} : { damaged: { line: state.damage.line, reason: state.damage.reason } }),
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

const writerFor = (handle: FileHandle, file: string, sessionId: string, confirmed: number): Writer => {
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
    // `tryPromise`: a failed close is ignored like any other; `promise` would make it a defect.
    close: Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
  };
};

/** Creates a session file with its header. Uninterruptible, so its handle always reaches the writer. */
export function createFile(fs: FileSystem, file: string, header: Header): Effect.Effect<Writer, SessionError> {
  return Effect.tryPromise({
    try: async () => {
      const created = await fs.mkdir(path.dirname(file), { recursive: true });
      // Append mode, like `openFile`: writes land at the end even after a failed write is truncated away.
      const handle = await fs.open(file, "ax");
      try {
        await handle.appendFile(encodeLine(header));
        await handle.datasync();
        await syncDirectory(fs, path.dirname(file));
        await syncParents(fs, path.dirname(file), created);
      } catch (cause) {
        await handle.close();
        // A session reported not created must not be listed. Best effort: a crash could still leave it.
        await fs.rm(file, { force: true }).catch(() => undefined);
        throw cause;
      }
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
export function openFile(
  fs: FileSystem,
  file: string,
  sessionId: string,
  seen: { readonly validBytes: number; readonly size: number },
): Effect.Effect<Writer, SessionError> {
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
