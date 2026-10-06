/**
 * Completion in the composer: which word the cursor is in when it starts with
 * a trigger (`@src/ap|`), what picking a suggestion makes of the text, and how
 * a file becomes a mention. Pure, so the composer only wires keys and draws.
 */
import type { FileEntry } from "@lemma/contracts";
import { fuzzy } from "./palette.ts";

export interface TriggerMatch {
  readonly trigger: string;
  /** What follows the trigger, up to the cursor: for a quoted word, inside the quotes and unescaped. */
  readonly query: string;
  /** The word is quoted (`@"my notes/a b.md"`), so it may hold spaces. */
  readonly quoted: boolean;
  /** Where the trigger is: the word a pick replaces runs from here to `end`. */
  readonly start: number;
  /** Where the word ends: past its closing quote, else the whitespace after the cursor. */
  readonly end: number;
}

const wordStart = (text: string, at: number) => at === 0 || /\s/.test(text[at - 1]!);
/** A `"` that no backslash escapes. */
const isQuote = (text: string, at: number) => {
  if (text[at] !== '"') return false;
  let slashes = 0;
  for (let back = at - 1; back >= 0 && text[back] === "\\"; back--) slashes++;
  return slashes % 2 === 0;
};
const unescape = (quoted: string) => quoted.replace(/\\(["\\])/g, "$1");
/** Where the word at `from` ends: the next whitespace, or the end. */
const wordEnd = (text: string, from: number) => {
  let end = from;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return end;
};

/**
 * The word the cursor is in, when it begins with one of `triggers` at the
 * start of the text or after whitespace (so `a@b.c` does not complete). The
 * longest trigger that fits wins, for triggers that share a first character.
 * A trigger followed by `"` starts a quoted word, which runs past spaces to
 * its closing quote, on one line (see `mentionPath`).
 */
export const findTrigger = (text: string, cursor: number, triggers: readonly string[]): TriggerMatch | undefined => {
  if (cursor < 0 || cursor > text.length) return undefined;
  const longestFirst = [...triggers].filter((trigger) => trigger !== "").sort((a, b) => b.length - a.length);
  // Inside a quoted word: the nearest trigger and quote before the cursor on this line, with no closing quote between.
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  for (let at = cursor - 1; at >= lineStart; at--) {
    if (isQuote(text, at)) {
      const trigger = longestFirst.find((candidate) => text.startsWith(candidate, at - candidate.length) && wordStart(text, at - candidate.length));
      if (trigger === undefined) break;
      const newline = text.indexOf("\n", cursor);
      const lineEnd = newline === -1 ? text.length : newline;
      let close = cursor;
      while (close < lineEnd && !isQuote(text, close)) close++;
      // Up to its closing quote; unclosed, up to the whitespace after the cursor.
      const end = close < lineEnd ? close + 1 : wordEnd(text, cursor);
      return { trigger, query: unescape(text.slice(at + 1, cursor)), quoted: true, start: at - trigger.length, end };
    }
  }
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const word = text.slice(start, cursor);
  const trigger = longestFirst.find((candidate) => word.startsWith(candidate));
  // A quoted word whose closing quote is behind the cursor is finished.
  if (trigger === undefined || word.startsWith(`${trigger}"`)) return undefined;
  return { trigger, query: word.slice(trigger.length), quoted: false, start, end: wordEnd(text, cursor) };
};

/**
 * `text` with the matched word replaced by `insert`, and where the cursor goes: after a space (one added unless one
 * follows already), or, without `space`, right after the insert, to go on typing the word.
 */
export const applySuggestion = (
  text: string,
  match: Pick<TriggerMatch, "start" | "end">,
  insert: string,
  options: { readonly space?: boolean } = {},
): { text: string; cursor: number } => {
  const after = text.slice(match.end);
  if (options.space === false) return { text: text.slice(0, match.start) + insert + after, cursor: match.start + insert.length };
  const spaced = /^\s/.test(after) ? insert : `${insert} `;
  // After the space either way: the one added, or the one that was there.
  return { text: text.slice(0, match.start) + spaced + after, cursor: match.start + insert.length + 1 };
};

/**
 * How a path is written after the trigger: as is, or quoted when it has
 * whitespace or quotes (`@"my notes/a b.md"`). `open` leaves a quoted one
 * unclosed, to go on typing inside it (a folder: `@"my notes/`).
 */
export const mentionPath = (path: string, options: { readonly open?: boolean } = {}): string =>
  /[\s"]/.test(path) ? `"${path.replace(/(["\\])/g, "\\$1")}${options.open === true ? "" : '"'}` : path;

interface FileSuggestionView {
  /** The last segment: a file's name, a directory's own. */
  readonly label: string;
  /** The folder it is in, without a trailing slash; empty at the top. */
  readonly detail: string;
  readonly matches: readonly number[];
  readonly detailMatches: readonly number[];
}

/**
 * A file entry split for a row, with the letters the query found marked.
 * Every token of the query is looked for in the whole path; tokens that do
 * not match in order (a typo, which the host's search forgives, or a glob)
 * mark nothing.
 */
export const fileView = (entry: FileEntry, query: string): FileSuggestionView => {
  const slash = entry.path.lastIndexOf("/");
  const label = entry.path.slice(slash + 1);
  const detail = slash === -1 ? "" : entry.path.slice(0, slash);
  const marked = new Set<number>();
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const index of fuzzy(entry.path, token)?.matches ?? []) marked.add(index);
  }
  const indices = [...marked].sort((a, b) => a - b);
  return {
    label,
    detail,
    matches: indices.filter((index) => index > slash).map((index) => index - slash - 1),
    detailMatches: indices.filter((index) => index < slash),
  };
};
