import { describe, expect, it } from "vitest";
import { MAX_MATCHES, findMatches, pieceAt, step } from "../src/find.ts";

describe("findMatches", () => {
  it("finds every place, ignoring case, without overlaps", () => {
    expect(findMatches("Tests pass; the test aaa", "test")).toEqual([
      { start: 0, end: 4 },
      { start: 16, end: 20 },
    ]);
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("reads the query as text, not a pattern", () => {
    expect(findMatches("a.b axb (c)", "a.b")).toEqual([{ start: 0, end: 3 }]);
    expect(findMatches("f(x) [1]", "(x) [")).toEqual([{ start: 1, end: 6 }]);
  });

  it("keeps the text's own offsets where lowercasing would change its length", () => {
    // "İ".toLowerCase() is two code units long.
    expect(findMatches("İİ ok", "ok")).toEqual([{ start: 3, end: 5 }]);
  });

  it("finds nothing for a blank query, and stops at the most it counts", () => {
    expect(findMatches("a b", " ")).toEqual([]);
    expect(findMatches("a".repeat(MAX_MATCHES + 5), "a")).toHaveLength(MAX_MATCHES);
  });
});

describe("pieceAt", () => {
  // Pieces "ab", "cde", "f" joined: "abcdef".
  const starts = [0, 2, 5];

  it("finds the piece an offset falls in", () => {
    expect(pieceAt(starts, 0)).toEqual({ piece: 0, offset: 0 });
    expect(pieceAt(starts, 3)).toEqual({ piece: 1, offset: 1 });
    expect(pieceAt(starts, 5)).toEqual({ piece: 2, offset: 0 });
  });

  it("reads a boundary as the end of the piece before it, for a match's end", () => {
    expect(pieceAt(starts, 2, true)).toEqual({ piece: 0, offset: 2 });
    expect(pieceAt(starts, 6, true)).toEqual({ piece: 2, offset: 1 });
    expect(pieceAt(starts, 0, true)).toEqual({ piece: 0, offset: 0 });
  });
});

describe("step", () => {
  it("goes round", () => {
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(0, 0, 1)).toBe(0);
  });
});
