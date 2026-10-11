/**
 * Search: the command palette's fuzzy matching, ranking, and the prefixes
 * that narrow a search to one kind of item, and the plain word match lists
 * filter by (`matchesQuery`). Pure, so the palette component only decides what
 * the items are and what choosing one does.
 */

/** True when every word of `query` appears in `text`, ignoring case; an empty query matches everything. */
export const matchesQuery = (query: string, text: string): boolean => {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

interface Match {
  readonly score: number;
  /** Indices into the text that matched, for highlighting. */
  readonly matches: readonly number[];
}

const SEPARATOR = /[\s\-_/.:·()]/;

const wordStart = (text: string, index: number): boolean => {
  if (index === 0) return true;
  const before = text[index - 1]!;
  const here = text[index]!;
  return SEPARATOR.test(before) || (before === before.toLowerCase() && here !== here.toLowerCase());
};

/**
 * Scores `text` against one lower-case `token`, or undefined when its letters
 * are not all there in order. A whole-word or prefix hit beats a substring, a
 * substring beats scattered letters, and scattered letters score higher when
 * they start words (`sb` finds "Switch branch") or run together.
 */
export const fuzzy = (text: string, token: string): Match | undefined => {
  if (token === "") return { score: 0, matches: [] };
  const lower = text.toLowerCase();
  const at = lower.indexOf(token);
  if (at !== -1) {
    // Prefer a later hit that starts a word over an earlier one inside a word.
    let best = at;
    for (let from = at; from !== -1; from = lower.indexOf(token, from + 1)) {
      if (wordStart(text, from)) {
        best = from;
        break;
      }
    }
    const score = 100 + (best === 0 ? 40 : wordStart(text, best) ? 25 : 0) + (token.length === lower.length ? 30 : 0) - Math.min(best, 20) / 2;
    return { score, matches: Array.from({ length: token.length }, (_, i) => best + i) };
  }
  // Jumping ahead to word starts can skip letters a later character needs, so fall back to the plain walk.
  const matches = scatter(text, lower, token, true) ?? scatter(text, lower, token, false);
  if (matches === undefined) return undefined;
  let score = 0;
  matches.forEach((index, i) => {
    score += 1 + (wordStart(text, index) ? 8 : 0) + (i > 0 && index === matches[i - 1]! + 1 ? 5 : 0);
  });
  // Scattered letters never outrank a substring.
  return { score: Math.min(score, 90) - (matches.at(-1)! - matches[0]!) / 10, matches };
};

/** The positions of `token`'s letters in order, taking for each the next one that starts a word when `wordStarts`. */
const scatter = (text: string, lower: string, token: string, wordStarts: boolean): number[] | undefined => {
  const matches: number[] = [];
  let from = 0;
  for (const char of token) {
    let found = lower.indexOf(char, from);
    if (found === -1) return undefined;
    if (wordStarts) {
      for (let next = found; next !== -1; next = lower.indexOf(char, next + 1)) {
        if (wordStart(text, next)) {
          found = next;
          break;
        }
      }
    }
    matches.push(found);
    from = found + 1;
  }
  return matches;
};

export interface Searchable {
  /** Stable across sessions, for remembering recent choices. */
  readonly key: string;
  readonly title: string;
  /** Matched, but more weakly than the title and without highlighting. */
  readonly keywords?: readonly string[] | undefined;
}

interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  /** Title indices to highlight. */
  readonly matches: readonly number[];
}

/**
 * Every whitespace-separated token must match the title or, at half weight,
 * the keywords. Results sort by score, then by how recently each was chosen,
 * then in their given order.
 */
export const rank = <T extends Searchable>(items: readonly T[], query: string, recent: readonly string[] = []): Ranked<T>[] => {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const recency = new Map(recent.map((key, index) => [key, recent.length - index]));
  const ranked: (Ranked<T> & { readonly order: number })[] = [];
  items.forEach((item, order) => {
    let score = 0;
    const matches = new Set<number>();
    const extra = item.keywords?.join(" ") ?? "";
    for (const token of tokens) {
      const inTitle = fuzzy(item.title, token);
      if (inTitle !== undefined) {
        score += inTitle.score;
        for (const index of inTitle.matches) matches.add(index);
        continue;
      }
      const inExtra = extra === "" ? undefined : fuzzy(extra, token);
      if (inExtra === undefined) return;
      score += inExtra.score / 2;
    }
    ranked.push({
      item,
      score: score + (tokens.length > 0 ? Math.min(recency.get(item.key) ?? 0, 10) : 0),
      matches: [...matches].sort((a, b) => a - b),
      order,
    });
  });
  return ranked
    .sort((a, b) => b.score - a.score || (recency.get(b.item.key) ?? 0) - (recency.get(a.item.key) ?? 0) || a.order - b.order)
    .map(({ item, score, matches }) => ({ item, score, matches }));
};

/**
 * `text` split into runs that did and did not match. `matches` index UTF-16
 * code units, as `fuzzy` returns them, so a title with emoji highlights the
 * right letters.
 */
export const highlight = (text: string, matches: readonly number[]): { text: string; hit: boolean }[] => {
  const hit = new Set(matches);
  const parts: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = parts.at(-1);
    if (last !== undefined && last.hit === hit.has(index)) last.text += text[index];
    else parts.push({ text: text[index]!, hit: hit.has(index) });
  }
  return parts;
};

/**
 * A leading prefix narrows the search to one source, as in editors (`>`
 * commands, `@` sessions, `#` projects): the longest of `prefixes` the query
 * starts with, and the text after it.
 */
export const parseQuery = (raw: string, prefixes: readonly string[]): { readonly prefix?: string; readonly text: string } => {
  const prefix = prefixes.filter((candidate) => candidate !== "" && raw.startsWith(candidate)).sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? { text: raw } : { prefix, text: raw.slice(prefix.length) };
};

/** Most recent first, without duplicates, at most `limit`. */
export const remember = (recent: readonly string[], key: string, limit = 20): string[] => [key, ...recent.filter((item) => item !== key)].slice(0, limit);
