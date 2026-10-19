import { describe, expect, it } from "vitest";
import { usage } from "@lemma/threads/testing";
import { diffStats, parseDiff, readDetails } from "../src/details.ts";
import { sentTime, summarizeUsage } from "../src/format.ts";

describe("format", () => {
  it("summarizes usage", () => {
    const s = summarizeUsage({ ...usage(1200, 300, 0.02), cacheRead: 5000 });
    expect(s).toMatchObject({ input: "6.2k", output: "300", cache: "5.0k", cost: "$0.020" });
    expect(s.title).toContain("(81% of input)");
  });
});

describe("sentTime", () => {
  const now = new Date(2026, 9, 19, 9, 30).getTime();
  const at = (...parts: [number, number, number, number, number]) => sentTime(new Date(...parts).getTime(), now, "en-US");

  it("says the time today, and the day too before then", () => {
    expect(at(2026, 9, 19, 0, 28).label).toBe("12:28 AM");
    expect(at(2026, 9, 18, 23, 5).label).toBe("Yesterday 11:05 PM");
    expect(at(2026, 9, 17, 0, 28).label).toBe("Oct 17, 12:28 AM");
    expect(at(2025, 11, 31, 18, 0).label).toBe("Dec 31, 2025, 6:00 PM");
  });

  it("says the moment in full for its tooltip", () => {
    expect(at(2026, 9, 19, 0, 28).full).toBe("Monday, October 19, 2026 at 12:28 AM");
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
