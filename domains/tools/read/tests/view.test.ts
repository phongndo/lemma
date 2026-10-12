import { describe, expect, it } from "vitest";
import { readView } from "../src/view.ts";

describe("readView", () => {
  it("shows the file, from the session's directory, and the lines read", () => {
    expect(readView.summary?.({ path: "/w/a.ts", offset: 10, limit: 5 }, { cwd: "/w" })).toEqual({
      primary: "a.ts",
      secondary: "lines 10–14",
      file: { path: "a.ts", kind: "file" },
    });
    expect(readView.summary?.({ path: "/w/a.ts", offset: 10 }, { cwd: "/w" })).toMatchObject({ secondary: "lines 10+" });
    expect(readView.summary?.(undefined, {})).toEqual({});
  });
});
