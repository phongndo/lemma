import { describe, expect, it } from "vitest";
import { unifiedPatch } from "../src/diff.ts";

describe("unifiedPatch", () => {
  it("names both sides, or each", () => {
    expect(unifiedPatch("f.txt", "a\n", "b\n")).toEqual({ patch: "--- f.txt\n+++ f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n", firstChangedLine: 1 });
    expect(unifiedPatch({ from: "/dev/null", to: "new.txt" }, "", "hi\n").patch).toBe("--- /dev/null\n+++ new.txt\n@@ -0,0 +1,1 @@\n+hi\n");
    expect(unifiedPatch("f.txt", "same\n", "same\n")).toEqual({ patch: "" });
  });

  it("keeps only the changes and their context of a long file, wherever they are", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}\n`);
    const before = lines.join("");
    const after = lines.map((line, i) => (i === 9 || i === 9_989 ? `changed ${i + 1}\n` : line)).join("");
    // Two hunks of three lines each, rather than the whole middle deleted and added again.
    expect(unifiedPatch("f.txt", before, after, 1)).toEqual({
      patch:
        "--- f.txt\n+++ f.txt\n@@ -9,3 +9,3 @@\n line 9\n-line 10\n+changed 10\n line 11\n@@ -9989,3 +9989,3 @@\n line 9989\n-line 9990\n+changed 9990\n line 9991\n",
      firstChangedLine: 10,
    });
  });

  it("says a missing final newline changed, at either end", () => {
    expect(unifiedPatch("f", "a\nb", "a\nb\n").patch).toBe("--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
    expect(unifiedPatch("f", "x\na\n", "a\n").patch).toBe("--- f\n+++ f\n@@ -1,2 +1,1 @@\n-x\n a\n");
  });
});
