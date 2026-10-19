// Adapted from pi (MIT): packages/coding-agent/src/core/tools/output-accumulator.ts.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, tailBytes, truncateTail } from "@lemma/tools";
import type { Truncation } from "@lemma/tools";
import { outputFile } from "@lemma/tools/files";

interface OutputSnapshot {
  readonly content: string;
  readonly truncation: Truncation;
  /** Set once the output exceeded the limits, unless no file could be made: the complete raw output. */
  readonly fullOutputPath?: string;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Streaming command output in bounded memory. Keeps a decoded tail for the
 * model and, once the output exceeds the limits, spills everything to a temp
 * file the model can read or grep (`outputFile`).
 */
export class OutputAccumulator {
  private readonly maxLines = DEFAULT_MAX_LINES;
  private readonly maxBytes = DEFAULT_MAX_BYTES;
  private readonly rollingBytes = DEFAULT_MAX_BYTES * 2;
  private readonly decoder = new TextDecoder();
  private raw: Buffer[] = [];
  private tail = "";
  private tailSize = 0;
  private tailAtLineStart = true;
  private rawBytes = 0;
  private decodedBytes = 0;
  private completedLines = 0;
  private lineOpen = false;
  private currentLineBytes = 0;
  /** The size of the last line a newline ended. */
  private endedLineBytes = 0;
  private finished = false;
  private file: string | undefined;
  private release: (() => void) | undefined;
  private spillFailed = false;
  private stream: WriteStream | undefined;

  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  private get totalLines(): number {
    return this.completedLines + (this.lineOpen ? 1 : 0);
  }

  private get overLimit(): boolean {
    return this.rawBytes > this.maxBytes || this.decodedBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  /** The size of the last line, open or ended by a newline. */
  get lastLineBytes(): number {
    return this.lineOpen ? this.currentLineBytes : this.endedLineBytes;
  }

  append(data: Buffer): void {
    if (this.finished) return;
    this.rawBytes += data.length;
    this.decoded(this.decoder.decode(data, { stream: true }));
    if (this.stream !== undefined || this.overLimit) {
      this.spill();
      this.stream?.write(data);
    } else if (data.length > 0) {
      this.raw.push(data);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.decoded(this.decoder.decode());
    if (this.overLimit) this.spill();
  }

  snapshot(): OutputSnapshot {
    const text = this.tailAtLineStart ? this.tail : this.tail.slice(this.tail.indexOf("\n") + 1);
    const tail = truncateTail(text, { maxLines: this.maxLines, maxBytes: this.maxBytes });
    const truncated = this.totalLines > this.maxLines || this.decodedBytes > this.maxBytes;
    const truncation: Truncation = {
      ...tail,
      truncated,
      truncatedBy: truncated ? (tail.truncatedBy ?? (this.decodedBytes > this.maxBytes ? "bytes" : "lines")) : null,
      totalLines: this.totalLines,
      totalBytes: this.decodedBytes,
    };
    if (truncated) this.spill();
    return { content: truncation.content, truncation, ...(this.file === undefined ? {} : { fullOutputPath: this.file }) };
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (stream === undefined) return;
    this.stream = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => resolve());
      });
    } finally {
      this.release?.();
    }
  }

  private decoded(text: string): void {
    if (text.length === 0) return;
    const size = bytes(text);
    this.decodedBytes += size;
    this.tail += text;
    this.tailSize += size;
    if (this.tailSize > this.rollingBytes * 2) this.trimTail();
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      this.currentLineBytes += size;
      this.lineOpen = true;
      return;
    }
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.completedLines++;
    const previousNewline = lastNewline === 0 ? -1 : text.lastIndexOf("\n", lastNewline - 1);
    this.endedLineBytes =
      previousNewline === -1 ? this.currentLineBytes + bytes(text.slice(0, lastNewline)) : bytes(text.slice(previousNewline + 1, lastNewline));
    const rest = text.slice(lastNewline + 1);
    this.currentLineBytes = bytes(rest);
    this.lineOpen = rest.length > 0;
  }

  private trimTail(): void {
    const kept = tailBytes(this.tail, this.rollingBytes);
    if (kept.length < this.tail.length) this.tailAtLineStart = this.tail[this.tail.length - kept.length - 1] === "\n";
    this.tail = kept;
    this.tailSize = bytes(kept);
  }

  private spill(): void {
    if (this.file !== undefined || this.spillFailed) return;
    try {
      ({ path: this.file, release: this.release } = outputFile(this.prefix, "log"));
    } catch {
      // The tail is still returned; only the full output is lost.
      this.spillFailed = true;
      this.raw = [];
      return;
    }
    this.stream = createWriteStream(this.file);
    this.stream.on("error", () => undefined);
    for (const chunk of this.raw) this.stream.write(chunk);
    this.raw = [];
  }
}

/** Half of what a script keeps of a command's output: its first and its last 512 KiB. */
const SCRIPT_HALF_BYTES = 512 * 1024;

/**
 * A command's output as a script reads it (`BashOutput.output`), in bounded memory: whole up to 1 MiB, else its first
 * and last 512 KiB around a marker. A script filters it itself, so it gets far more than the model's 50KB tail.
 */
export class ScriptOutput {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  append(data: Buffer): void {
    this.total += data.length;
    let rest = data;
    if (this.headBytes < SCRIPT_HALF_BYTES) {
      const taken = rest.subarray(0, SCRIPT_HALF_BYTES - this.headBytes);
      this.head.push(taken);
      this.headBytes += taken.length;
      rest = rest.subarray(taken.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    // At least half is kept, so the end is never short of it.
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= SCRIPT_HALF_BYTES) this.tailBytes -= this.tail.shift()!.length;
  }

  /** The output, and whether its middle was left out. */
  read(): { readonly output: string; readonly truncated: boolean } {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (this.total <= SCRIPT_HALF_BYTES * 2) return { output: Buffer.concat([head, tail]).toString("utf8"), truncated: false };
    const kept = tail.subarray(tail.length - SCRIPT_HALF_BYTES);
    const omitted = this.total - head.length - kept.length;
    return {
      output: `${head.toString("utf8")}\n…[${omitted} bytes left out; the whole output is in fullOutputPath]…\n${kept.toString("utf8")}`,
      truncated: true,
    };
  }
}
