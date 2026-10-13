import { describe, expect, it } from "vitest";
import { usage } from "@lemma/threads/testing";
import { diffStats, parseDiff, readDetails } from "../src/details.ts";
import { summarizeUsage } from "../src/format.ts";

describe("format", () => {
  it("summarizes usage", () => {
    const s = summarizeUsage({ ...usage(1200, 300, 0.02), cacheRead: 5000 });
    expect(s).toMatchObject({ input: "6.2k", output: "300", cache: "5.0k", cost: "$0.020" });
    expect(s.title).toContain("(81% of input)");
  });
});

describe("details", () => {
  it("reads known shapes and ignores the rest", () => {
    expect(readDetails({ diff: "+a", exitCode: 2, truncation: { truncated: true }, fullOutputPath: "/tmp/x" })).toEqual({
      diff: "+a",
      exitCode: 2,
      truncated: true,
      fullOutputPath: "/tmp/x",
    });
    expect(readDetails("nope")).toEqual({});
    expect(readDetails({ exitCode: "0" })).toEqual({});
  });

  it("parses unified diffs", () => {
    const lines = parseDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n");
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "ctx"]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });
});
