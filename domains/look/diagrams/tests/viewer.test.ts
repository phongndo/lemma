import { describe, expect, it } from "vitest";
import { viewerScale } from "../src/viewer.ts";

describe("viewerScale", () => {
  it("enlarges a diagram that fits the window, up to 3×", () => {
    expect(viewerScale(400, 200, 1200, 800)).toBe(3);
    expect(viewerScale(600, 200, 1200, 800)).toBe(2);
  });
  it("enlarges a tall diagram for legibility and lets it scroll, rather than shrinking it to the height", () => {
    expect(viewerScale(168, 1161, 1184, 704)).toBe(2);
  });
  it("shrinks a diagram wider than the window to its width", () => {
    expect(viewerScale(2400, 300, 1200, 800)).toBe(0.5);
  });
});
