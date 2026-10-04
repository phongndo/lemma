import { describe, expect, it } from "vitest";
import { createBlockLexer, markdownBlocks, markdownText } from "../src/lib/markdown.ts";
import type { MarkdownBlock } from "../src/lib/markdown.ts";

const shape = (blocks: readonly MarkdownBlock[]) =>
  blocks.map((block) =>
    block.kind === "code" ? { key: block.key, lang: block.lang, code: block.code, complete: block.complete } : { key: block.key, code: block.code },
  );

const samples = [
  "Intro paragraph\nthat continues.\n\n## Heading\n\nText after.\n",
  "Setext title\n===\n\nand a paragraph\n---\n\nend",
  "- one\n- two\n\n- three, loose\n  continued\n\n1. first\n2. second\n\nafter the list",
  "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nbelow the table",
  "Before\n\n```ts title=x\nconst a = 1;\n\nconst b = 2;\n```\n\n~~~mermaid\ngraph TD\n  A --> B\n~~~\nafter fence\n\n    indented code\n\nend",
  "> quote\ncontinued lazily\n\n> another\n\n<div>html block</div>\n\n**bold** and `code`",
  "````md\n```inner```\n````\n\nText\n```\nunclosed to the end\n\nstill code",
  "1. Install:\n\n   ```bash\n   npm i\n   ```\n\n2. Run it\n\n> ```js\n> quoted()\n> ```\n",
];

/** Every way of streaming `source` in chunks of `size`, lexed incrementally, ends where lexing it whole does, at each step. */
const streamed = (source: string, size: number) => {
  const lex = createBlockLexer();
  for (let end = size; end < source.length + size; end += size) {
    const prefix = source.slice(0, Math.min(end, source.length));
    expect(shape(lex(prefix)), JSON.stringify(prefix)).toEqual(shape(markdownBlocks(prefix)));
  }
};

describe("markdown blocks", () => {
  it("lexes a growing source like the whole source, at every step", () => {
    for (const sample of samples) for (const size of [1, 2, 3, 7, 16]) streamed(sample, size);
  });

  it("keeps a code block's language and whether its fence closed", () => {
    const [open] = markdownBlocks("```TypeScript extra\nlet x");
    expect(open).toMatchObject({ kind: "code", lang: "typescript", code: "let x", complete: false });
    const [closed] = markdownBlocks("```ts\nlet x\n```\n");
    expect(closed).toMatchObject({ kind: "code", lang: "ts", code: "let x", complete: true });
    const [longer] = markdownBlocks("````\na\n```\n");
    expect(longer).toMatchObject({ complete: false });
  });

  it("keeps fenced code nested in a list item or a quote with the block it is in", () => {
    const [list, quote] = markdownBlocks("1. Install:\n\n   ```Bash\n   npm i\n   ```\n2. Run\n   ```js\n   go(\n\n> ```js\n> quoted()\n> ```\n").filter(
      (block) => block.kind === "html" && block.code.length > 0,
    );
    expect(list).toMatchObject({
      kind: "html",
      code: [
        { lang: "bash", code: "npm i", complete: true },
        { lang: "js", code: "go(", complete: false },
      ],
    });
    expect(quote).toMatchObject({ kind: "html", code: [{ lang: "js", code: "quoted()", complete: true }] });
  });

  it("lexes whole when the source is replaced or defines reference links", () => {
    const lex = createBlockLexer();
    lex("first message");
    expect(shape(lex("something else"))).toEqual(shape(markdownBlocks("something else")));
    const withLink = "see [x][1]\n\n[1]: https://example.com\n";
    lex(withLink.slice(0, 12));
    expect(shape(lex(withLink))).toEqual(shape(markdownBlocks(withLink)));
  });
});

describe("markdown text", () => {
  it("keeps what a reader sees, on one line", () => {
    expect(markdownText("## Fixed\n\nThe **cause** was _not_ `__init__.py`, see [the log](https://e.org/Foo_(bar)).")).toBe(
      "Fixed The cause was not __init__.py, see the log.",
    );
    expect(markdownText("Globs `src/**/*.ts` and `*args`; my__var__name and snake_case_name stay.")).toBe(
      "Globs src/**/*.ts and *args; my__var__name and snake_case_name stay.",
    );
    expect(markdownText("2024. Was a big year\n\n- one\n- two\n\n```ts\nx * y\n```\n\n<b>bold</b> > quote")).toBe(
      "2024. Was a big year one two x * y bold > quote",
    );
    expect(markdownText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b 1 2");
  });
});
