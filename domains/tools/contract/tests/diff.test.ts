import { describe, expect, it } from "vitest";
import { unifiedPatch } from "../src/diff.ts";

describe("unifiedPatch", () => {
  it("names both sides, or each", () => {
    expect(unifiedPatch("f.txt", "a\n", "b\n")).toEqual({ patch: "--- f.txt\n+++ f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n", firstChangedLine: 1 });
    expect(unifiedPatch({ from: "/dev/null", to: "new.txt" }, "", "hi\n").patch).toBe("--- /dev/null\n+++ new.txt\n@@ -0,0 +1,1 @@\n+hi\n");
    expect(unifiedPatch("f.txt", "same\n", "same\n")).toEqual({ patch: "" });
  });
});
