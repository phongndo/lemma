// Adapted from pi (MIT): packages/coding-agent/src/core/tools/output-accumulator.ts.
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, tailBytes, truncateTail } from "./truncate.ts";
import type { Truncation } from "./truncate.ts";

interface OutputSnapshot {
  readonly content: string;
  readonly truncation: Truncation;
  /** Set once the output exceeded the limits: the complete raw output. */
  readonly fullOutputPath?: string;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Streaming command output in bounded memory. Keeps a decoded tail for the
 * model and, once the output exceeds the limits, spills everything to a temp
 * file the model can read or grep.
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
  private finished = false;
  private file: string | undefined;
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

  get lastLineBytes(): number {
    return this.currentLineBytes;
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
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(() => resolve());
    });
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
    if (this.file !== undefined) return;
    this.file = join(tmpdir(), `${this.prefix}-${randomBytes(8).toString("hex")}.log`);
    this.stream = createWriteStream(this.file);
    this.stream.on("error", () => undefined);
    for (const chunk of this.raw) this.stream.write(chunk);
    this.raw = [];
  }
}
