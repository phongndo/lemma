import { describe, expect, it } from "vitest";
import { patchView } from "../src/view.ts";

const lines = ["*** Begin Patch", "*** Update File: /w/src/a.ts", "-x", "+y", "*** Add File: src/b.ts", "+b", "*** Delete File: c.ts", "*** End Patch"];

describe("patchView", () => {
  it("shows the first file the patch names, from the session's directory, and how many more", () => {
    const first = { primary: "src/a.ts", file: { path: "src/a.ts", kind: "file" } };
    expect(patchView.summary?.({ input: lines.join("\n") }, { cwd: "/w" })).toEqual({ ...first, secondary: "and 2 more" });
    expect(patchView.summary?.({ input: lines.slice(0, 4).join("\n") }, { cwd: "/w" })).toEqual(first);
    expect(patchView.summary?.({}, { cwd: "/w" })).toEqual({});
  });
});
