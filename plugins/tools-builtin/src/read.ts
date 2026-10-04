import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
import { ToolResult } from "@lemma/contracts";
import type { Tool } from "@lemma/contracts";
import { fsMessage, resolveReadPath, text, throwIfAborted } from "./files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";
import type { Truncation } from "./truncate.ts";

export const ReadInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Path to the file to read (relative or absolute)" }),
  offset: Schema.optional(Schema.Number.annotations({ description: "Line number to start reading from (1-indexed)" })),
  limit: Schema.optional(Schema.Number.annotations({ description: "Maximum number of lines to read" })),
});
export type ReadInput = typeof ReadInput.Type;

export interface ReadDetails {
  readonly path: string;
  readonly truncation?: Truncation;
}

/**
 * Providers reject oversized images, and a rejected image in the history
 * fails every later request, so larger files are described instead of sent.
 * 3.75 MB of bytes is 5 MB of base64.
 */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

/** PNG, JPEG, GIF, or WebP by magic bytes, like pi; the extension is not trusted. */
export function sniffImage(head: Uint8Array): string | undefined {
  const ascii = (offset: number, value: string) => [...value].every((char, i) => head[offset + i] === char.charCodeAt(0));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte)) return "image/png";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return undefined;
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
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  input: ReadInput,
  // It only reads: cut off by a host restart, it runs again.
  replay: "safe",
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
        return text(
          `Read image file [${mimeType}]\nImage is ${formatSize(size)}, over the ${formatSize(MAX_IMAGE_BYTES)} limit for attachments; it was not attached.`,
          { path: absolute },
        );
      }
      const data = (await readFile(absolute)).toString("base64");
      return new ToolResult({
        content: [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data, mimeType },
        ],
        details: { path: absolute } satisfies ReadDetails,
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
    return text(output, details);
  },
};
