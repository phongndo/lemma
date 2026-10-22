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

export const identicon = (seed: string): Identicon => {
  const bits = hash(seed);
  const cells = Array.from({ length: 15 }, (_, at) => ((bits >>> at) & 1) === 1);
  // Never blank: the middle cell, which no mirror doubles.
  if (!cells.some(Boolean)) cells[7] = true;
  return { cells, hue: hash(`${seed}#hue`) % 360 };
};

/** Whether the cell at `row`, `column` (0–4 each) is filled. */
export const filled = (picture: Identicon, row: number, column: number): boolean => picture.cells[row * 3 + (column < 3 ? column : 4 - column)] === true;
