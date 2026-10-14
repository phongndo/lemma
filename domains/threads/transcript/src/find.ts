/*
 * Find in the chat: where a query occurs in the transcript's text, and which
 * text node each place falls in. Pure, so the find bar only reads the DOM
 * and highlights.
 */

/** More than this many matches are not counted or highlighted: the first ones are. */
export const MAX_MATCHES = 2000;

export interface Match {
  readonly start: number;
  readonly end: number;
}

/** Where `query` occurs in `text`, ignoring case, without overlaps; nothing for a blank query. */
export function findMatches(text: string, query: string): Match[] {
  if (query.trim() === "") return [];
  // The `i` flag folds case char by char, so offsets stay the text's own (lowercasing can change a string's length).
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const found: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    found.push({ start: match.index, end: match.index + match[0].length });
    if (found.length === MAX_MATCHES) break;
  }
  return found;
}

/**
 * Which piece an offset into the pieces' joined text falls in, and where in
 * it: `starts` are the pieces' offsets, ascending. `end` reads an offset at a
 * boundary as the end of the piece before it, as a match's end is.
 */
export function pieceAt(starts: readonly number[], offset: number, end = false): { readonly piece: number; readonly offset: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (end ? starts[middle]! < offset : starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { piece: low, offset: offset - (starts[low] ?? 0) };
}

/** The match after (or before) `current` among `count`, round. */
export function step(current: number, count: number, by: 1 | -1): number {
  return count === 0 ? 0 : (current + by + count) % count;
}
