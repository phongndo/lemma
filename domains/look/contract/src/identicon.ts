/**
 * An identicon, as GitHub draws an account's default avatar: a 5×5 grid of cells, its two left columns mirrored on the
 * right, the cells and the color both from a hash of a seed (an agent's session id, a profile's name). The same seed
 * draws the same picture everywhere, with nothing stored. Pure, so whatever draws one shares it: the `avatar` part's
 * default and its replacements, and a profile's pattern.
 */
export interface Identicon {
  /** The cells of the left three columns, row by row (15): the right two mirror the left two. */
  readonly cells: readonly boolean[];
  /** The hue of the filled cells, 0–359. */
  readonly hue: number;
}

/** FNV-1a over the string's UTF-16 units, then mixed (murmur3's finalizer), so seeds differing by one character spread. */
const hash = (text: string): number => {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
};

/** The hues a picture is drawn in: eight, apart enough that two pictures side by side never look nearly the same. */
const HUES = 8;

/** How many of its 15 cells a picture fills, at least and at most: a mark, not a dot or a block. */
const FEWEST = 5;
const MOST = 11;

const filledCount = (bits: number) => {
  let count = 0;
  for (let at = 0; at < 15; at++) count += (bits >>> at) & 1;
  return count;
};

export const identicon = (seed: string): Identicon => {
  // Hashed again, salted, until it fills between FEWEST and MOST cells (a few tries at most; past 64, as it is).
  let bits = hash(seed);
  for (let salt = 1; salt <= 64 && (filledCount(bits) < FEWEST || filledCount(bits) > MOST); salt++) bits = hash(`${seed}#${salt}`);
  const cells = Array.from({ length: 15 }, (_, at) => ((bits >>> at) & 1) === 1);
  return { cells, hue: (hash(`${seed}#hue`) % HUES) * (360 / HUES) };
};

/** Whether the cell at `row`, `column` (0–4 each) is filled. */
export const filled = (picture: Identicon, row: number, column: number): boolean => picture.cells[row * 3 + (column < 3 ? column : 4 - column)] === true;
