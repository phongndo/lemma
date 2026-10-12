/**
 * Node only: `@lemma/tools/files`. What a tool that reads or writes files needs to behave as the bundled file tools
 * do: paths resolved against the session's directory (`~` expanded, a leading `@` dropped), messages for failed file
 * operations, and one write at a time per file; and for a tool with output too long to return whole, a temp file
 * holding it (`boundOutput`).
 */
import { randomBytes } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { ToolResult } from "./tools.ts";
import { errorCode, expandHome, kindOf } from "@lemma/contracts/fs";

export const text = (value: string, details?: unknown): ToolResult =>
  new ToolResult({ content: [{ type: "text", text: value }], ...(details === undefined ? {} : { details }) });

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error("Operation aborted");
};

const UNICODE_SPACES = /[  -   　]/g;

/** Resolves a model-supplied path against the session cwd: `~` expands, a leading `@` (a mention) is dropped. */
export function resolveToCwd(input: string, cwd: string): string {
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  return path.resolve(cwd, expandHome(value, homedir()));
}

const exists = async (file: string) => (await kindOf(file)) !== undefined;

/**
 * Like `resolveToCwd`, but tries the spellings macOS uses in screenshot names
 * (narrow no-break space before AM/PM, NFD, curly apostrophe) when the typed
 * path does not exist, as pi does.
 */
export async function resolveReadPath(input: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(input, cwd);
  if (await exists(resolved)) return resolved;
  const nfd = resolved.normalize("NFD");
  const variants = [resolved.replace(/ (AM|PM)\./gi, " $1."), nfd, resolved.replace(/'/g, "’"), nfd.replace(/'/g, "’")];
  for (const variant of variants) {
    if (variant !== resolved && (await exists(variant))) return variant;
  }
  return resolved;
}

/** A readable message for common filesystem failures. */
export function fsMessage(cause: unknown, display: string): string {
  switch (errorCode(cause)) {
    case "ENOENT":
      return `File not found: ${display}`;
    case "EISDIR":
      return `${display} is a directory, not a file. Use bash (ls) to list it.`;
    case "EACCES":
    case "EPERM":
      return `Permission denied: ${display}`;
    case "ENOTDIR":
      return `A parent of ${display} is not a directory`;
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
}

const queues = new Map<string, Promise<void>>();

/**
 * Serializes writes and edits to one file (across sessions too); different
 * files proceed in parallel. Keyed by real path so symlinks share a queue.
 */
export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = await realpath(file).catch(() => path.resolve(file));
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  queues.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

type Content = ToolResult["content"][number];

/** Room `boundOutput` keeps under the registry's cap for its notes and a header of the tool's own. */
const NOTES_CHARS = 1_000;
const CHARS_PER_TOKEN = 4;

/**
 * Bounds a tool's output for the model. Past `budget` characters of text, or past the registry's cap
 * (`ToolContext.maxResultChars`) less room for the notes, the text items become one that keeps the start and the end
 * of the text, with the images after it, and the whole text goes to a temp file the model can read (`fullOutputPath`,
 * `lemma-<name>-….txt`). Cut under the cap, the result is not cut again by the registry, which would lose its end and
 * the note naming the file.
 */
export async function boundOutput(
  content: readonly Content[],
  options: { readonly budget: number; readonly maxResultChars?: number | undefined; readonly name: string },
): Promise<{ readonly content: readonly Content[]; readonly fullOutputPath?: string }> {
  const budget = Math.min(options.budget, Math.max(0, (options.maxResultChars ?? Number.POSITIVE_INFINITY) - NOTES_CHARS));
  const combined = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  if (combined.length <= budget) return { content };
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - budget;
  const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
  let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${combined.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
  const file = path.join(tmpdir(), `lemma-${options.name}-${randomBytes(8).toString("hex")}.txt`);
  let saved = true;
  try {
    await writeFile(file, combined);
    text += `\n\n[Full output: ${file} (read with offset/limit)]`;
  } catch (cause) {
    saved = false;
    text += `\n\n[Could not save the full output: ${cause instanceof Error ? cause.message : String(cause)}]`;
  }
  const bounded = [{ type: "text" as const, text }, ...content.filter((item) => item.type === "image")];
  return saved ? { content: bounded, fullOutputPath: file } : { content: bounded };
}
