// Adapted from pi (MIT): packages/coding-agent/src/core/tools/output-accumulator.ts.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { keepEnds, outputBudget } from "@lemma/tools";
import type { Kept, TextEnds } from "@lemma/tools";
import { outputFile } from "@lemma/tools/files";

interface OutputSnapshot {
  /** The whole output, when it fits. */
  readonly content?: string;
  /** Its ends and counts, when it does not: what `keepEnds` makes the model's text of. */
  readonly ends?: TextEnds;
  /** Set once the output exceeded the limit (or from the start, with `spill: "always"`), unless no file could be made: the complete raw output. */
  readonly fullOutputPath?: string;
}

export interface OutputOptions {
  /** The characters the model is shown at most: past them, the output's start and end (`keepEnds`). */
  readonly maxChars?: number;
  /** `always`: the full output goes to a file from its first byte, as a background command's does, whatever its size. */
  readonly spill?: "always";
}

/**
 * Streaming command output in bounded memory. Keeps the decoded start and a decoded tail, each longer than the limit,
 * for `keepEnds` to make the model's text of, and once the output exceeds the limit, spills everything to a temp file
 * the model can read or grep (`outputFile`).
 */
export class OutputAccumulator {
  private readonly maxChars: number;
  private readonly decoder = new TextDecoder();
  private raw: Buffer[] = [];
  /** The output's start, as decoded, until it is one character longer than the limit. */
  private head = "";
  /** Its end, at least one character longer than the limit once there is that much. */
  private tail = "";
  private chars = 0;
  private newlines = 0;
  private endsWithNewline = false;
  private finished = false;
  private file: string | undefined;
  private release: (() => void) | undefined;
  private spillFailed = false;
  private stream: WriteStream | undefined;

  private readonly prefix: string;

  constructor(prefix: string, options: OutputOptions = {}) {
    this.prefix = prefix;
    this.maxChars = options.maxChars ?? outputBudget(undefined);
    if (options.spill === "always") this.spill();
  }

  /** The complete output's file, when there is one (always, with `spill: "always"`, unless it could not be made). */
  get path(): string | undefined {
    return this.file;
  }

  /** Takes the next bytes of output, and returns them decoded (a character split between chunks held for the next), for a live view. */
  append(data: Buffer): string {
    if (this.finished) return "";
    const text = this.decoder.decode(data, { stream: true });
    this.decoded(text);
    if (this.stream !== undefined || this.chars > this.maxChars) {
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
    if (this.chars > this.maxChars) this.spill();
  }

  snapshot(): OutputSnapshot {
    const file = this.file === undefined ? {} : { fullOutputPath: this.file };
    if (this.chars <= this.maxChars) return { content: this.head, ...file };
    this.spill();
    const lines = this.newlines + (this.endsWithNewline ? 0 : 1);
    return { ends: { head: this.head, tail: this.tail, chars: this.chars, lines }, ...file };
  }

  /**
   * `snapshot` as the model reads it: the whole output when it fit; else its start, a line saying what was left out and
   * where all of it is (`full`: the file, or that it could not be saved), then its end, where errors and results are.
   */
  kept(snapshot: OutputSnapshot, full: string): Kept {
    return snapshot.ends === undefined ? { text: snapshot.content ?? "" } : keepEnds(snapshot.ends, this.maxChars, full);
  }

  /** `kept`'s text. */
  shown(snapshot: OutputSnapshot, full: string): string {
    return this.kept(snapshot, full).text;
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
    this.chars += text.length;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) this.newlines++;
    this.endsWithNewline = text.endsWith("\n");
    const keep = this.maxChars + 1;
    if (this.head.length < keep) this.head += text.slice(0, keep - this.head.length);
    this.tail += text;
    if (this.tail.length > keep * 4) {
      this.tail = this.tail.slice(-keep * 2);
      // Not half a surrogate pair.
      const first = this.tail.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) this.tail = this.tail.slice(1);
    }
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
 * and last 512 KiB around a marker. A script filters it itself, so it gets far more than the model sees.
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
