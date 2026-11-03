import { describe, expect, it } from "vitest";
import { ageOf, displayPath, elapsed, plural, relativeTime, tildePath } from "../src/format.ts";

describe("format", () => {
  it("shortens paths", () => {
    expect(tildePath("/home/me/x", "/home/me")).toBe("~/x");
    expect(tildePath("/home/meow", "/home/me")).toBe("/home/meow");
    expect(displayPath("/w/p/src/a.ts", "/w/p", "/home/me")).toBe("src/a.ts");
    expect(displayPath("/home/me/other", "/w/p", "/home/me")).toBe("~/other");
  });

  it("counts an age in its largest unit, rounded to the nearest", () => {
    const now = 1_000_000_000_000;
    expect(ageOf(now - 30_000, now)).toBeUndefined();
    expect(ageOf(now - 36 * 60_000, now)).toEqual({ count: 36, unit: "m" });
    expect(ageOf(now - (3 * 60 + 40) * 60_000, now)).toEqual({ count: 4, unit: "h" });
    expect(ageOf(now - 50 * 3_600_000, now)).toEqual({ count: 2, unit: "d" });
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - (3 * 60 + 40) * 60_000, now)).toBe("4h ago");
  });

  it("says how long something has run, shortly", () => {
    expect(elapsed(0, 12_000)).toBe("12s");
    expect(elapsed(0, 3 * 60_000)).toBe("3m");
    expect(elapsed(0, 65 * 60_000)).toBe("1h 5m");
    expect(elapsed(10_000, 0)).toBe("0s");
  });

  it("writes a count with its noun, plural unless it is 1", () => {
    expect(plural(1, "tool")).toBe("1 tool");
    expect(plural(0, "tool")).toBe("0 tools");
    expect(plural(3, "queued prompt")).toBe("3 queued prompts");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
});
