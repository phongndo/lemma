// Adapted from pi (MIT): packages/coding-agent/src/core/tools/output-accumulator.ts.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, headBytes, tailBytes, truncateHead, truncateTail } from "@lemma/tools";
import type { Truncation } from "@lemma/tools";
import { outputFile } from "@lemma/tools/files";

/** What a truncated output kept: its first lines, its last, and how much fell between them. */
export interface KeptEnds {
  readonly head: string;
  readonly tail: string;
  /** Lines between `head` and `tail`; 0 when all that was left out is part of one long line. */
  readonly omittedLines: number;
  readonly omittedBytes: number;
  /** The number of `head`'s last line. */
  readonly headTo: number;
  /** The number of `tail`'s first line. */
  readonly tailFrom: number;
  /** `head` ends partway through its last line, `headTo`. */
  readonly headCut: boolean;
  /** `tail` starts partway through its first line, `tailFrom`. */
  readonly tailCut: boolean;
}

interface OutputSnapshot {
  /** The whole output when it fits; else its ends, `head` and `tail` in `ends`, joined by a blank line. */
  readonly content: string;
  readonly truncation: Truncation;
  /** Present when the output was truncated: its first and last lines, each within half the limits. */
  readonly ends?: KeptEnds;
  /** Set once the output exceeded the limits (or from the start, with `spill: "always"`), unless no file could be made: the complete raw output. */
  readonly fullOutputPath?: string;
}

export interface OutputOptions {
  /** What the snapshot keeps, at most: the defaults are the tools' (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`). */
  readonly maxLines?: number;
  readonly maxBytes?: number;
  /** `always`: the full output goes to a file from its first byte, as a background command's does, whatever its size. */
  readonly spill?: "always";
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const lineCount = (text: string) => (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/**
 * Streaming command output in bounded memory. Keeps the decoded start and a decoded tail for the model and, once the
 * output exceeds the limits, spills everything to a temp file the model can read or grep (`outputFile`). Past the
 * limits the model gets both ends, half the limits each: what the command set out to do, and how it ended.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly rollingBytes: number;
  private readonly decoder = new TextDecoder();
  private raw: Buffer[] = [];
  /** The output's start, as decoded, until it is long enough for any head the limits keep. */
  private head = "";
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

  constructor(prefix: string, options: OutputOptions = {}) {
    this.prefix = prefix;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.rollingBytes = this.maxBytes * 2;
    if (options.spill === "always") this.spill();
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

  /** The complete output's file, when there is one (always, with `spill: "always"`, unless it could not be made). */
  get path(): string | undefined {
    return this.file;
  }

  /** Takes the next bytes of output, and returns them decoded (a character split between chunks held for the next), for a live view. */
  append(data: Buffer): string {
    if (this.finished) return "";
    this.rawBytes += data.length;
    const text = this.decoder.decode(data, { stream: true });
    this.decoded(text);
    if (this.stream !== undefined || this.overLimit) {
      this.spill();
      this.stream?.write(data);
    } else if (data.length > 0) {
      this.raw.push(data);
    }
    return text;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.decoded(this.decoder.decode());
    if (this.overLimit) this.spill();
  }

  snapshot(): OutputSnapshot {
    const text = this.tailAtLineStart ? this.tail : this.tail.slice(this.tail.indexOf("\n") + 1);
    const truncated = this.totalLines > this.maxLines || this.decodedBytes > this.maxBytes;
    const file = this.file === undefined ? {} : { fullOutputPath: this.file };
    if (!truncated) {
      const whole = truncateTail(text, { maxLines: this.maxLines, maxBytes: this.maxBytes });
      return { content: whole.content, truncation: { ...whole, totalLines: this.totalLines, totalBytes: this.decodedBytes }, ...file };
    }
    this.spill();
    const half = { maxLines: Math.max(1, Math.floor(this.maxLines / 2)), maxBytes: Math.max(1, Math.floor(this.maxBytes / 2)) };
    // The head's whole lines, or the start of a first line too long for them; the tail's, or the end of a last one.
    const start = this.head.includes("\n") && !this.head.endsWith("\n") ? this.head.slice(0, this.head.lastIndexOf("\n") + 1) : this.head;
    const kept = truncateHead(start, half);
    const head = kept.firstLineExceedsLimit ? headBytes(start.split("\n")[0]!, half.maxBytes) : kept.content;
    const end = truncateTail(text, half);
    const headLines = lineCount(head);
    const tailLines = end.outputLines;
    const omittedLines = Math.max(0, this.totalLines - headLines - tailLines);
    const ends: KeptEnds = {
      head,
      tail: end.content,
      omittedLines,
      omittedBytes: Math.max(0, this.decodedBytes - bytes(head) - end.outputBytes),
      headTo: headLines,
      tailFrom: this.totalLines - tailLines + 1,
      headCut: kept.firstLineExceedsLimit,
      tailCut: end.lastLinePartial,
    };
    const content = `${head}\n\n${end.content}`;
    const truncation: Truncation = {
      content,
      truncated: true,
      truncatedBy: this.totalLines > this.maxLines ? "lines" : "bytes",
      totalLines: this.totalLines,
      totalBytes: this.decodedBytes,
      outputLines: headLines + tailLines,
      outputBytes: bytes(head) + end.outputBytes,
      lastLinePartial: end.lastLinePartial,
      firstLineExceedsLimit: kept.firstLineExceedsLimit,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    return { content, truncation, ends, ...file };
  }

  /**
   * `snapshot` as the model reads it: the whole output when it fit; else its start, a line saying what was left out and
   * where all of it is (`full`: the file, or that it could not be saved), then its end, where errors and results are.
   */
  shown(snapshot: OutputSnapshot, full: string): string {
    const { ends, truncation } = snapshot;
    if (ends === undefined) return snapshot.content;
    const marker =
      truncation.totalLines === 1
        ? `[… ${formatSize(ends.omittedBytes)} of line 1 (${formatSize(this.lastLineBytes)}) left out. ${full}]`
        : ends.omittedLines > 0
          ? `[… ${ends.omittedLines} lines left out: showing lines 1-${ends.headTo} and ${ends.tailFrom}-${truncation.totalLines} of ${truncation.totalLines}. ${full}]`
          : `[… ${formatSize(ends.omittedBytes)} left out: ${[
              ...(ends.headCut ? [`the end of line ${ends.headTo}`] : []),
              ...(ends.tailCut ? [`the start of line ${ends.tailFrom}`] : []),
            ].join(" and ")}. ${full}]`;
    return `${ends.head}\n\n${marker}\n\n${ends.tail}`;
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
    // Characters at least as many as any head could keep, in bytes or in lines.
    if (this.head.length < this.maxBytes) this.head += text.slice(0, this.maxBytes - this.head.length);
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
    // A tail as many bytes as characters is ASCII, whose last bytes are its last characters: no need to encode it.
    const kept = this.tailSize === this.tail.length ? this.tail.slice(-this.rollingBytes) : tailBytes(this.tail, this.rollingBytes);
    if (kept.length < this.tail.length) this.tailAtLineStart = this.tail[this.tail.length - kept.length - 1] === "\n";
    this.tail = kept;
    this.tailSize = bytes(kept);
  }

  private spill(): void {
    if (this.file !== undefined || this.spillFailed) return;
    try {
      ({ path: this.file, release: this.release } = outputFile(this.prefix, "log"));
    } catch {
      // The ends are still returned; only the full output is lost.
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
