import { defineSlot } from "@lemma/ui";
import type { CodeBlock } from "./markdown.ts";

/**
 * Renders fenced code blocks in markdown: highlighting, diagrams. The first
 * item by `order` whose `match` holds renders a block; without one, or until
 * it fills `target`, the block shows as plain code, which stays one click
 * away for a `preview`.
 */
export interface CodeBlockRenderer {
  /** Takes blocks in this fence language (lowercased; "" for none). */
  readonly match: (lang: string) => boolean;
  /**
   * Fills `target` (an empty element) for the block, now or when the promise
   * resolves; leaving it empty keeps the plain code. Called again whenever the
   * block's code grows, so a renderer that needs the whole block waits for
   * `complete`. A throw or rejection keeps the plain code and says why.
   */
  readonly render: (block: CodeBlock, target: HTMLElement) => void | Promise<void>;
  /** What it renders is not the code (a diagram): the block offers the source beside it. */
  readonly preview?: boolean;
}

export const CodeBlocks = defineSlot<CodeBlockRenderer>("markdown.code");

/*
 * How the app looks is tokens: every color, font, radius, and width is a `--`
 * custom property, and every plugin draws with them, in its stylesheet
 * (`var(--accent)`) or its markup (`tw:bg-accent`, the utility named for the
 * token), so changing a token changes every plugin at once, and each token's
 * default is Lemma's own look. Colors start from three base colors (`--bg`,
 * `--text`, `--accent`), which `styles.css` derives the rest from; a
 * plugin's own colors are tokens too (`highlight`'s `--code-*`, `diagrams`'
 * `--diagram-*`), and `--text-scale` and `--radius-scale` size every font
 * and corner.
 *
 * The look is the `look.appearance` plugin's config (its row in
 * config.jsonc): a scheme, a theme for each scheme, an accent, fonts, text
 * size, corners, and the conversation width. It paints the look that config chooses on `<html>`
 * through `@lemma/ui/paint` (`api.look` for a web half); `look.appearance-page` edits
 * the config, and anything else changes the look the same way, by writing it
 * (`UiPlugins.setConfig`, `lemma plugins config look.appearance …`). What there is to
 * choose from is these slots: `appearance` adds Lemma's own, and a plugin adds
 * a theme, an accent, or a font as an item, so a theme pack is a plugin and
 * its choices leave with it. Rows a plugin adds to the
 * `SectionIds.appearance` settings section sit beside the look's own.
 */

/** A theme's base colors, as the tokens they set (`bg` is `--bg`). */
export interface ThemeColors {
  /** The page's background: surfaces step from it. */
  readonly bg?: string;
  /** The text: muted text is it toward `bg`, and dark surfaces rise toward it. */
  readonly text?: string;
  /** Buttons, links, and selection; its tint and the text on it derive from it. Left out, it follows `text`. */
  readonly accent?: string;
}

/** A theme for one scheme. Its item's `id` is what config names (`darkTheme`). */
export interface Theme {
  readonly title: string;
  readonly scheme: "light" | "dark";
  /** Its base colors; one left out keeps the scheme's own. The colors `styles.css` derives follow them. */
  readonly colors: ThemeColors;
  /**
   * Any other token: a derived color of its own (`--bg-raised`), a status
   * color (`--err`), or a plugin's (`--code-keyword`, `--diagram-node`).
   */
  readonly tokens?: Readonly<Record<string, string>>;
}

export const Themes = defineSlot<Theme>("look.themes");

/** An accent color to offer: one CSS color, or one per scheme. Its item's `id` is what config names (`accent`). */
export interface Accent {
  readonly title: string;
  readonly color: string | { readonly light: string; readonly dark: string };
}

export const Accents = defineSlot<Accent>("look.accents");

/**
 * A font to offer for the interface (`ui`) or for code (`mono`). Its item's
 * `id` is what config names (`font`). A plugin that ships a font file
 * declares it with `@font-face` in its `styles`: the browser fetches the file
 * only once the font is chosen.
 */
export interface Font {
  readonly title: string;
  readonly kind: "ui" | "mono";
  /** A CSS font-family list, ending in a generic family for when the font is not installed. */
  readonly family: string;
}

export const Fonts = defineSlot<Font>("look.fonts");
