import { describe, expect, it } from "vitest";
import { parseFrontmatter, unquote } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  it("reads flat frontmatter: plain, quoted, continued, and block values", () => {
    const { fields, body } = parseFrontmatter(
      [
        "---",
        "name: review",
        'description: "Review a diff: find bugs"',
        "summary: one",
        "  two",
        "folded: >-",
        "  a",
        "  b",
        "literal: |",
        "  x",
        "  y",
        "---",
        "",
        "The body.",
      ].join("\n"),
    );
    expect(fields).toEqual({ name: "review", description: "Review a diff: find bugs", summary: "one two", folded: "a b", literal: "x\ny" });
    expect(body).toBe("The body.");
  });

  it("takes a file with no frontmatter as all body", () => {
    expect(parseFrontmatter("Just text.\n")).toEqual({ fields: {}, body: "Just text." });
  });

  it("reads past a byte order mark and Windows line ends", () => {
    expect(parseFrontmatter("﻿---\r\nname: a\r\n---\r\nBody")).toEqual({ fields: { name: "a" }, body: "Body" });
  });
});

describe("unquote", () => {
  it("takes the quotes off one quoted scalar, and leaves anything else as it is", () => {
    expect(unquote('"say \\"hi\\""')).toBe('say "hi"');
    expect(unquote("'it''s'")).toBe("it's");
    expect(unquote("plain")).toBe("plain");
    expect(unquote('"*", "!project-context"')).toBe('"*", "!project-context"');
  });
});
