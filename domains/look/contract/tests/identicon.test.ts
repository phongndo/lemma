import { describe, expect, it } from "vitest";
import { filled, identicon } from "../src/identicon.ts";

describe("identicon", () => {
  it("draws the same picture for the same seed, and another for another", () => {
    expect(identicon("s_7f3a91c2")).toEqual(identicon("s_7f3a91c2"));
    const seeds = Array.from({ length: 200 }, (_, n) => `session-${n}`);
    const pictures = new Set(seeds.map((seed) => JSON.stringify(identicon(seed))));
    // 15 bits and a hue: two hundred seeds all but never meet.
    expect(pictures.size).toBeGreaterThan(195);
  });

  it("mirrors its left two columns on the right, and is never blank", () => {
    for (let n = 0; n < 500; n++) {
      const picture = identicon(`seed-${n}`);
      expect(picture.cells).toHaveLength(15);
      expect(picture.hue).toBeGreaterThanOrEqual(0);
      expect(picture.hue).toBeLessThan(360);
      expect(picture.cells.some(Boolean)).toBe(true);
      for (let row = 0; row < 5; row++) {
        expect(filled(picture, row, 4)).toBe(filled(picture, row, 0));
        expect(filled(picture, row, 3)).toBe(filled(picture, row, 1));
      }
    }
  });

  it("fills a mark, not a dot or a block, in one of eight hues apart", () => {
    for (let n = 0; n < 500; n++) {
      const picture = identicon(`profile-${n}`);
      const count = picture.cells.filter(Boolean).length;
      expect(count).toBeGreaterThanOrEqual(5);
      expect(count).toBeLessThanOrEqual(11);
      expect(picture.hue % 45).toBe(0);
    }
  });

  it("spreads hues over the wheel", () => {
    const hues = Array.from({ length: 360 }, (_, n) => identicon(`agent-${n}`).hue);
    const sextants = new Set(hues.map((hue) => Math.floor(hue / 60)));
    expect(sextants.size).toBe(6);
  });
});
