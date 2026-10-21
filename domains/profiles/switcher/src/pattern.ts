/*
 * A profile's pattern, as GitHub draws an account with no picture of its own (its identicon): a 5×5 grid whose left
 * three columns come from a hash of a seed and whose right two mirror them, in one of a few hues. The same seed makes
 * the same pattern everywhere, and different seeds rarely make one alike, so a profile has a mark of its own before
 * anyone chooses one. Pure, so it is tested without a page.
 */

/** The hues a pattern is drawn in: the tokens `--profile-hue-0` to `--profile-hue-7` (`web.css`). */
export const HUES = 8;

/** 32 bits of `seed`: FNV-1a over its UTF-16 units, then MurmurHash3's finalizer, so seeds alike hash apart. */
const hash = (seed: string, salt: number): number => {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

/** The pattern a seed makes: its 25 cells, row by row, and its hue. */
export interface Pattern {
  readonly cells: readonly boolean[];
  readonly hue: number;
}

/**
 * The pattern `seed` makes. One with too few or too many cells filled reads as no shape, so the seed is hashed again
 * (salted) until it makes one with between 6 and 19, as nearly every seed does at once.
 */
export const patternOf = (seed: string): Pattern => {
  for (let salt = 0; ; salt++) {
    const bits = hash(seed, salt);
    const cells = Array.from({ length: 25 }, (_, index) => {
      const row = Math.floor(index / 5);
      const column = index % 5;
      return ((bits >>> (row * 3 + (column < 3 ? column : 4 - column))) & 1) === 1;
    });
    const filled = cells.filter(Boolean).length;
    if ((filled >= 6 && filled <= 19) || salt >= 16) return { cells, hue: hash(seed, salt + 1000) % HUES };
  }
};

/** A seed no profile is likely to have had: for a pattern of its own. */
export const randomSeed = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
