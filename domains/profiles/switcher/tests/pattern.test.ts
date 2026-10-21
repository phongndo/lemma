import { describe, expect, it } from "vitest";
import { HUES, patternOf, randomSeed } from "../src/pattern.ts";

describe("a profile's pattern", () => {
  it("is the same for a seed everywhere, mirrored left to right, in one of the hues", () => {
    const pattern = patternOf("research");
    expect(patternOf("research")).toEqual(pattern);
    expect(pattern.cells).toHaveLength(25);
    for (let row = 0; row < 5; row++) {
      const cells = pattern.cells.slice(row * 5, row * 5 + 5);
      expect(cells).toEqual([...cells].reverse());
    }
    expect(pattern.hue).toBeGreaterThanOrEqual(0);
    expect(pattern.hue).toBeLessThan(HUES);
  });

  it("reads as a shape, and seeds alike make patterns apart", () => {
    const seeds = ["default", "desk", "work", "research", "writing", "a", "b", ...Array.from({ length: 200 }, (_, i) => `profile-${i}`)];
    const patterns = seeds.map(patternOf);
    for (const { cells } of patterns) {
      const filled = cells.filter(Boolean).length;
      expect(filled).toBeGreaterThanOrEqual(6);
      expect(filled).toBeLessThanOrEqual(19);
    }
    const distinct = new Set(patterns.map(({ cells, hue }) => `${hue}:${cells.map(Number).join("")}`));
    expect(distinct.size).toBe(seeds.length);
    // Every hue is used.
    expect(new Set(patterns.map(({ hue }) => hue)).size).toBe(HUES);
    expect(randomSeed()).toMatch(/^[0-9a-f]{12}$/);
  });
});
