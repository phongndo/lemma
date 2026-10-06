import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { ToolResult } from "@lemma/contracts";
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
