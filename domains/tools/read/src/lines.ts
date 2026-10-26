import type { FileHandle } from "node:fs/promises";

/** How much of the file is read at a time: memory stays at one chunk and the page kept, whatever the file's size. */
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** Lines `start` (0-based) up to `end` (exclusive) of a file, as `read` pages it. */
export interface LineWindow {
  /**
   * The file's lines, a final newline ending its last rather than starting another. Undefined when reading stopped at
   * the window's end, the rest of a large file uncounted.
   */
  readonly lines?: number;
  /** The window's text, decoded: all of it, or its first `headBytes` bytes. Undefined when the file ends before line `start`. */
  readonly text?: string;
}

/**
 * Reads a file a chunk at a time up to the end of the lines asked for, keeping only their first `headBytes` bytes: in
 * memory bounded by them rather than the file's size. Past the window it reads on only to count the file's lines,
 * while what it has read is under `countBytes`. `signal` stops it between chunks.
 */
export async function readLines(
  handle: FileHandle,
  start: number,
  end: number,
  limits: { readonly headBytes: number; readonly countBytes: number },
  signal: AbortSignal,
  chunkBytes = CHUNK_BYTES,
): Promise<LineWindow> {
  const buffer = Buffer.allocUnsafe(chunkBytes);
  /** Newlines seen so far: line `n` starts after the `n`th. */
  let newlines = 0;
  let phase: "before" | "in" | "after" = start === 0 ? "in" : "before";
  const head: Buffer[] = [];
  let headBytes = 0;
  let position = 0;
  let ended = false;
  let endsWithNewline = false;

  /** `data[from, to)` is part of the window. */
  const take = (data: Buffer, from: number, to: number) => {
    const cut = Math.min(to, from + limits.headBytes - headBytes);
    if (cut <= from) return;
    head.push(Buffer.from(data.subarray(from, cut)));
    headBytes += cut - from;
  };

  for (;;) {
    if (signal.aborted) throw new Error("Operation aborted");
    if (phase === "after" && position >= limits.countBytes) break;
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
    if (bytesRead === 0) {
      ended = true;
      break;
    }
    position += bytesRead;
    const data = buffer.subarray(0, bytesRead);
    endsWithNewline = data[bytesRead - 1] === NEWLINE;
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
      let to = bytesRead;
      for (let at = data.indexOf(NEWLINE, offset); at !== -1; at = data.indexOf(NEWLINE, at + 1)) {
        newlines++;
        // The newline ending line `end - 1` ends the window, outside it.
        if (newlines === end) {
          to = at;
          phase = "after";
          break;
        }
      }
      take(data, offset, to);
      if (phase === "in") continue;
      offset = to + 1;
    }
    for (let at = data.indexOf(NEWLINE, offset); at !== -1; at = data.indexOf(NEWLINE, at + 1)) newlines++;
  }

  const lines = ended ? newlines + (position === 0 || endsWithNewline ? 0 : 1) : undefined;
  if (phase === "before") return { lines: lines! };
  return { ...(lines === undefined ? {} : { lines }), text: Buffer.concat(head).toString("utf8") };
}
