import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { Either, Schema } from "effect";
import type { ParseResult } from "effect";
import { SessionEvent } from "@lemma/contracts";

/**
 * One JSONL file per session. Line 1 is the header; every later line is a
 * `SessionEvent`, a checkout record, or a marks record. Events have no top-level
 * `type`, so the kinds of line cannot be confused. The file is only ever appended to,
 * except that a torn final line (a crash mid-write) is cut off before the next
 * append.
 */
export const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.Literal(1),
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

/** Pins or archives the session, written by `mark`; each field present overrides earlier ones. Not an event: it leaves the leaf alone. */
export const Marks = Schema.Struct({
  type: Schema.Literal("marks"),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  at: Schema.Number,
});
export type Marks = typeof Marks.Type;

export type Line = Header | Checkout | Marks | SessionEvent;

const decodeHeader = Schema.decodeUnknownEither(Header);
const decodeCheckout = Schema.decodeUnknownEither(Checkout);
const decodeMarks = Schema.decodeUnknownEither(Marks);
const decodeEvent = Schema.decodeUnknownEither(SessionEvent);

export const encodeLine = (line: Line): string => `${JSON.stringify(line)}\n`;

const firstLine = (message: string) => message.split("\n")[0] ?? message;

/** Parses one line. Left carries a one-line reason. */
export function decodeLine(text: string, header: boolean): Either.Either<Line, string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Either.left("not JSON");
  }
  return decodeRecord(json, header);
}

/** Decodes a line already parsed as JSON. Left carries a one-line reason. */
export function decodeRecord(json: unknown, header: boolean): Either.Either<Line, string> {
  if (header) return Either.mapLeft(decodeHeader(json), (error) => firstLine(error.message));
  const type = typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined;
  const decoded: Either.Either<Line, ParseResult.ParseError> =
    type === "checkout" ? decodeCheckout(json) : type === "marks" ? decodeMarks(json) : decodeEvent(json);
  return Either.mapLeft(decoded, (error) => firstLine(error.message));
}

/** Url-safe random id that never starts with `-`, so a command line doesn't read it as an option. */
const randomId = (bytes: number): string => {
  for (;;) {
    const id = randomBytes(bytes).toString("base64url");
    if (!id.startsWith("-")) return id;
  }
};

/** Short, url-safe, random. 72 bits for sessions (global), 48 bits for events (per session, collisions retried). */
export const sessionId = (): string => randomId(9);
export const eventId = (): string => randomId(6);

/** Directory for a working directory, pi-style: `/home/me/app` → `--home-me-app--`. The header's `cwd` stays authoritative. */
export const encodeCwd = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const fileName = (createdAt: number, id: string): string => `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;

/** Session id from a file name, or undefined for files that are not sessions. */
export function idFromFileName(name: string): string | undefined {
  const match = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
  return match?.[1];
}

export const sessionFile = (root: string, cwd: string, createdAt: number, id: string): string => path.join(root, encodeCwd(cwd), fileName(createdAt, id));
