import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
import { MAX_IMAGE_BYTES } from "@lemma/llm";
import { ImageBlock, ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import { fsMessage, resolveReadPath, sniffImage, throwIfAborted } from "@lemma/tools/files";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@lemma/tools";
import type { Truncation } from "@lemma/tools";

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
  readonly truncation?: Truncation;
}

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
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. Use it to examine files instead of cat or sed.`,
  input: ReadInput,
  output: ReadOutput,
  // It only reads: cut off by a host restart, it runs again, and reads the model asks for together run together.
  replay: "safe",
  parallel: "safe",
  execute: async ({ path, offset, limit }, { cwd, signal }) => {
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

    const allLines = (await readFile(absolute)).toString("utf8").split("\n");
    const totalFileLines = allLines.length;
    const startLine = offset !== undefined && offset > 0 ? Math.floor(offset) - 1 : 0;
    const startDisplay = startLine + 1;
    if (startLine >= allLines.length) throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);

    let selected: string;
    let userLimited: number | undefined;
    if (limit !== undefined) {
      const endLine = Math.min(startLine + Math.max(1, Math.floor(limit)), allLines.length);
      selected = allLines.slice(startLine, endLine).join("\n");
      userLimited = endLine - startLine;
    } else {
      selected = allLines.slice(startLine).join("\n");
    }

    const truncation = truncateHead(selected);
    let output: string;
    if (truncation.firstLineExceedsLimit) {
      const size = formatSize(Buffer.byteLength(allLines[startLine]!, "utf8"));
      output = `[Line ${startDisplay} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
    } else if (truncation.truncated) {
      const endDisplay = startDisplay + truncation.outputLines - 1;
      const limitNote = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
      output = `${truncation.content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalFileLines}${limitNote}. Use offset=${endDisplay + 1} to continue.]`;
    } else if (userLimited !== undefined && startLine + userLimited < allLines.length) {
      const remaining = allLines.length - (startLine + userLimited);
      output = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${startLine + userLimited + 1} to continue.]`;
    } else {
      output = truncation.content;
    }
    const details: ReadDetails = { path: absolute, ...(truncation.truncated ? { truncation } : {}) };
    return new ToolResult({ content: [{ type: "text", text: output }], details, structured: output });
  },
};
