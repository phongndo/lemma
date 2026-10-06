import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { Schema, SchemaTransformation } from "effect";
import type { Tool } from "@lemma/contracts";
import { unifiedPatch } from "./diff.ts";
import { fsMessage, resolveToCwd, text, throwIfAborted, withFileLock } from "./files.ts";

const Replacement = Schema.Struct({
  oldText: Schema.String.annotate({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Schema.String.annotate({ description: "Replacement text for this targeted edit." }),
});

const EditFields = Schema.Struct({
  path: Schema.String.annotate({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Schema.Array(Replacement).annotate({
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
  }),
});

type Edit = typeof Replacement.Type;

const isEdit = (value: unknown): value is Edit =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Edit).oldText === "string" &&
  typeof (value as Edit).newText === "string";

/**
 * Repairs shapes models are known to send, as pi does: `edits` as a JSON
 * string or a single object, and the older top-level `oldText`/`newText`.
 * Anything else passes through to validation unchanged.
 */
function prepare(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const args: Record<string, unknown> = { ...input };
  if (typeof args["edits"] === "string") {
    try {
      const parsed: unknown = JSON.parse(args["edits"]);
      if (Array.isArray(parsed)) args["edits"] = parsed;
      else if (isEdit(parsed)) args["edits"] = [parsed];
    } catch {
      // Left for validation to report.
    }
  } else if (isEdit(args["edits"])) {
    args["edits"] = [args["edits"]];
  }
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") {
    const { oldText, newText, ...rest } = args;
    return { ...rest, edits: [...(Array.isArray(args["edits"]) ? args["edits"] : []), { oldText, newText }] };
  }
  return args;
}

/**
 * Accepts the repaired shapes; the model is shown only the canonical `{ path, edits }` schema, which a
 * check that passes everything carries to JSON Schema on the otherwise unconstrained encoded side.
 */
export const EditInput = Schema.Unknown.check(
  Schema.makeFilter(() => true, { toJsonSchema: () => Schema.toJsonSchemaDocument(EditFields, { onExcessProperty: "error" }).schema }),
).pipe(
  Schema.decodeTo(EditFields, SchemaTransformation.transform({ decode: (input) => prepare(input) as typeof EditFields.Encoded, encode: (value) => value })),
);
export type EditInput = typeof EditFields.Type;

export interface EditDetails {
  readonly path: string;
  /** Unified diff of the change, for UIs. */
  readonly patch: string;
  readonly firstChangedLine?: number;
}

const detectLineEnding = (content: string): "\r\n" | "\n" => {
  const lf = content.indexOf("\n");
  const crlf = content.indexOf("\r\n");
  return lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
};
const normalizeToLF = (value: string) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const restoreLineEndings = (value: string, ending: "\r\n" | "\n") => (ending === "\r\n" ? value.replace(/\n/g, "\r\n") : value);

/** Counts overlapping matches too: "}\n}\n" occurs twice in "}\n}\n}\n". */
const occurrences = (haystack: string, needle: string): number => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
};

/**
 * Applies every edit to the same original text. Matching is exact (after
 * normalizing line endings to LF): no match, several matches, overlaps, and a
 * no-op are errors that leave the file unchanged.
 */
export function applyEdits(content: string, edits: readonly Edit[], display: string): string {
  const one = edits.length === 1;
  const matched = edits
    .map((edit, index) => {
      const oldText = normalizeToLF(edit.oldText);
      if (oldText.length === 0) throw new Error(one ? `oldText must not be empty in ${display}.` : `edits[${index}].oldText must not be empty in ${display}.`);
      const at = content.indexOf(oldText);
      if (at === -1) {
        throw new Error(
          one
            ? `Could not find the exact text in ${display}. The old text must match exactly including all whitespace and newlines.`
            : `Could not find edits[${index}] in ${display}. The oldText must match exactly including all whitespace and newlines.`,
        );
      }
      const count = occurrences(content, oldText);
      if (count > 1) {
        throw new Error(
          one
            ? `Found ${count} occurrences of the text in ${display}. The text must be unique. Please provide more context to make it unique.`
            : `Found ${count} occurrences of edits[${index}] in ${display}. Each oldText must be unique. Please provide more context to make it unique.`,
        );
      }
      return { index, at, length: oldText.length, newText: normalizeToLF(edit.newText) };
    })
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < matched.length; i++) {
    const previous = matched[i - 1]!;
    const current = matched[i]!;
    if (previous.at + previous.length > current.at) {
      throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap in ${display}. Merge them into one edit or target disjoint regions.`);
    }
  }
  let result = content;
  for (let i = matched.length - 1; i >= 0; i--) {
    const { at, length, newText } = matched[i]!;
    result = result.slice(0, at) + newText + result.slice(at + length);
  }
  if (result === content) {
    throw new Error(
      one
        ? `No changes made to ${display}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${display}. The replacements produced identical content.`,
    );
  }
  return result;
}

export const editTool: Tool<EditInput> = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  input: EditInput,
  execute: async ({ path, edits }, { cwd, signal }) => {
    if (edits.length === 0) throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    const absolute = resolveToCwd(path, cwd);
    return withFileLock(absolute, async () => {
      throwIfAborted(signal);
      try {
        await access(absolute, constants.R_OK | constants.W_OK);
      } catch (cause) {
        throw new Error(`Could not edit file: ${fsMessage(cause, path)}`);
      }
      const raw = (await readFile(absolute)).toString("utf8");
      throwIfAborted(signal);
      // The model never includes an invisible BOM in oldText; keep it out of matching and put it back.
      const bom = raw.startsWith("﻿") ? "﻿" : "";
      const content = raw.slice(bom.length);
      const ending = detectLineEnding(content);
      const before = normalizeToLF(content);
      const after = applyEdits(before, edits, path);
      await writeFile(absolute, bom + restoreLineEndings(after, ending), "utf8");
      const { patch, firstChangedLine } = unifiedPatch(path, before, after);
      const details: EditDetails = { path: absolute, patch, ...(firstChangedLine === undefined ? {} : { firstChangedLine }) };
      return text(`Successfully replaced ${edits.length} block(s) in ${path}.`, details);
    });
  },
};
