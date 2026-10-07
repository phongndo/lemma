import { createHighlighterCore } from "shiki/core";
import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

/*
 * Syntax highlighting with Shiki, imported on first use (the `highlight`
 * plugin loads this module lazily); each language's grammar loads the first
 * time it is seen. The Oniguruma engine matches the grammars exactly and
 * cannot hang on a backtracking regex the way a translated one can.
 *
 * Its colors are GitHub's light and dark themes, each color a token that
 * falls back to GitHub's: a keyword is `var(--code-keyword, #d73a49)` in the
 * light scheme and `var(--code-keyword, #f97583)` in the dark one, so a
 * theme restyles code by setting `--code-keyword` and the rest.
 */

export const THEMES = { light: "github-light", dark: "github-dark" } as const;

/** Each theme's colors by the token that stands for them, in the light theme, then the dark. */
const CODE_TOKENS: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  text: ["#24292e", "#e1e4e8"],
  comment: ["#6a737d", "#6a737d"],
  keyword: ["#d73a49", "#f97583"],
  string: ["#032f62", "#9ecbff"],
  regexp: ["#032f62", "#dbedff"],
  constant: ["#005cc5", "#79b8ff"],
  entity: ["#6f42c1", "#b392f0"],
  variable: ["#e36209", "#ffab70"],
  tag: ["#22863a", "#85e89d"],
  invalid: ["#b31d28", "#fdaeb7"],
  bracket: ["#586069", "#d1d5da"],
  ignored: ["#f6f8fa", "#2f363d"],
  "carriage-return": ["#fafbfc", "#24292e"],
};

/** Shiki's `colorReplacements`: each theme's colors, as the tokens that stand for them with the color as fallback. */
export const CODE_COLORS: Record<string, Record<string, string>> = { [THEMES.light]: {}, [THEMES.dark]: {} };
for (const [name, [light, dark]] of Object.entries(CODE_TOKENS)) {
  // One color may stand for two tokens: the light theme colors regexps as strings, so `--code-string` sets both there.
  CODE_COLORS[THEMES.light]![light] ??= `var(--code-${name}, ${light})`;
  CODE_COLORS[THEMES.dark]![dark] ??= `var(--code-${name}, ${dark})`;
}
/** Longer code stays plain: tokenizing it would stall the page. */
const MAX_CHARS = 200_000;

let highlighter: Promise<HighlighterCore> | undefined;
let ready: HighlighterCore | undefined;
const languages = new Map<string, Promise<boolean>>();

const load = (): Promise<HighlighterCore> =>
  (highlighter ??= createHighlighterCore({
    engine: createOnigurumaEngine(import("shiki/wasm")),
    themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
    langs: [],
  }).then((loaded) => (ready = loaded)));

/** Loads `lang`'s grammar; false for a language Shiki does not know. */
export const loadLanguage = (lang: string): Promise<boolean> => {
  let loading = languages.get(lang);
  if (loading === undefined) {
    const grammar = (bundledLanguages as Record<string, (typeof bundledLanguages)[keyof typeof bundledLanguages] | undefined>)[lang];
    loading = grammar === undefined ? Promise.resolve(false) : load().then((loaded) => loaded.loadLanguage(grammar).then(() => true));
    languages.set(lang, loading);
  }
  return loading;
};

/** `lang` can be highlighted now, synchronously. */
const canHighlight = (lang: string): boolean => ready !== undefined && ready.getLoadedLanguages().includes(lang);

const tokenize = (hl: HighlighterCore, code: string, lang: string, grammarState?: GrammarState): ThemedToken[][] =>
  hl.codeToTokens(code, { lang, themes: THEMES, defaultColor: false, colorReplacements: CODE_COLORS, ...(grammarState === undefined ? {} : { grammarState }) })
    .tokens;

/**
 * The last streaming block per language: its lines up to the last newline,
 * their tokens, and the grammar state after them. A block that grows from it
 * tokenizes only its new lines, so streaming code costs its tail per update.
 */
const streams = new Map<string, { readonly text: string; readonly tokens: ThemedToken[][]; readonly state: GrammarState | undefined }>();
/** Finished blocks, so a draft settling into its message does not tokenize again. */
const finished = new Map<string, ThemedToken[][]>();
const FINISHED_MAX = 200;

const tokensFor = (hl: HighlighterCore, code: string, lang: string, complete: boolean): ThemedToken[][] => {
  const key = `${lang}\u0000${code}`;
  const hit = finished.get(key);
  if (hit !== undefined) return hit;
  const lineEnd = code.lastIndexOf("\n") + 1;
  const lines = code.slice(0, lineEnd);
  let cached = streams.get(lang);
  if (cached === undefined || !lines.startsWith(cached.text)) cached = { text: "", tokens: [], state: undefined };
  if (lines.length > cached.text.length) {
    const added = tokenize(hl, lines.slice(cached.text.length, -1), lang, cached.state);
    // The state is looked up by the array Shiki returned, not a copy.
    cached = { text: lines, tokens: [...cached.tokens, ...added], state: hl.getLastGrammarState(added) };
  }
  streams.set(lang, cached);
  const rest = code.slice(lineEnd);
  const tokens = rest === "" && lineEnd > 0 ? [...cached.tokens, []] : [...cached.tokens, ...tokenize(hl, rest, lang, cached.state)];
  if (complete) {
    finished.set(key, tokens);
    if (finished.size > FINISHED_MAX) finished.delete(finished.keys().next().value!);
  }
  return tokens;
};

/** `code`'s tokens as `lang`, per line; undefined until `loadLanguage(lang)` has resolved true. */
export const highlightTokens = (code: string, lang: string, complete: boolean): ThemedToken[][] | undefined =>
  canHighlight(lang) && code.length <= MAX_CHARS ? tokensFor(ready!, code, lang, complete) : undefined;

/**
 * `code` highlighted as `lang`, as a `pre` whose spans carry both themes'
 * colors (`--shiki-light`, `--shiki-dark`; the stylesheet picks one), each a
 * `--code-*` token. Undefined until `loadLanguage(lang)` has resolved true.
 */
export const highlight = (code: string, lang: string, complete: boolean): HTMLElement | undefined => {
  const lines = highlightTokens(code, lang, complete);
  if (lines === undefined) return undefined;
  const pre = document.createElement("pre");
  pre.className = "shiki";
  const element = document.createElement("code");
  lines.forEach((line, index) => {
    if (index > 0) element.append("\n");
    for (const token of line) {
      const span = document.createElement("span");
      span.textContent = token.content;
      for (const [property, value] of Object.entries(token.htmlStyle ?? {})) span.style.setProperty(property, value);
      element.append(span);
    }
  });
  pre.append(element);
  return pre;
};
