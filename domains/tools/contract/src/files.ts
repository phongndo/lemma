/**
 * Node only: `@lemma/tools/files`. What a tool that reads or writes files needs to behave as the bundled file tools
 * do: paths resolved against the session's directory (`~` expanded, a leading `@` dropped), messages for failed file
 * operations, one write at a time per file, and writes that replace a file whole or not at all (`replaceFile`); and for
 * a tool with output too long to return whole, a private temp file holding it (`outputFile`, `boundOutput`).
 */
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { lstat, mkdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { ToolResult } from "./tools.ts";
import { errorCode, expandHome, isAlive, kindOf, writeFileAtomic } from "@lemma/contracts/fs";

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

const missing = (cause: unknown): undefined => {
  if (errorCode(cause) === "ENOENT") return undefined;
  throw cause;
};

/** Where the chain of symlinks at `file` ends: the file a write through it changes. */
async function linkTarget(file: string): Promise<string> {
  let current = file;
  for (let hops = 0; hops < 40; hops++) {
    const info = await lstat(current).catch(missing);
    if (info === undefined || !info.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), await readlink(current));
  }
  throw Object.assign(new Error(`Too many symbolic links: ${file}`), { code: "ELOOP" });
}

/** Failures making a temporary file beside the target, which writing the target in place does not need. */
const NO_TEMP = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Writes `content` to `file` whole or not at all, creating its parent directories: synced to disk before it is renamed
 * into place, so a crash, a power loss, or a full disk mid-write leaves the old file, never a truncated one. The file
 * keeps its mode (a new one gets the umask's), and a symlink keeps pointing where it did, its target written. A file
 * with other hard links is replaced under this name only.
 *
 * Replacing a file makes it anew, owned by this process's user, without the old one's ACLs or extended attributes. So
 * a file another user owns, or one in a directory this user cannot create files in, is written in place instead,
 * which a crash mid-write can leave cut short.
 */
export async function replaceFile(file: string, content: string): Promise<void> {
  const target = await linkTarget(file);
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await stat(target).catch(missing);
  if (existing?.isDirectory() === true) throw Object.assign(new Error(`EISDIR: ${file}`), { code: "EISDIR" });
  const user = process.getuid?.();
  if (existing !== undefined && user !== undefined && existing.uid !== user) return writeFile(target, content, "utf8");
  try {
    await writeFileAtomic(target, content, { mode: existing === undefined ? 0o666 & ~process.umask() : existing.mode & 0o7777, sync: true });
  } catch (cause) {
    if (existing === undefined || !NO_TEMP.has(errorCode(cause) ?? "")) throw cause;
    await writeFile(target, content, "utf8");
  }
}

/** The newest output files a process keeps once written; making another removes the oldest written one. */
const KEPT_OUTPUT_FILES = 100;
/** How long a dead-looking process's output directory is left: a pid can be alive in another pid namespace sharing the temp directory. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
let outputDirectory: string | undefined;
/** This process's output files, oldest first, and whether each is still being written. */
const outputFiles = new Map<string, { writing: boolean }>();

/**
 * Removes this user's output directories that a process left without removing them (killed, crashed): those whose
 * process looks gone and that have not changed for a day, since a process in another pid namespace looks gone too.
 */
function sweepOutputDirectories(): void {
  const user = process.getuid?.();
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^lemma-output-(\d+)-/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(tmpdir(), name);
    try {
      const info = lstatSync(dir);
      if ((user === undefined || info.uid === user) && Date.now() - info.mtimeMs > ABANDONED_AFTER_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** A file `outputFile` made: `release` once it is written whole, after which it counts toward the newest kept. */
export interface OutputFile {
  readonly path: string;
  readonly release: () => void;
}

/**
 * A new, empty file for a tool's full output (`<name>-….<extension>`) that only this user can read: 0600, in a
 * directory of the process's own (0700). The process keeps every file still being written and its newest 100 written
 * ones while it runs, so the model can read one by the path its result named, and removes them when it exits; those a
 * killed process left go a day later, when another makes its first.
 */
export function outputFile(name: string, extension: string): OutputFile {
  if (outputDirectory === undefined) {
    sweepOutputDirectories();
    const dir = mkdtempSync(path.join(tmpdir(), `lemma-output-${process.pid}-`));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    outputDirectory = dir;
  }
  const file = path.join(outputDirectory, `${name}-${randomBytes(8).toString("hex")}.${extension}`);
  try {
    closeSync(openSync(file, "wx", 0o600));
  } catch (cause) {
    // Removed from under the process (a temp cleaner): made again, as private as before.
    if (errorCode(cause) !== "ENOENT") throw cause;
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    closeSync(openSync(file, "wx", 0o600));
  }
  const entry = { writing: true };
  outputFiles.set(file, entry);
  return {
    path: file,
    release: () => {
      if (!entry.writing) return;
      entry.writing = false;
      let written = [...outputFiles].filter(([, state]) => !state.writing).length;
      for (const [oldest, state] of outputFiles) {
        if (written <= KEPT_OUTPUT_FILES) break;
        if (state.writing) continue;
        outputFiles.delete(oldest);
        rmSync(oldest, { force: true });
        written--;
      }
    },
  };
}

type Content = ToolResult["content"][number];

/** Room `boundOutput` keeps under the registry's cap for its notes and a header of the tool's own. */
const NOTES_CHARS = 1_000;
const CHARS_PER_TOKEN = 4;

/**
 * Bounds a tool's output for the model. Past `budget` characters of text, or past the registry's cap
 * (`ToolContext.maxResultChars`) less room for the notes, the text items become one that keeps the start and the end
 * of the text, with the images after it, and the whole text goes to a temp file the model can read (`fullOutputPath`,
 * an `outputFile`, `lemma-<name>-….txt`). Cut under the cap, the result is not cut again by the registry, which would lose its end and
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
  let file = "";
  let saved = true;
  let made: OutputFile | undefined;
  try {
    made = outputFile(`lemma-${options.name}`, "txt");
    file = made.path;
    await writeFile(file, combined);
    text += `\n\n[Full output: ${file} (read with offset/limit)]`;
  } catch (cause) {
    saved = false;
    text += `\n\n[Could not save the full output: ${cause instanceof Error ? cause.message : String(cause)}]`;
  } finally {
    made?.release();
  }
  const bounded = [{ type: "text" as const, text }, ...content.filter((item) => item.type === "image")];
  return saved ? { content: bounded, fullOutputPath: file } : { content: bounded };
}
