import { describe, expect, it } from "vitest";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import { CODE_COLORS, THEMES, highlightTokens, loadLanguage } from "../src/lib/highlight.ts";

const code = ["const s = `multi", "line ${x}", "template`;", "/* comment", "still */ let y = 2;", "", "function f() {", "  return 'x';", "}", ""].join("\n");

const flat = (lines: ReturnType<typeof highlightTokens>) => lines?.map((line) => line.map((token) => [token.content, token.htmlStyle]));

describe("highlighting", () => {
  it("tokenizes streaming code like the whole code, at every step", async () => {
    expect(await loadLanguage("ts")).toBe(true);
    const reference = await createHighlighterCore({
      engine: createOnigurumaEngine(import("shiki/wasm")),
      themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
      langs: [bundledLanguages.ts],
    });
    for (const size of [1, 3, 11]) {
      for (let end = size; end < code.length + size; end += size) {
        const prefix = code.slice(0, Math.min(end, code.length));
        const streamed = flat(highlightTokens(prefix, "ts", false));
        const whole = flat(reference.codeToTokens(prefix, { lang: "ts", themes: THEMES, defaultColor: false, colorReplacements: CODE_COLORS }).tokens);
        expect(streamed, JSON.stringify(prefix)).toEqual(whole);
      }
    }
  });

  it("colors code with GitHub's colors, each a `--code-*` token a theme sets", async () => {
    expect(await loadLanguage("ts")).toBe(true);
    const keyword = highlightTokens("const x = 'a';", "ts", true)![0]![0]!;
    expect([keyword.content, keyword.htmlStyle]).toEqual([
      "const",
      { "--shiki-light": "var(--code-keyword, #d73a49)", "--shiki-dark": "var(--code-keyword, #f97583)" },
    ]);
  });

  it("makes every color of both themes a token", async () => {
    for (const name of [THEMES.light, THEMES.dark]) {
      const theme = (await bundledThemes[name]()).default;
      const colors = new Set(
        [theme.colors?.["editor.foreground"], ...(theme.tokenColors ?? []).map((rule) => rule.settings?.foreground)]
          .filter((color): color is string => typeof color === "string")
          .map((color) => color.toLowerCase()),
      );
      for (const color of colors) expect(CODE_COLORS[name]?.[color], `${name} ${color}`).toMatch(/^var\(--code-/);
    }
  });

  it("leaves unknown languages plain", async () => {
    expect(await loadLanguage("not-a-language")).toBe(false);
    expect(highlightTokens("x", "not-a-language", true)).toBeUndefined();
  });
});
