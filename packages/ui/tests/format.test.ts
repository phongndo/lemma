import { describe, expect, it } from "vitest";
import { displayPath, tildePath } from "../src/format.ts";

describe("format", () => {
  it("shortens paths", () => {
    expect(tildePath("/home/me/x", "/home/me")).toBe("~/x");
    expect(tildePath("/home/meow", "/home/me")).toBe("/home/meow");
    expect(displayPath("/w/p/src/a.ts", "/w/p", "/home/me")).toBe("src/a.ts");
    expect(displayPath("/home/me/other", "/w/p", "/home/me")).toBe("~/other");
  });
});
