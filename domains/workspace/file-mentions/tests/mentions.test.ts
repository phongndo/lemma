import { describe, expect, it } from "vitest";
import { findTrigger } from "@lemma/threads";
import { fileView, mentionPath } from "../src/mentions.ts";

describe("mentionPath", () => {
  it("writes plain paths as they are and quotes those with spaces or quotes", () => {
    expect(mentionPath("src/app.ts")).toBe("src/app.ts");
    expect(mentionPath("my notes/a b.md")).toBe('"my notes/a b.md"');
    expect(mentionPath('say "hi".txt')).toBe('"say \\"hi\\".txt"');
  });

  it("leaves an open folder's quote unclosed, which findTrigger reads back as the same path", () => {
    expect(mentionPath("my notes/", { open: true })).toBe('"my notes/');
    expect(mentionPath("src/", { open: true })).toBe("src/");
    const text = `@${mentionPath("my notes/", { open: true })}`;
    expect(findTrigger(text, text.length, ["@"])).toMatchObject({ query: "my notes/", quoted: true, start: 0, end: text.length });
  });
});

describe("fileView", () => {
  it("splits the name from its folder and marks what each token matched in either", () => {
    expect(fileView({ path: "src/components/Composer.tsx", kind: "file" }, "comp")).toEqual({
      label: "Composer.tsx",
      detail: "src/components",
      matches: [],
      detailMatches: [4, 5, 6, 7],
    });
    expect(fileView({ path: "src/components/Composer.tsx", kind: "file" }, "src tsx")).toMatchObject({
      matches: [9, 10, 11],
      detailMatches: [0, 1, 2],
    });
  });

  it("marks nothing for a token that does not match in order, and has no folder at the top", () => {
    expect(fileView({ path: "README.md", kind: "file" }, "rdaeme")).toEqual({ label: "README.md", detail: "", matches: [], detailMatches: [] });
  });
});
