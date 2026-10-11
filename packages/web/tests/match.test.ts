import { describe, expect, it } from "vitest";
import { fuzzy, highlight, parseQuery, rank, remember } from "../src/match.ts";

describe("fuzzy", () => {
  it("matches a substring and highlights it, preferring one that starts a word", () => {
    expect(fuzzy("Switch branch", "bra")).toMatchObject({ matches: [7, 8, 9] });
    expect(fuzzy("Unbranch branch", "bra")!.matches).toEqual([9, 10, 11]);
  });

  it("finds initials and scattered letters in order, and nothing out of order", () => {
    expect(fuzzy("Switch branch", "sb")!.matches).toEqual([0, 7]);
    expect(fuzzy("Reload config", "rlc")).toBeDefined();
    expect(fuzzy("Reload config", "cr")).toBeUndefined();
  });

  it("falls back when jumping to a word start would strand a later letter", () => {
    expect(fuzzy("xaxb a", "ab")!.matches).toEqual([1, 3]);
  });

  it("ranks exact over prefix over word start over inside a word over scattered", () => {
    const score = (text: string, token: string) => fuzzy(text, token)!.score;
    expect(score("model", "model")).toBeGreaterThan(score("models", "model"));
    expect(score("models", "model")).toBeGreaterThan(score("Switch model", "model"));
    expect(score("Switch model", "model")).toBeGreaterThan(score("remodel", "model"));
    expect(score("remodel", "model")).toBeGreaterThan(score("my own delta light", "model"));
  });

  it("splits camelCase into words", () => {
    expect(fuzzy("newChat", "c")!.matches).toEqual([3]);
  });
});

describe("rank", () => {
  const items = [
    { key: "a", title: "New chat" },
    { key: "b", title: "Switch branch…", keywords: ["git", "checkout"] },
    { key: "c", title: "Switch model…" },
    { key: "d", title: "Toggle sidebar" },
  ];
  const titles = (query: string, recent?: readonly string[]) => rank(items, query, recent).map((ranked) => ranked.item.title);

  it("requires every token, in the title or the keywords", () => {
    expect(titles("switch")).toEqual(["Switch branch…", "Switch model…"]);
    expect(titles("git switch")).toEqual(["Switch branch…"]);
    expect(titles("checkout")).toEqual(["Switch branch…"]);
    expect(titles("zzz")).toEqual([]);
  });

  it("highlights title matches only", () => {
    expect(rank(items, "git br")[0]!.matches).toEqual([7, 8]);
  });

  it("breaks ties by recency, then by the given order", () => {
    expect(titles("switch", ["c"])).toEqual(["Switch model…", "Switch branch…"]);
    expect(titles("")).toEqual(["New chat", "Switch branch…", "Switch model…", "Toggle sidebar"]);
  });
});

describe("highlight", () => {
  it("marks the matched letters of a title that starts with an emoji", () => {
    const title = "🚀 Deploy fix";
    expect(highlight(title, fuzzy(title, "deploy")!.matches)).toEqual([
      { text: "🚀 ", hit: false },
      { text: "Deploy", hit: true },
      { text: " fix", hit: false },
    ]);
  });
});

describe("parseQuery", () => {
  it("reads a leading prefix as a mode", () => {
    const prefixes = [">", "@", "#", "#!"];
    expect(parseQuery(">reload", prefixes)).toEqual({ prefix: ">", text: "reload" });
    expect(parseQuery("@fix", prefixes)).toEqual({ prefix: "@", text: "fix" });
    expect(parseQuery("#!tag", prefixes)).toEqual({ prefix: "#!", text: "tag" });
    expect(parseQuery("reload >", prefixes)).toEqual({ text: "reload >" });
  });
});

describe("remember", () => {
  it("moves a choice to the front without duplicates and keeps a bounded list", () => {
    expect(remember(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(remember(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});
