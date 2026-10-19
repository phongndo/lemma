/**
 * `@lemma/tools/patch`: the patch the bundled `apply_patch` tool takes, and how it changes a file, ported from Codex
 * (Apache-2.0) at [89461ea](https://github.com/openai/codex/tree/89461ea6833832b0551ce24ee32205824d5c108d/codex-rs/apply-patch/src):
 * its parser (`parser.rs`, `streaming_parser.rs`: `parsePatch`), its line matching (`seek_sequence.rs`: `seekSequence`),
 * and its update of a file's text (`file_update.rs`, `text_file.rs`: `deriveNewContents`), so a model trained on Codex's
 * `apply_patch` gets what it was trained on, leniency and errors alike. Pure, so a web half reads it too. Beside them,
 * Lemma's `patchPaths`: the files a patch names, which a guard judges before the tool runs.
 *
 * ```
 * *** Begin Patch
 * *** Add File: <path>
 * +<each line of the new file>
 * *** Delete File: <path>
 * *** Update File: <path>
 * *** Move to: <new path>           (optional)
 * @@ <a line the chunk comes after>  (or a bare @@)
 *  <a context line>
 * -<a removed line>
 * +<an added line>
 * *** End of File                   (optional: the chunk ends at the file's end)
 * *** End Patch
 * ```
 */

/** One file's operation in a patch (Codex's `Hunk`), its paths as written. */
export type PatchHunk =
  | { readonly kind: "add"; readonly path: string; readonly contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly movePath?: string; readonly chunks: readonly UpdateFileChunk[] };

/** One `@@` chunk of an updated file (Codex's `UpdateFileChunk`). */
export interface UpdateFileChunk {
  /** The text after `@@ `: a line, usually a class or function's, the chunk comes after. */
  readonly changeContext?: string;
  /** The lines replaced (context and removed), and what replaces them (context and added). */
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  /** Index pairs into `oldLines` and `newLines` of the lines written as context, which keep the file's own bytes. */
  readonly contextLineIndices: readonly (readonly [number, number])[];
  /** `*** End of File`: `oldLines` is sought at the file's end first. */
  readonly isEndOfFile: boolean;
}

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

/** Rust's whitespace (`char::is_whitespace`), which Codex trims: JavaScript's `trim` also takes U+FEFF, and leaves U+0085. */
const WHITESPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING = new RegExp(`^[${WHITESPACE}]+`);
const TRAILING = new RegExp(`[${WHITESPACE}]+$`);
const trimEnd = (text: string): string => text.replace(TRAILING, "");
const trim = (text: string): string => trimEnd(text).replace(LEADING, "");

/** Rust's `str::lines`: split at `\n`, each line without a `\r` ending it, and no empty line after a final `\n`. */
const lines = (text: string): string[] => {
  if (text === "") return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

const invalidPatch = (message: string) => new Error(`invalid patch: ${message}`);
const invalidHunk = (message: string, lineNumber: number) => new Error(`invalid hunk at line ${lineNumber}, ${message}`);
const UNEXPECTED_LINE = "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)";
const VALID_HEADERS = "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

/** `check_patch_boundaries_strict`: the first line, trimmed, begins the patch, and the last ends it. */
function strictBoundaries(patchLines: readonly string[]): readonly string[] {
  const first = patchLines[0] === undefined ? undefined : trim(patchLines[0]);
  const last = patchLines.at(-1) === undefined ? undefined : trim(patchLines.at(-1)!);
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return patchLines;
  if (first !== undefined && first !== BEGIN_PATCH_MARKER) throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
  throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

/** `check_patch_boundaries_lenient`: as strict, or the same inside a heredoc (`<<EOF` … `EOF`), as GPT-4.1 sends it. */
function lenientBoundaries(patchLines: readonly string[]): readonly string[] {
  try {
    return strictBoundaries(patchLines);
  } catch (error) {
    const first = patchLines[0];
    const last = patchLines.at(-1);
    if (patchLines.length >= 4 && (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last !== undefined && last.endsWith("EOF")) {
      return strictBoundaries(patchLines.slice(1, -1));
    }
    throw error;
  }
}

interface MutableChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: [number, number][];
  isEndOfFile: boolean;
}
type MutableHunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: MutableChunk[] };
type Mode = { readonly kind: "not-started" | "started" | "add" | "delete" | "ended" } | { readonly kind: "update"; readonly hunkLineNumber: number };

const emptyChunk = (): MutableChunk => ({ oldLines: [], newLines: [], contextLineIndices: [], isEndOfFile: false });
const pushContextLine = (chunk: MutableChunk, line: string) => {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
};
const isEmptyChunk = (chunk: MutableChunk | undefined) => chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;

/** Codex's `StreamingPatchParser`, given the whole patch at once: `push_delta`, then `finish`. */
function parseHunks(patch: string): MutableHunk[] {
  const hunks: MutableHunk[] = [];
  let mode: Mode = { kind: "not-started" };
  let lineNumber = 0;
  let environmentId: string | undefined;

  const ensureUpdateHunkIsNotEmpty = (line: string) => {
    const last = hunks.at(-1);
    if (last?.kind !== "update") return;
    if (last.chunks.length === 0 && mode.kind === "update") throw invalidHunk(`Update file hunk for path '${last.path}' is empty`, mode.hunkLineNumber);
    if (isEmptyChunk(last.chunks.at(-1))) {
      if (line === END_PATCH_MARKER) throw invalidHunk("Update hunk does not contain any lines", lineNumber);
      throw invalidHunk(`Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE}`, lineNumber);
    }
  };

  const handleHunkHeadersAndEndPatch = (trimmed: string): boolean => {
    if (mode.kind === "started" && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      // Codex picks the environment a patch applies in by it; Lemma has one, so it is read and not used.
      if (environmentId !== undefined) throw invalidPatch("apply_patch environment_id cannot be specified more than once");
      environmentId = trim(trimmed.slice(ENVIRONMENT_ID_MARKER.length));
      if (environmentId === "") throw invalidPatch("apply_patch environment_id cannot be empty");
      return true;
    }
    if (trimmed === END_PATCH_MARKER) {
      ensureUpdateHunkIsNotEmpty(trimmed);
      mode = { kind: "ended" };
      return true;
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      ensureUpdateHunkIsNotEmpty(trimmed);
      hunks.push({ kind: "add", path: trimmed.slice(ADD_FILE_MARKER.length), contents: "" });
      mode = { kind: "add" };
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      ensureUpdateHunkIsNotEmpty(trimmed);
      hunks.push({ kind: "delete", path: trimmed.slice(DELETE_FILE_MARKER.length) });
      mode = { kind: "delete" };
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      ensureUpdateHunkIsNotEmpty(trimmed);
      hunks.push({ kind: "update", path: trimmed.slice(UPDATE_FILE_MARKER.length), chunks: [] });
      mode = { kind: "update", hunkLineNumber: lineNumber };
      return true;
    }
    return false;
  };

  const processUpdateLine = (line: string, hunk: Extract<MutableHunk, { kind: "update" }>) => {
    // Only the end is trimmed: a marker indented is a context line.
    const updateLine = trimEnd(line);
    if (handleHunkHeadersAndEndPatch(updateLine)) return;
    const { chunks } = hunk;
    if (chunks.at(-1)?.isEndOfFile === true) {
      if (updateLine === "") return;
      if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNumber);
      }
    }
    if (chunks.length === 0 && hunk.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
      hunk.movePath = updateLine.slice(MOVE_TO_MARKER.length);
      return;
    }
    if ((updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) && isEmptyChunk(chunks.at(-1))) {
      throw invalidHunk(`Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE}`, lineNumber);
    }
    if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
      chunks.push(emptyChunk());
      return;
    }
    if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      chunks.push({ ...emptyChunk(), changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length) });
      return;
    }
    if (updateLine === EOF_MARKER) {
      if (isEmptyChunk(chunks.at(-1))) throw invalidHunk("Update hunk does not contain any lines", lineNumber);
      const last = chunks.at(-1);
      if (last !== undefined) last.isEndOfFile = true;
      return;
    }
    const current = () => {
      if (chunks.length === 0) chunks.push(emptyChunk());
      return chunks.at(-1)!;
    };
    // A bare empty line is an empty context line.
    if (line === "") return pushContextLine(current(), "");
    if (line.startsWith(" ")) return pushContextLine(current(), line.slice(1));
    if (line.startsWith("+")) return void current().newLines.push(line.slice(1));
    if (line.startsWith("-")) return void current().oldLines.push(line.slice(1));
    const last = chunks.at(-1);
    if (last !== undefined && !isEmptyChunk(last)) throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNumber);
    throw invalidHunk(`Unexpected line found in update hunk: '${line}'. ${UNEXPECTED_LINE}`, lineNumber);
  };

  const processLine = (line: string) => {
    const trimmed = trim(line);
    switch (mode.kind) {
      case "not-started":
        if (trimmed === BEGIN_PATCH_MARKER) {
          mode = { kind: "started" };
          return;
        }
        throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
      case "started":
      case "delete":
        if (handleHunkHeadersAndEndPatch(trimmed)) return;
        throw invalidHunk(`'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`, lineNumber);
      case "add": {
        if (handleHunkHeadersAndEndPatch(trimmed)) return;
        const last = hunks.at(-1);
        if (line.startsWith("+") && last?.kind === "add") {
          last.contents += `${line.slice(1)}\n`;
          return;
        }
        throw invalidHunk(`'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`, lineNumber);
      }
      case "update":
        return processUpdateLine(line, hunks.at(-1) as Extract<MutableHunk, { kind: "update" }>);
      case "ended":
        if (trimmed === "") return;
        throw invalidPatch("The last line of the patch must be '*** End Patch'");
    }
  };

  // `push_delta`: every line a `\n` ends, without a `\r` before it; then `finish`: the rest.
  const split = patch.split("\n");
  const rest = split.pop()!;
  for (const line of split) {
    lineNumber++;
    processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  if (rest !== "") {
    lineNumber++;
    if (trim(rest) === END_PATCH_MARKER) {
      ensureUpdateHunkIsNotEmpty(trim(rest));
      mode = { kind: "ended" };
    } else {
      processLine(rest);
    }
  }
  if (mode.kind !== "ended") throw invalidPatch("The last line of the patch must be '*** End Patch'");
  return hunks;
}

/**
 * What `patch` does, file by file in its order (Codex's `parse_patch`, lenient: a heredoc around it is taken off).
 * Throws an Error with Codex's message: `invalid patch: …`, or `invalid hunk at line <n>, …`, counting the patch's
 * `*** Begin Patch` as line 1.
 */
export function parsePatch(patch: string): readonly PatchHunk[] {
  return parseHunks(lenientBoundaries(lines(trim(patch))).join("\n"));
}

/** `seek_sequence`'s last tier: a line trimmed, with typographic dashes, quotes, and spaces as ASCII. */
const normalise = (line: string): string =>
  trim(line)
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[  -   　]/g, " ");

/**
 * Where `pattern` first occurs in `fileLines` at or after `start` (Codex's `seek_sequence`), trying exactly, then
 * ignoring trailing whitespace, then leading and trailing, then Unicode punctuation as ASCII too: each tier from
 * `start` before the next. With `eof`, from where the pattern would end the file. An empty pattern is at `start`.
 */
export function seekSequence(fileLines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > fileLines.length) return undefined;
  const searchStart = eof ? Math.max(fileLines.length - pattern.length, start) : start;
  const tiers: readonly ((line: string) => string)[] = [(line) => line, trimEnd, trim, normalise];
  for (const compare of tiers) {
    for (let i = searchStart; i <= fileLines.length - pattern.length; i++) {
      if (pattern.every((line, offset) => compare(fileLines[i + offset]!) === compare(line))) return i;
    }
  }
  return undefined;
}

/** A replacement of a file's lines: from `start`, `oldLength` of them, by `newLines`. */
type Replacement = readonly [start: number, oldLength: number, newLines: readonly string[]];

/** Codex's `compute_replacements`: each chunk sought after the last, its context lines left out of what it replaces. */
function computeReplacements(originalLines: readonly string[], path: string, chunks: readonly UpdateFileChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const at = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (at === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      lineIndex = at + 1;
    }
    if (chunk.oldLines.length === 0) {
      // Only added lines: at the file's end.
      replacements.push([originalLines.length, 0, chunk.newLines]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern.at(-1) === "") {
      // An empty last line can stand for the final line break, which here ends the line before it.
      pattern = pattern.slice(0, -1);
      if (newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === undefined) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    // Context lines are on both sides: left in place, so their bytes and line endings stay the file's.
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) break;
      if (oldStart !== oldContext || newStart !== newContext)
        replacements.push([found + oldStart, oldContext - oldStart, newSlice.slice(newStart, newContext)]);
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
    lineIndex = found + pattern.length;
  }
  return replacements.sort((a, b) => a[0] - b[0]);
}

type Ending = "\n" | "\r\n" | "\r";

/**
 * `contents` with `chunks` applied (Codex's `derive_new_contents_from_chunks`, given the text): its lines, each keeping
 * its ending, the replacements made, new lines taking the file's first ending (LF without one), and every line ended.
 * Throws with Codex's message when a chunk's context or lines are not found; `path` names the file in it.
 */
export function deriveNewContents(contents: string, chunks: readonly UpdateFileChunk[], path: string): string {
  // `SourceFile::parse`: the lines, each with its ending.
  const source: { readonly text: string; readonly ending?: Ending }[] = [];
  let preferred: Ending | undefined;
  let lineStart = 0;
  for (let cursor = 0; cursor < contents.length;) {
    const char = contents[cursor];
    const ending: Ending | undefined = char === "\r" ? (contents[cursor + 1] === "\n" ? "\r\n" : "\r") : char === "\n" ? "\n" : undefined;
    if (ending === undefined) {
      cursor++;
      continue;
    }
    preferred ??= ending;
    source.push({ text: contents.slice(lineStart, cursor), ending });
    cursor += ending.length;
    lineStart = cursor;
  }
  if (lineStart < contents.length) source.push({ text: contents.slice(lineStart) });
  const ending = preferred ?? "\n";

  // `SourceFile::apply_replacements`.
  const result: { readonly text: string; readonly ending?: Ending }[] = [];
  let sourceIndex = 0;
  for (const [start, oldLength, newLines] of computeReplacements(
    source.map((line) => line.text),
    path,
    chunks,
  )) {
    if (start < sourceIndex) throw new Error(`Overlapping changes in ${path}`);
    result.push(...source.slice(sourceIndex, start), ...newLines.map((text) => ({ text, ending })));
    sourceIndex = start + oldLength;
  }
  result.push(...source.slice(sourceIndex));
  // Updates have always ended every line, an unterminated last one too.
  return result.map((line) => `${line.text}${line.ending ?? ending}`).join("");
}

/**
 * The paths a patch names, as written, each once: what follows every `*** Add File: `, `*** Delete File: `,
 * `*** Update File: `, and `*** Move to: ` on a line, trimmed as Codex trims its markers, wherever it is and whether
 * or not the patch parses. So they are at least the files `parsePatch` has it change; resolve them as the tool does
 * (`resolveToCwd` in `@lemma/tools/files`).
 */
export function patchPaths(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const trimmed = trim(line);
    const marker = [ADD_FILE_MARKER, DELETE_FILE_MARKER, UPDATE_FILE_MARKER, MOVE_TO_MARKER].find((each) => trimmed.startsWith(each));
    const path = marker === undefined ? "" : trimmed.slice(marker.length);
    if (path !== "") paths.add(path);
  }
  return [...paths];
}
