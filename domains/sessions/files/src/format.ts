import * as path from "node:path";
import { Result, Schema } from "effect";
import { SessionEvent } from "@lemma/sessions";

/** The format version this store reads and writes; a file of another version says which, rather than "unreadable". */
export const FORMAT_VERSION = 1;

/**
 * One JSONL file per session. Line 1 is the header; every later line is a
 * `SessionEvent`, a checkout record, or a marks record (which may move it). Events have no top-level
 * `type`, so the kinds of line cannot be confused. The file is only ever appended to,
 * except that a torn final line (a crash mid-write) is cut off before the next
 * append.
 */
export const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.Literal(FORMAT_VERSION),
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
});
export type Header = typeof Header.Type;

/** Moves the leaf; written by `checkout` so a reopened session resumes where it was. */
export const Checkout = Schema.Struct({
  type: Schema.Literal("checkout"),
  leaf: Schema.String,
  at: Schema.Number,
});
export type Checkout = typeof Checkout.Type;

/**
 * Pins, archives, or keeps the session, written by `mark`, or moves it to another directory (`cwd`), written by `relocate`;
 * each field present overrides earlier ones. Not an event: it leaves the leaf alone.
 */
export const Marks = Schema.Struct({
  type: Schema.Literal("marks"),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  kept: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.String),
  at: Schema.Number,
});
export type Marks = typeof Marks.Type;

export type Line = Header | Checkout | Marks | SessionEvent;

const decodeHeader = Schema.decodeUnknownResult(Header);
const decodeCheckout = Schema.decodeUnknownResult(Checkout);
const decodeMarks = Schema.decodeUnknownResult(Marks);
const decodeEvent = Schema.decodeUnknownResult(SessionEvent);

export const encodeLine = (line: Line): string => `${JSON.stringify(line)}\n`;

const firstLine = (message: string) => message.split("\n")[0] ?? message;

/** Why a header did not decode: written by another version of the format, or not a header at all. */
const headerFailure = (json: unknown, error: Schema.SchemaError): string => {
  const record = typeof json === "object" && json !== null ? (json as { type?: unknown; version?: unknown }) : undefined;
  if (record?.type === "session" && typeof record.version === "number" && record.version !== FORMAT_VERSION) {
    return `written in session format version ${record.version}; this Lemma reads version ${FORMAT_VERSION}`;
  }
  return `unreadable header (${firstLine(error.message)})`;
};

/** Decodes a line already parsed as JSON. A failure carries a one-line reason. */
export function decodeRecord(json: unknown, header: boolean): Result.Result<Line, string> {
  if (header) return Result.mapError(decodeHeader(json), (error) => headerFailure(json, error));
  const type = typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined;
  const decoded: Result.Result<Line, Schema.SchemaError> =
    type === "checkout" ? decodeCheckout(json) : type === "marks" ? decodeMarks(json) : decodeEvent(json);
  return Result.mapError(decoded, (error) => firstLine(error.message));
}

/** Random bytes in an id, from the store's `IdSource`: 72 bits for sessions (global), 48 for events (per session, collisions retried). */
export const SESSION_ID_BYTES = 9;
export const EVENT_ID_BYTES = 6;

/**
 * Directory for a working directory, pi-style: `/home/me/app` → `--home-me-app--`. The file's `cwd` (the last marks
 * record's, else the header's) stays authoritative.
 */
export const encodeCwd = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const fileName = (createdAt: number, id: string): string => `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;

/** Session id from a file name, or undefined for files that are not sessions. */
export function idFromFileName(name: string): string | undefined {
  const match = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
  return match?.[1];
}

export const sessionFile = (root: string, cwd: string, createdAt: number, id: string): string => path.join(root, encodeCwd(cwd), fileName(createdAt, id));
