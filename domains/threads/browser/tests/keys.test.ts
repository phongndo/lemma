import { describe, expect, test } from "vitest";
import { takenFromPages } from "../src/keys.ts";

describe("keys taken from pages", () => {
  test("only those held with a modifier, or a function key", () => {
    expect(takenFromPages("mod+shift+]")).toBe(true);
    expect(takenFromPages("ctrl+tab")).toBe(true);
    expect(takenFromPages("alt+arrowleft")).toBe(true);
    expect(takenFromPages("f5")).toBe(true);
    expect(takenFromPages("n")).toBe(false);
    expect(takenFromPages("shift+a")).toBe(false);
    expect(takenFromPages("+")).toBe(false);
  });
});
