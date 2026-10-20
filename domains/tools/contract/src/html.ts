/**
 * `@lemma/tools/html`: what draws a page a tool made (`html_render`, in the chat) and what checks one (`html_preview`,
 * in a headless browser) share, so a page looks the same in both: the theme variables a page reads, their values when
 * no app supplies them, and the bootstrap put first in its head, which sets them, reports the page's height to its
 * frame, follows the app's theme as it changes, and hands link clicks to the app. Browser-safe.
 */

/** The largest page a tool takes, in characters, before local images are inlined. */
export const HTML_MAX_CHARS = 512_000;

/**
 * How tall a page may be, in CSS pixels at the chat's width, and still read as part of a reply rather than a document
 * of its own. `html_render`'s description asks for pages within it, and `html_preview` says when one is not.
 */
export const HTML_TALL_PAGE = 1500;

/** The CSS custom properties a page reads, set on its `:root`: the app's own names, and six categorical chart colors. */
export const HTML_THEME_VARIABLES = [
  "--bg",
  "--bg-raised",
  "--bg-sunk",
  "--text",
  "--text-2",
  "--text-3",
  "--border",
  "--border-strong",
  "--accent",
  "--accent-text",
  "--ok",
  "--warn",
  "--err",
  "--radius",
  "--font-ui",
  "--font-mono",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
] as const;
export type HtmlThemeVariable = (typeof HTML_THEME_VARIABLES)[number];

export type HtmlAppearance = "dark" | "light";

/** A theme as a page gets it: a value for each variable. */
export type HtmlTheme = Readonly<Record<HtmlThemeVariable, string>>;

const FONT_UI = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** The app's default themes, as its stylesheet sets them, with chart colors that read on either. */
const THEMES: Readonly<Record<HtmlAppearance, HtmlTheme>> = {
  dark: {
    "--bg": "#0b0b0b",
    "--bg-raised": "#171717",
    "--bg-sunk": "#080808",
    "--text": "#ececec",
    "--text-2": "#a3a3a3",
    "--text-3": "#717171",
    "--border": "rgba(255, 255, 255, 0.08)",
    "--border-strong": "rgba(255, 255, 255, 0.14)",
    "--accent": "#ececec",
    "--accent-text": "#e5e5e5",
    "--ok": "#4cc27f",
    "--warn": "#e0a640",
    "--err": "#f06d6d",
    "--radius": "10px",
    "--font-ui": FONT_UI,
    "--font-mono": FONT_MONO,
    "--chart-1": "oklch(0.7 0.14 255)",
    "--chart-2": "oklch(0.72 0.14 150)",
    "--chart-3": "oklch(0.76 0.14 65)",
    "--chart-4": "oklch(0.68 0.17 300)",
    "--chart-5": "oklch(0.7 0.17 0)",
    "--chart-6": "oklch(0.74 0.11 200)",
  },
  light: {
    "--bg": "#fafafa",
    "--bg-raised": "#ffffff",
    "--bg-sunk": "#f4f4f4",
    "--text": "#171717",
    "--text-2": "#525252",
    "--text-3": "#8a8a8a",
    "--border": "rgba(0, 0, 0, 0.09)",
    "--border-strong": "rgba(0, 0, 0, 0.16)",
    "--accent": "#171717",
    "--accent-text": "#171717",
    "--ok": "#1f8a4c",
    "--warn": "#a86b00",
    "--err": "#c43d3d",
    "--radius": "10px",
    "--font-ui": FONT_UI,
    "--font-mono": FONT_MONO,
    "--chart-1": "oklch(0.55 0.16 255)",
    "--chart-2": "oklch(0.55 0.14 150)",
    "--chart-3": "oklch(0.62 0.15 60)",
    "--chart-4": "oklch(0.52 0.19 300)",
    "--chart-5": "oklch(0.56 0.19 0)",
    "--chart-6": "oklch(0.56 0.11 200)",
  },
};

/** The app's default theme for `appearance`. */
export const htmlTheme = (appearance: HtmlAppearance): HtmlTheme => THEMES[appearance];

/**
 * A theme as CSS: the variables on `:root`, and the color scheme. A value the app leaves empty (it sets no chart colors)
 * keeps the default theme's.
 */
export const htmlThemeCss = (theme: Readonly<Partial<Record<HtmlThemeVariable, string>>>, appearance: HtmlAppearance): string => {
  const fallback = THEMES[appearance];
  const values = HTML_THEME_VARIABLES.map((name) => `${name}: ${(theme[name] ?? "").trim() || fallback[name]};`).join(" ");
  return `:root { color-scheme: ${appearance}; ${values} }`;
};

/** What a page's bootstrap posts to its frame's parent, and what the parent posts back. */
export const HtmlMessages = {
  /** `{ type, height }`: the page's height in CSS pixels, each time it changes. */
  height: "lemma:html-height",
  /** `{ type, href }`: the person clicked a link, which the app opens rather than the frame. */
  open: "lemma:html-open",
  /**
   * `{ type, top }`: the person followed a link to a place in the page (`#id`, `#top`), which the page has scrolled to
   * as far as it scrolls itself; `top` is where that place now is from the frame's top, less its `scroll-margin-top`,
   * for the app to bring into view.
   */
  reveal: "lemma:html-reveal",
  /** `{ type }`: Escape was pressed in the page, which had no use for it: a page over the app closes. */
  escape: "lemma:html-escape",
  /** `{ type, css }`, to the page: the app's theme changed (`htmlThemeCss`). */
  theme: "lemma:html-theme",
} as const;

/**
 * A script expression that measures how tall a page's content is: the root's height, or the bottom of the furthest of
 * the body's children with its margin, whichever is more. A page that sets `html, body { height: 100% }` is as tall as
 * its frame however much it holds, so its children say how much it holds. The bootstrap reports it, and
 * `html_preview` gives it as the page's `contentHeight`, so the two agree.
 */
export const HTML_MEASURE_SOURCE = `(() => {
  let bottom = document.documentElement.getBoundingClientRect().height;
  for (const child of document.body ? document.body.children : []) {
    const box = child.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    bottom = Math.max(bottom, box.bottom + (parseFloat(getComputedStyle(child).marginBottom) || 0) + scrollY);
  }
  return Math.ceil(bottom);
})()`;

/**
 * Put first in a page's head: the theme, a base stylesheet (no margin, no background of its own, the app's text color
 * and font), and a script that reports the page's height (`HTML_MEASURE_SOURCE`), follows theme changes, and hands link
 * clicks on: a link elsewhere for the app to open, and a link to a place in the page, which the page follows itself
 * and the app then brings into view (a frame as tall as its page does not scroll); and Escape, for a page over the app
 * to close. A link or Escape the page's own script took (preventDefault), and Escape in a field or with the page's own
 * dialog or popover open, stay the page's. A page's own CSS overrides the base. Scrollbars show: a page held to a height, or wider
 * than its frame, scrolls, and says so.
 */
export const htmlBootstrap = (themeCss: string): string =>
  `<style id="lemma-theme">${themeCss}</style>` +
  `<style>html { background: transparent; color: var(--text); font: 14px/1.5 var(--font-ui); } body { margin: 0; }</style>` +
  `<script>(() => {
  const post = (message) => parent.postMessage(message, "*");
  const height = () => post({ type: ${JSON.stringify(HtmlMessages.height)}, height: ${HTML_MEASURE_SOURCE} });
  const watch = new ResizeObserver(height);
  watch.observe(document.documentElement);
  // A body held to its frame's height grows no taller as its content does: its children's sizes say so.
  addEventListener("DOMContentLoaded", () => { if (document.body) { watch.observe(document.body); for (const child of document.body.children) watch.observe(child); } });
  addEventListener("load", height);
  addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === ${JSON.stringify(HtmlMessages.theme)} && typeof data.css === "string") document.getElementById("lemma-theme").textContent = data.css;
  });
  addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    // A link the page's own script took is the page's.
    if (link === null || event.defaultPrevented) return;
    const href = link.getAttribute("href");
    if (href.startsWith("#")) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch {}
      const named = id === "" ? null : (document.getElementById(id) ?? document.getElementsByName(id)[0] ?? null);
      const target = named ?? (id === "" || id.toLowerCase() === "top" ? document.documentElement : null);
      if (target === null) return;
      // A srcdoc page's links resolve against the app's address, so followed as they are they would load the app in
      // the frame: the page goes to the place on its own address instead, which it follows as a link (its address,
      // :target, hashchange, and every box it scrolls to show the place). Once it has scrolled, or a moment later
      // when nothing scrolls, the app brings the place into view.
      event.preventDefault();
      let moved = false;
      let done = false;
      const scrolled = () => { moved = true; };
      const reveal = () => {
        if (done) return;
        done = true;
        removeEventListener("scroll", scrolled, true);
        removeEventListener("scrollend", reveal, true);
        const margin = target === document.documentElement ? 0 : parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        post({ type: ${JSON.stringify(HtmlMessages.reveal)}, top: target.getBoundingClientRect().top - margin });
      };
      addEventListener("scroll", scrolled, true);
      addEventListener("scrollend", reveal, true);
      // The address it has already: going there again would not scroll.
      if (location.hash === href || (href === "#" && location.hash === "")) target.scrollIntoView();
      else location.hash = href;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!moved) reveal(); }));
      setTimeout(reveal, 1500);
      return;
    }
    event.preventDefault();
    post({ type: ${JSON.stringify(HtmlMessages.open)}, href: link.href });
  });
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
    // Escape the page has a use for: leaving a field, or closing its own dialog or popover.
    const target = event.target instanceof Element ? event.target : null;
    if (target !== null && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null) return;
    if (document.querySelector("dialog[open]") !== null) return;
    try { if (document.querySelector(":popover-open") !== null) return; } catch {}
    // Once every listener has had it, the page's own too: one that took it (preventDefault) keeps it.
    setTimeout(() => { if (!event.defaultPrevented) post({ type: ${JSON.stringify(HtmlMessages.escape)} }); }, 0);
  });
})();</script>`;

/**
 * `html` with `bootstrap` first in its head (after `<head>`, else after `<html>`, else before everything), and a
 * doctype when it has none: in quirks mode a page fills its frame's height, so the height it reports would follow the
 * frame's and never settle.
 */
export const withHtmlBootstrap = (html: string, bootstrap: string): string => {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const prolog = doctype === null ? "<!doctype html>" : doctype[0];
  const rest = doctype === null ? html : html.slice(doctype[0].length);
  const head = /<head(\s[^>]*)?>/i.exec(rest);
  if (head !== null) return prolog + rest.slice(0, head.index + head[0].length) + bootstrap + rest.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(rest);
  if (root !== null) return prolog + rest.slice(0, root.index + root[0].length) + `<head>${bootstrap}</head>` + rest.slice(root.index + root[0].length);
  return prolog + bootstrap + rest;
};
