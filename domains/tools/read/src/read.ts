import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
import { MAX_IMAGE_BYTES } from "@lemma/llm";
import { ImageBlock, ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import { fsMessage, resolveReadPath, sniffImage, throwIfAborted } from "@lemma/tools/files";
import { readLines } from "./lines.ts";
import type { LineWindow } from "./lines.ts";
import { formatSize, keepHead, outputBudget } from "@lemma/tools";
import type { Cut } from "@lemma/tools";

export const ReadInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Path to the file to read (relative or absolute)" }),
  offset: Schema.optional(Schema.Number.annotate({ description: "Line number to start reading from (1-indexed)" })),
  limit: Schema.optional(Schema.Number.annotate({ description: "Maximum number of lines to read" })),
});
export type ReadInput = typeof ReadInput.Type;

/** What a script's call resolves to: the text the model reads, or an image as a block a script shows or classifies. */
export const ReadOutput = Schema.Union([Schema.String, ImageBlock]);
export type ReadOutput = typeof ReadOutput.Type;

export interface ReadDetails {
  readonly path: string;
  /** How the text was cut to the result's budget, when it was: the counts, its text being the result's own, which the log keeps once. */
  readonly truncation?: Cut;
}

/** The lines a page holds when the call names no `limit`. */
const PAGE_LINES = 2000;
/** Past this much of a file, reading stops at the page's end rather than count the rest of its lines. */
const COUNT_BYTES = 64 * 1024 * 1024;

async function readHead(file: string, length: number): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export const readTool: Tool<ReadInput> = {
  name: "read",
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. Text comes a page at a time: up to ${PAGE_LINES} lines, fewer when they are long, with a note saying where to continue. Use offset/limit for large files. When you need the full file, continue with offset until complete. Use it to examine files instead of cat or sed.`,
  input: ReadInput,
  output: ReadOutput,
  // It only reads: cut off by a host restart, it runs again, and reads the model asks for together run together.
  replay: "safe",
  parallel: "safe",
  execute: async ({ path, offset, limit }, { cwd, signal, maxResultChars }) => {
    throwIfAborted(signal);
    const absolute = await resolveReadPath(path, cwd);
    try {
      await access(absolute, constants.R_OK);
      if ((await stat(absolute)).isDirectory()) throw Object.assign(new Error("directory"), { code: "EISDIR" });
    } catch (cause) {
      throw new Error(fsMessage(cause, path));
    }
    throwIfAborted(signal);

    const mimeType = sniffImage(await readHead(absolute, 16));
    if (mimeType !== undefined) {
      const { size } = await stat(absolute);
      if (size > MAX_IMAGE_BYTES) {
        const note = `Read image file [${mimeType}]\nImage is ${formatSize(size)}, over the ${formatSize(MAX_IMAGE_BYTES)} limit for attachments; it was not attached.`;
        return new ToolResult({ content: [{ type: "text", text: note }], details: { path: absolute } satisfies ReadDetails, structured: note });
      }
      const data = (await readFile(absolute)).toString("base64");
      const note = `Read image file [${mimeType}]`;
      return new ToolResult({
        content: [
          { type: "text", text: note },
          { type: "image", data, mimeType },
        ],
        details: { path: absolute } satisfies ReadDetails,
        structured: { type: "image", data, mimeType, note } satisfies ReadOutput,
      });
    }

    // A page at a time, read only as far as the page and, in a file up to `COUNT_BYTES`, on to count its lines.
    const startLine = offset !== undefined && offset > 0 ? Math.floor(offset) - 1 : 0;
    const budget = outputBudget(maxResultChars);
    const handle = await open(absolute, "r");
    let window: LineWindow;
    try {
      const end = startLine + (limit === undefined ? PAGE_LINES : Math.max(1, Math.floor(limit)));
      // Three bytes a character at most, so a window over the budget reads as one.
      window = await readLines(handle, startLine, end, { headBytes: 3 * (budget + 1), countBytes: COUNT_BYTES }, signal);
    } finally {
      await handle.close();
    }
    const { lines, text } = window;
    if (text === undefined || (startLine > 0 && lines !== undefined && startLine >= lines))
      throw new Error(`Offset ${offset} is beyond end of file (${lines} lines total)`);
    const size = lines === undefined ? formatSize((await stat(absolute)).size) : undefined;
    const kept = keepHead(text, budget, {
      from: startLine + 1,
      of: lines,
      rest: ({ next, partial, kept }) =>
        partial
          ? `Read on in it with bash: sed -n '${next}p' ${path} | cut -c ${kept + 1}-${kept + budget}`
          : `Use offset=${next} to continue${size === undefined ? "" : `; the file is ${size}`}.`,
    });
    const details: ReadDetails = { path: absolute, ...(kept.cut === undefined ? {} : { truncation: kept.cut }) };
    return new ToolResult({ content: [{ type: "text", text: kept.text }], details, structured: kept.text });
  },
};
