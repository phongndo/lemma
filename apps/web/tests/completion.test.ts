import { describe, expect, it } from "vitest";
import { applySuggestion, fileView, findTrigger, mentionPath } from "../src/model/completion.ts";

describe("findTrigger", () => {
  const at = (text: string, triggers: readonly string[] = ["@"]) => findTrigger(text.replace("|", ""), text.indexOf("|"), triggers);

  it("finds the word at the cursor when it starts with a trigger, at the start or after whitespace", () => {
    expect(at("@|")).toEqual({ trigger: "@", query: "", quoted: false, start: 0, end: 1 });
    expect(at("look at @src/ap|")).toEqual({ trigger: "@", query: "src/ap", quoted: false, start: 8, end: 15 });
    expect(at("one\n@co|")).toMatchObject({ query: "co", start: 4 });
  });

  it("ignores a trigger inside a word, a word without one, and a cursor past the word", () => {
    expect(at("mail me@ex|")).toBeUndefined();
    expect(at("plain wor|d")).toBeUndefined();
    expect(at("@src |")).toBeUndefined();
  });

  it("reads the query up to the cursor and replaces the whole word", () => {
    expect(at("@src/a|pp.ts and")).toEqual({ trigger: "@", query: "src/a", quoted: false, start: 0, end: 11 });
  });

  it("reads a quoted word past its spaces, unescaped, up to its closing quote", () => {
    expect(at('see @"my no|')).toEqual({ trigger: "@", query: "my no", quoted: true, start: 4, end: 11 });
    // Inside a finished mention, a pick replaces all of it, quotes included.
    expect(at('@"my| notes/a b.md" next')).toEqual({ trigger: "@", query: "my", quoted: true, start: 0, end: 18 });
    expect(at('@"say \\"hi|')).toMatchObject({ query: 'say "hi', quoted: true });
  });

  it("is done with a quoted word once the cursor passes its closing quote, and keeps to one line", () => {
    expect(at('@"a b"|')).toBeUndefined();
    expect(at('@"a b" and @c|')).toMatchObject({ query: "c", quoted: false, start: 11 });
    expect(at('@"a\nb|')).toBeUndefined();
    expect(at('x"y @|')).toMatchObject({ query: "", quoted: false });
  });

  it("takes the longest trigger that fits", () => {
    expect(at("@@x|", ["@", "@@"])).toMatchObject({ trigger: "@@", query: "x" });
    expect(at("#x|", ["@", "#"])).toMatchObject({ trigger: "#", query: "x" });
  });
});

describe("applySuggestion", () => {
  it("replaces the word and adds a space after it, unless one is there", () => {
    expect(applySuggestion("see @ap", { start: 4, end: 7 }, "@src/app.ts")).toEqual({ text: "see @src/app.ts ", cursor: 16 });
    expect(applySuggestion("@ap and more", { start: 0, end: 3 }, "@src/app.ts")).toEqual({ text: "@src/app.ts and more", cursor: 12 });
  });

  it("leaves a partial word open for typing on", () => {
    expect(applySuggestion("@sr", { start: 0, end: 3 }, "@src/", { space: false })).toEqual({ text: "@src/", cursor: 5 });
  });
});

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
