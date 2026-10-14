import { describe, expect, it } from "vitest";
import { changeLines } from "../src/diff.ts";

describe("a change's lines", () => {
  it("are the removed and added lines between what the texts share, with a little context", () => {
    const old = ["a", "b", "c", "d", "e", "f"].join("\n");
    const next = ["a", "b", "c", "D", "e", "f"].join("\n");
    expect(changeLines(old, next)).toEqual([
      { kind: "skipped", text: "1 unchanged lines" },
      { kind: "context", text: "b" },
      { kind: "context", text: "c" },
      { kind: "removed", text: "d" },
      { kind: "added", text: "D" },
      { kind: "context", text: "e" },
      { kind: "context", text: "f" },
    ]);
  });

  it("are all added for a new file, cut at the limit", () => {
    expect(changeLines(null, "x\ny\nz", 2)).toEqual([
      { kind: "added", text: "x" },
      { kind: "added", text: "y" },
      { kind: "skipped", text: "1 more changed lines" },
    ]);
  });
});
