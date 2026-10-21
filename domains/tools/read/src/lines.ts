import { isUtf8 } from "node:buffer";
import type { FileHandle } from "node:fs/promises";

/** How much of the file is read at a time: memory stays at one chunk and the page kept, whatever the file's size. */
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** Where a character the bytes end partway through starts (its lead byte, short of continuation bytes), else their length. */
const incompleteTail = (bytes: Uint8Array): number => {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needs = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needs > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
};

/**
 * The size of bytes once decoded as UTF-8 (`toString("utf8")`, each invalid sequence a 3-byte U+FFFD), given in pieces:
 * a character split between two is held until the next completes it. Valid text is counted without decoding it.
 */
class DecodedSize {
  total = 0;
  private held: Buffer | undefined;

  add(piece: Uint8Array): void {
    if (piece.length === 0) return;
    let bytes = this.held === undefined ? piece : Buffer.concat([this.held, piece]);
    this.held = undefined;
    const cut = incompleteTail(bytes);
    if (cut < bytes.length) {
      this.held = Buffer.from(bytes.subarray(cut));
      bytes = bytes.subarray(0, cut);
    }
    this.total += isUtf8(bytes) ? bytes.length : Buffer.byteLength(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("utf8"));
  }

  end(): number {
    if (this.held !== undefined) this.total += Buffer.byteLength(this.held.toString("utf8"));
    this.held = undefined;
    return this.total;
  }
}

/** Lines `start` (0-based) up to `end` (exclusive; to the file's end without one) of a file, as `read` pages it. */
export interface LineWindow {
  /** The file's lines as `split("\n")` counts them: a final newline ends an empty last line. */
  readonly fileLines: number;
  /** Undefined when the file has no line `start`. */
  readonly selection?: {
    /**
     * The selection's start, decoded: through the newline ending its `maxLines + 1`th line, or its first `maxBytes + 1`
     * bytes, whichever is shorter; the whole selection when that is shorter still. Enough for `truncateHead` to keep what
     * it would keep of the whole, and to tell that the whole is over its limits.
     */
    readonly head: string;
    /** The selection's lines as `truncateHead` counts them (a final newline ends none), and its size decoded. */
    readonly lines: number;
    readonly bytes: number;
    /** The size of its first line, decoded. */
    readonly firstLineBytes: number;
  };
}

/**
 * Reads a file once, a chunk at a time, keeping only the start of the lines asked for: what `split("\n")` of the whole
 * file and `truncateHead` of the lines selected would say, in memory bounded by the limits rather than the file's size.
 * Every line is counted, so the whole file is read; `signal` stops it between chunks.
 */
export async function readLines(
  handle: FileHandle,
  start: number,
  end: number | undefined,
  limits: { readonly maxLines: number; readonly maxBytes: number },
  signal: AbortSignal,
  chunkBytes = CHUNK_BYTES,
): Promise<LineWindow> {
  const buffer = Buffer.allocUnsafe(chunkBytes);
  /** Newlines seen so far: line `n` starts after the `n`th. */
  let newlines = 0;
  let phase: "before" | "in" | "after" = start === 0 ? "in" : "before";
  const size = new DecodedSize();
  const firstLine = new DecodedSize();
  let firstLineOpen = true;
  /** Newlines inside the selection, and whether its last byte is one. */
  let inner = 0;
  let endsWithNewline = false;
  let empty = true;
  const head: Buffer[] = [];
  let headBytes = 0;
  let headOpen = true;
  const headRoom = limits.maxBytes + 1;

  /** `data[from, to)` is part of the selection; `newlineAt` lists the selection's newlines in it, in order. */
  const take = (data: Buffer, from: number, to: number, newlineAt: readonly number[]) => {
    if (to <= from) return;
    empty = false;
    endsWithNewline = data[to - 1] === NEWLINE;
    size.add(data.subarray(from, to));
    if (firstLineOpen) {
      const first = newlineAt.length === 0 ? to : newlineAt[0]!;
      firstLine.add(data.subarray(from, first));
      if (newlineAt.length > 0) firstLineOpen = false;
    }
    if (headOpen) {
      // Through the newline ending line maxLines + 1, and at most maxBytes + 1 bytes.
      const lineCut = inner + newlineAt.length > limits.maxLines ? newlineAt[limits.maxLines - inner]! + 1 : to;
      const cut = Math.min(lineCut, from + (headRoom - headBytes));
      head.push(Buffer.from(data.subarray(from, cut)));
      headBytes += cut - from;
      if (cut < to || headBytes >= headRoom || inner + newlineAt.length > limits.maxLines) headOpen = false;
    }
    inner += newlineAt.length;
  };

  for (let position = 0; ;) {
    if (signal.aborted) throw new Error("Operation aborted");
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const data = buffer.subarray(0, bytesRead);
    let offset = 0;
    if (phase === "before") {
      while (newlines < start) {
        const at = data.indexOf(NEWLINE, offset);
        if (at === -1) break;
        newlines++;
        offset = at + 1;
      }
      if (newlines === start) phase = "in";
      else continue;
    }
    if (phase === "in") {
      const newlineAt: number[] = [];
      let to = bytesRead;
      for (let at = data.indexOf(NEWLINE, offset); at !== -1; at = data.indexOf(NEWLINE, at + 1)) {
        newlines++;
        // The newline ending line `end - 1` ends the selection, outside it.
        if (end !== undefined && newlines === end) {
          to = at;
          phase = "after";
          break;
        }
        newlineAt.push(at);
      }
      take(data, offset, to, newlineAt);
      if (phase === "in") continue;
      offset = to + 1;
    }
    for (let at = data.indexOf(NEWLINE, offset); at !== -1; at = data.indexOf(NEWLINE, at + 1)) newlines++;
  }

  const fileLines = newlines + 1;
  if (phase === "before") return { fileLines };
  return {
    fileLines,
    selection: {
      head: Buffer.concat(head).toString("utf8"),
      lines: empty ? 0 : inner + 1 - (endsWithNewline ? 1 : 0),
      bytes: size.end(),
      firstLineBytes: firstLine.end(),
    },
  };
}
