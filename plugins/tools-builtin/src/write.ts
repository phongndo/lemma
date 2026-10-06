import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import type { Tool } from "@lemma/contracts";
import { fsMessage, resolveToCwd, text, throwIfAborted, withFileLock } from "./files.ts";

export const WriteInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Path to the file to write (relative or absolute)" }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
});
export type WriteInput = typeof WriteInput.Type;

export const writeTool: Tool<WriteInput> = {
  name: "write",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  input: WriteInput,
  execute: async ({ path, content }, { cwd, signal }) => {
    const absolute = resolveToCwd(path, cwd);
    return withFileLock(absolute, async () => {
      // Checked between steps rather than rejecting from a listener, so the lock is held until the write settles.
      throwIfAborted(signal);
      try {
        await mkdir(dirname(absolute), { recursive: true });
        throwIfAborted(signal);
        await writeFile(absolute, content, "utf8");
      } catch (cause) {
        if (signal.aborted) throw cause;
        throw new Error(`Could not write ${path}: ${fsMessage(cause, path)}`);
      }
      const bytes = Buffer.byteLength(content, "utf8");
      return text(`Successfully wrote ${bytes} bytes to ${path}`, { path: absolute, bytes });
    });
  },
};
