/**
 * Node only: `@lemma/tools/files`. What a tool that reads or writes files needs to behave as the bundled file tools
 * do: paths resolved against the session's directory (`~` expanded, a leading `@` dropped), messages for failed file
 * operations, one write at a time per file (`withFileLock`, and `withFileLocks` for several), and writes that replace
 * a file whole or not at all (`replaceFile`); and for a tool with output too long to return whole, a private temp file
 * holding it (`outputFile`), and its start and end for the model (`boundOutput`).
 */
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { keepEnds, lineCount } from "./bound.ts";
import type { Cut } from "./bound.ts";
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
 * The file `file` names, as one name for it: its real path, symlinks resolved; for one that does not exist yet, its
 * nearest existing directory's real path with the rest of the name. So two names of one file, through a symlink to it
 * or to a directory it is in, are one. What a file's lock is keyed by, and how a change to several files tells that
 * two of its names are one file.
 */
export async function realPath(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const real = await realpath(absolute).catch(() => undefined);
  if (real !== undefined) return real;
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(await realPath(parent), path.basename(absolute));
}

/** A file's queue: its real path, so symlinks share one. */
const lockKey = realPath;

/**
 * Serializes writes and edits to one file (across sessions too); different
 * files proceed in parallel. Keyed by real path so symlinks share a queue.
 */
export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  return lockOn(await lockKey(file), work);
}

/**
 * `withFileLock` for several files at once, as a change to them together needs: each held until `work` settles, taken
 * one at a time in one order, so two calls naming the same files never each hold one the other waits for. Names of
 * one file (a symlink and its target) take its lock once.
 */
export async function withFileLocks<T>(files: readonly string[], work: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(files.map(lockKey)))].sort();
  const take = (index: number): Promise<T> => (index === keys.length ? work() : lockOn(keys[index]!, () => take(index + 1)));
  return take(0);
}

async function lockOn<T>(key: string, work: () => Promise<T>): Promise<T> {
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
 * keeps its mode (a new one gets `options.mode`, else the umask's), and a symlink keeps pointing where it did, its
 * target written. A file with other hard links is replaced under this name only.
 *
 * Replacing a file makes it anew, owned by this process's user, without the old one's ACLs or extended attributes. So
 * a file another user owns, or one in a directory this user cannot create files in, is written in place instead,
 * which a crash mid-write can leave cut short.
 */
export async function replaceFile(file: string, content: string, options: { readonly mode?: number } = {}): Promise<void> {
  const target = await linkTarget(file);
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await stat(target).catch(missing);
  if (existing?.isDirectory() === true) throw Object.assign(new Error(`EISDIR: ${file}`), { code: "EISDIR" });
  const user = process.getuid?.();
  if (existing !== undefined && user !== undefined && existing.uid !== user) return writeFile(target, content, "utf8");
  try {
    const mode = existing === undefined ? (options.mode ?? 0o666 & ~process.umask()) : existing.mode & 0o7777;
    await writeFileAtomic(target, content, { mode, sync: true });
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

/**
 * Bounds a tool's output for the model to `budget` characters of text: a tool passes `outputBudget` of its call's
 * `maxResultChars`, the registry the budget itself. Past it, the text items become one that keeps the start and the end
 * of their text (`keepEnds`), with the images after it, and the whole text goes to a temp file the model can read
 * (`fullOutputPath`, an `outputFile`, `lemma-<name>-….txt`).
 */
export async function boundOutput(
  content: readonly Content[],
  options: { readonly budget: number; readonly name: string },
): Promise<{ readonly content: readonly Content[]; readonly fullOutputPath?: string; readonly cut?: Cut }> {
  const combined = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  if (combined.length <= options.budget) return { content };
  let rest: string;
  let file: string | undefined;
  let made: OutputFile | undefined;
  try {
    made = outputFile(`lemma-${options.name.replace(/[^\w-]/g, "_")}`, "txt");
    await writeFile(made.path, combined);
    file = made.path;
    rest = `Full output: ${file}`;
  } catch (cause) {
    rest = `The full output could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    made?.release();
  }
  const kept = keepEnds({ head: combined, tail: combined, chars: combined.length, lines: lineCount(combined) }, options.budget, rest);
  const bounded = [{ type: "text" as const, text: kept.text }, ...content.filter((item) => item.type === "image")];
  return { content: bounded, ...(file === undefined ? {} : { fullOutputPath: file }), ...(kept.cut === undefined ? {} : { cut: kept.cut }) };
}

/** PNG, JPEG, GIF, or WebP by its first bytes, as pi tells them; a file's extension is not trusted. */
export function sniffImage(head: Uint8Array): string | undefined {
  const ascii = (offset: number, value: string) => [...value].every((char, i) => head[offset + i] === char.charCodeAt(0));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte)) return "image/png";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return undefined;
}

/** An SVG by its text: an `<svg` element near the start, after any XML prolog, doctype, or comments. */
const isSvg = (bytes: Uint8Array): boolean =>
  /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));

/** The most one image may add to a page, and all of a page's images together. */
const MAX_INLINED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINED_PAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_EXTENSION = String.raw`\.(?:png|jpe?g|gif|webp|svg)`;
/** The start of an absolute path: a `/`, but not two, which start a URL on another host (`//cdn.example.com/a.png`). */
const ABSOLUTE = String.raw`\/(?!\/)`;
/** An absolute path to an image in quotes, spaces and all: `src="/abs/My Shot.png"`, `"/abs/chart.svg"` in a script. */
const QUOTED_IMAGE = new RegExp(String.raw`(["'])(${ABSOLUTE}[^"'<>\n]*?${IMAGE_EXTENSION})\1`, "gi");
/** In CSS `url(…)` without quotes: `url(/abs/bg.webp)`. */
const CSS_IMAGE = new RegExp(String.raw`url\((${ABSOLUTE}[^)'"\s]+?${IMAGE_EXTENSION})\)`, "gi");
/** A `srcset`, whose candidates are a path and a descriptor each: `"/abs/a.png 1x, /abs/b.png 2x"`. */
const SRCSET = /srcset\s*=\s*(["'])(.*?)\1/gis;
const SRCSET_IMAGE = new RegExp(String.raw`^${ABSOLUTE}\S*${IMAGE_EXTENSION}$`, "i");

/** The paths of a `srcset`'s candidates, by where each sits in the value. */
const srcsetPaths = (value: string): string[] =>
  value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((path) => SRCSET_IMAGE.test(path));

/**
 * A page made self-contained: each absolute path to a local image in it, quoted (in an attribute or a script, spaces
 * and all), in CSS `url(…)`, or a candidate of a `srcset`, becomes a `data:` URL, so the page shows wherever it is drawn. A file is inlined only when its bytes are
 * an image (PNG, JPEG, GIF, WebP, or SVG text), so a path cannot carry another file's contents out, and up to 10 MiB
 * each and 25 MiB a page; `missing` names the paths left as they were.
 */
export async function inlineLocalImages(html: string): Promise<{ readonly html: string; readonly missing: readonly string[] }> {
  // In the order the page has them, whichever form each is in.
  const found = [
    ...[...html.matchAll(QUOTED_IMAGE)].map((match) => [match.index, [match[2]!]] as const),
    ...[...html.matchAll(CSS_IMAGE)].map((match) => [match.index, [match[1]!]] as const),
    ...[...html.matchAll(SRCSET)].map((match) => [match.index, srcsetPaths(match[2]!)] as const),
  ].sort(([a], [b]) => a - b);
  const paths = new Set(found.flatMap(([, files]) => files));
  const urls = new Map<string, string>();
  const missing: string[] = [];
  let total = 0;
  for (const file of paths) {
    try {
      const { size } = await stat(file);
      if (size > MAX_INLINED_IMAGE_BYTES || total + size > MAX_INLINED_PAGE_BYTES) {
        missing.push(file);
        continue;
      }
      const bytes = await readFile(file);
      const mimeType = sniffImage(bytes.subarray(0, 16)) ?? (isSvg(bytes) ? "image/svg+xml" : undefined);
      if (mimeType === undefined) {
        missing.push(file);
        continue;
      }
      total += size;
      urls.set(file, `data:${mimeType};base64,${bytes.toString("base64")}`);
    } catch {
      missing.push(file);
    }
  }
  if (urls.size === 0) return { html, missing };
  const url = (file: string) => urls.get(file) ?? file;
  return {
    html: html
      // A srcset first: its candidates are not each quoted, as the other forms are.
      .replace(SRCSET, (whole, quote: string, value: string) =>
        whole.replace(
          value,
          value
            .split(",")
            .map((candidate) => {
              const [path = "", ...descriptors] = candidate.trim().split(/\s+/);
              return SRCSET_IMAGE.test(path) ? [url(path), ...descriptors].join(" ") : candidate.trim();
            })
            .join(", "),
        ),
      )
      .replace(QUOTED_IMAGE, (whole, quote: string, file: string) => (urls.has(file) ? `${quote}${url(file)}${quote}` : whole))
      .replace(CSS_IMAGE, (whole, file: string) => (urls.has(file) ? `url(${url(file)})` : whole)),
    missing,
  };
}
