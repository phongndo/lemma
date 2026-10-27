/**
 * How a tool's output is bounded for the model, by one budget: the text characters a result keeps
 * (`ToolContext.maxResultChars`, the registry's `maxResultChars`). Past it, a text keeps its start and its end around
 * a marker saying what was left out and where the rest is (`keepEnds`); a tool that pages or ranks what it returns
 * (`read`, `grep`) keeps the start, its marker saying how to go on (`keepHead`). Both markers read alike:
 * `[… 1200 lines left out: showing lines 1-400 and 1601-2000 of 2000. Full output: /tmp/…]`. `boundOutput`
 * (`@lemma/tools/files`) is `keepEnds` with the whole text saved to a file the model can read.
 */

/** The text characters a result keeps when the call names no budget (`ToolContext.maxResultChars`). */
export const DEFAULT_MAX_RESULT_CHARS = 50_000;

/** Room a tool leaves under the budget for lines of its own around its output: a command's exit code, a header. */
const NOTES_CHARS = 1_000;

/**
 * What a tool keeps of its own output for a call: the call's budget less room for lines of its own, so the registry,
 * which cuts a result past the budget, does not cut it again.
 */
export const outputBudget = (maxResultChars: number | undefined): number => Math.max(0, (maxResultChars ?? DEFAULT_MAX_RESULT_CHARS) - NOTES_CHARS);

/**
 * A text as `keepEnds` reads it: its start, its end, and how long all of it is. A whole text is its own `head` and
 * `tail`; one streamed (a command's output) keeps at least the budget's worth of each.
 */
export interface TextEnds {
  readonly head: string;
  readonly tail: string;
  /** The whole text's length, in characters. */
  readonly chars: number;
  /** Its lines (`lineCount`). */
  readonly lines: number;
}

/** What a bound left out of a text, for a result's details: the whole text's characters and lines, and those it kept. */
export interface Cut {
  readonly chars: number;
  readonly lines: number;
  readonly kept: number;
}

export interface Kept {
  /** The text, whole, or cut with its marker. */
  readonly text: string;
  /** Present when it was cut. */
  readonly cut?: Cut;
}

/** The lines of a text: a final newline ends its last line rather than starting another. */
export const lineCount = (text: string): number => (text === "" ? 0 : newlines(text) + (text.endsWith("\n") ? 0 : 1));

const newlines = (text: string): number => {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
  return count;
};

/** The longest a marker is with its numbers and the blank lines around it, but for what it says of the rest. */
const MARKER_CHARS = 160;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const span = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from}-${to}`);
const marker = (left: string, showing: string, rest: string) => `[… ${left} left out: showing ${showing}.${rest === "" ? "" : ` ${rest}`}]`;
/** A text before its marker, without the newline ending its last line: the marker's blank line comes after it. */
const before = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);

/**
 * `ends` within `budget` characters: whole when it fits, else its start and its end, each whole lines unless a single
 * line is longer than its half, around a marker saying what was left out and then `rest` (where the whole is).
 */
export function keepEnds(ends: TextEnds, budget: number, rest: string): Kept {
  const { head, tail, chars, lines } = ends;
  if (chars <= budget) return { text: head };
  const room = Math.max(0, budget - MARKER_CHARS - rest.length);
  // The head's whole lines, or the start of a first line too long for its half.
  let headEnd = Math.min(Math.ceil(room / 2), head.length);
  if (headEnd > 0 && head[headEnd - 1] !== "\n" && head[headEnd] !== "\n") {
    const newline = head.lastIndexOf("\n", headEnd - 1);
    if (newline !== -1) headEnd = newline + 1;
  }
  const kept = head.slice(0, headEnd);
  const headCut = kept !== "" && !kept.endsWith("\n") && head[headEnd] !== "\n";
  // The tail's whole lines, or the end of a last line too long for its half.
  let tailLength = Math.min(room - headEnd, tail.length);
  const startsLine = (length: number) => length === tail.length || tail[tail.length - length - 1] === "\n";
  if (tailLength > 0 && !startsLine(tailLength)) {
    const newline = tail.indexOf("\n", tail.length - tailLength);
    if (newline !== -1 && newline < tail.length - 1) tailLength = tail.length - newline - 1;
  }
  const end = tailLength === 0 ? "" : tail.slice(-tailLength);
  const tailCut = end !== "" && !startsLine(tailLength);

  const headTo = lineCount(kept);
  const tailFrom = end === "" ? lines + 1 : lines - lineCount(end) + 1;
  const omittedLines = Math.max(0, tailFrom - headTo - 1);
  const left = omittedLines > 0 ? plural(omittedLines, "line") : plural(chars - kept.length - end.length, "character");
  // "lines 1-40 and 961-1000": a second span of lines says "lines" once.
  const tailSpan = !headCut && headTo > 1 && tailFrom < lines ? `${tailFrom}-${lines}` : span(tailFrom, lines);
  const shown = [
    ...(kept === "" ? [] : [headCut ? `the start of line ${headTo}` : span(1, headTo)]),
    ...(end === "" ? [] : [tailCut ? `the end of line ${tailFrom}` : kept === "" ? span(tailFrom, lines) : tailSpan]),
  ];
  const showing =
    shown.length === 0 ? `none of its ${plural(lines, "line")}` : lines === 1 ? "the start and the end of its one line" : `${shown.join(" and ")} of ${lines}`;
  const text = [...(kept === "" ? [] : [before(kept)]), marker(left, showing, rest), ...(end === "" ? [] : [end])].join("\n\n");
  return { text, cut: { chars, lines, kept: kept.length + end.length } };
}

/**
 * Where a text `keepHead` cut stops: the line after its last whole one, or the line it cut partway (`partial`), of which
 * it kept `kept` characters.
 */
export interface HeadEnd {
  readonly next: number;
  readonly partial: boolean;
  readonly kept: number;
}

export interface HeadOptions {
  /** The number of the text's first line in what it is part of (a file's lines): 1 by default. */
  readonly from?: number;
  /**
   * The lines of what it is part of, when known; the text's own by default. A text ending before its last line gets a
   * marker whether it fits or not; undefined: a total nobody counted, the marker saying only that the rest is left out.
   */
  readonly of?: number | undefined;
  /** What the marker says after what it left out: how to go on (`Use offset=2001 to continue`). */
  readonly rest: (end: HeadEnd) => string;
}

/**
 * `text` within `budget` characters for a tool that pages or ranks what it returns: its start, whole lines unless its
 * first line alone is too long, then a marker saying what was left out and how to go on (`rest`).
 */
export function keepHead(text: string, budget: number, options: HeadOptions): Kept {
  const from = options.from ?? 1;
  const last = from + lineCount(text) - 1;
  const total = "of" in options ? options.of : last;
  if (text.length <= budget) {
    if (total !== undefined && last >= total) return { text };
    const left = total === undefined ? "the rest" : plural(total - last, "line");
    const note = marker(left, span(from, last) + (total === undefined ? "" : ` of ${total}`), options.rest({ next: last + 1, partial: false, kept: 0 }));
    return { text: text === "" ? note : `${before(text)}\n\n${note}` };
  }
  // The rest's length with the longest numbers it can have.
  const room = Math.max(0, budget - MARKER_CHARS - options.rest({ next: last + 1, partial: true, kept: text.length }).length);
  let end = Math.min(room, text.length);
  if (end > 0 && text[end - 1] !== "\n" && text[end] !== "\n") {
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline !== -1) end = newline + 1;
  }
  const kept = text.slice(0, end);
  // Cut partway through its first line, the only one it shows: no newline came before the budget.
  const partial = !kept.endsWith("\n") && text[end] !== "\n";
  const shownTo = from + Math.max(1, lineCount(kept)) - 1;
  const after = total === undefined ? "the rest" : plural(total - shownTo, "line");
  const left = !partial ? after : total === shownTo ? `the rest of line ${shownTo}` : `the rest of line ${shownTo} and ${after} after it`;
  const showing = partial ? `the first ${plural(kept.length, "character")} of line ${shownTo}` : span(from, shownTo);
  const note = marker(
    left,
    `${showing}${total === undefined ? "" : ` of ${total}`}`,
    options.rest(partial ? { next: shownTo, partial, kept: kept.length } : { next: shownTo + 1, partial, kept: 0 }),
  );
  return { text: kept === "" ? note : `${before(kept)}\n\n${note}`, cut: { chars: text.length, lines: total ?? last, kept: kept.length } };
}

/** A size a person reads: `512B`, `48.0KB`, `2.3MB`. */
export function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}
