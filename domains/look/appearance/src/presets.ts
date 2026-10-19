import { LEMMA_THEMES } from "@lemma/look";
import type { Accent, Font, Theme } from "@lemma/look";

/** A theme's code colors (`highlight`'s `--code-*` tokens): an absent one keeps GitHub's. */
const code = (colors: {
  readonly comment: string;
  readonly keyword: string;
  readonly string: string;
  readonly constant: string;
  readonly entity: string;
  readonly variable: string;
  readonly tag: string;
}): Record<string, string> => Object.fromEntries(Object.entries(colors).map(([name, color]) => [`--code-${name}`, color]));

/**
 * Lemma's own themes, each scheme's base colors as `styles.css` sets them, then well-known palettes beside them: their
 * background, text, and accent, from which `styles.css` derives the rest, and their code colors. A plugin adds others
 * to `Themes` beside them.
 */
export const THEMES: readonly (Theme & { readonly id: string })[] = [
  { id: LEMMA_THEMES.light, title: "Lemma", scheme: "light", colors: {} },
  { id: "paper", title: "Paper", scheme: "light", colors: { bg: "#f6f3ec", text: "#2f2a24", accent: "oklch(0.56 0.13 45)" } },
  { id: "github-light", title: "GitHub", scheme: "light", colors: { bg: "#ffffff", text: "#1f2328", accent: "#0969da" } },
  {
    id: "solarized-light",
    title: "Solarized",
    scheme: "light",
    colors: { bg: "#fdf6e3", text: "#4f5f66", accent: "#268bd2" },
    tokens: code({ comment: "#93a1a1", keyword: "#859900", string: "#2aa198", constant: "#d33682", entity: "#268bd2", variable: "#b58900", tag: "#cb4b16" }),
  },
  {
    id: "catppuccin-latte",
    title: "Catppuccin",
    scheme: "light",
    colors: { bg: "#eff1f5", text: "#4c4f69", accent: "#8839ef" },
    tokens: code({ comment: "#8c8fa1", keyword: "#8839ef", string: "#40a02b", constant: "#fe640b", entity: "#1e66f5", variable: "#4c4f69", tag: "#d20f39" }),
  },
  {
    id: "rose-pine-dawn",
    title: "Rosé Pine",
    scheme: "light",
    colors: { bg: "#faf4ed", text: "#575279", accent: "#907aa9" },
    tokens: code({ comment: "#9893a5", keyword: "#286983", string: "#ea9d34", constant: "#d7827e", entity: "#56949f", variable: "#575279", tag: "#b4637a" }),
  },
  { id: LEMMA_THEMES.dark, title: "Lemma", scheme: "dark", colors: {} },
  { id: "github-dark", title: "GitHub", scheme: "dark", colors: { bg: "#0d1117", text: "#e6edf3", accent: "#4493f8" } },
  {
    id: "nord",
    title: "Nord",
    scheme: "dark",
    colors: { bg: "#2e3440", text: "#e5e9f0", accent: "#88c0d0" },
    tokens: code({ comment: "#7b88a1", keyword: "#81a1c1", string: "#a3be8c", constant: "#b48ead", entity: "#88c0d0", variable: "#d8dee9", tag: "#81a1c1" }),
  },
  {
    id: "tokyo-night",
    title: "Tokyo Night",
    scheme: "dark",
    colors: { bg: "#1a1b26", text: "#c0caf5", accent: "#7aa2f7" },
    tokens: code({ comment: "#636da6", keyword: "#bb9af7", string: "#9ece6a", constant: "#ff9e64", entity: "#7aa2f7", variable: "#c0caf5", tag: "#f7768e" }),
  },
  {
    id: "catppuccin-mocha",
    title: "Catppuccin",
    scheme: "dark",
    colors: { bg: "#1e1e2e", text: "#cdd6f4", accent: "#cba6f7" },
    tokens: code({ comment: "#7f849c", keyword: "#cba6f7", string: "#a6e3a1", constant: "#fab387", entity: "#89b4fa", variable: "#cdd6f4", tag: "#f38ba8" }),
  },
  {
    id: "gruvbox-dark",
    title: "Gruvbox",
    scheme: "dark",
    colors: { bg: "#282828", text: "#ebdbb2", accent: "#fabd2f" },
    tokens: code({ comment: "#928374", keyword: "#fb4934", string: "#b8bb26", constant: "#d3869b", entity: "#fabd2f", variable: "#83a598", tag: "#8ec07c" }),
  },
  {
    id: "rose-pine",
    title: "Rosé Pine",
    scheme: "dark",
    colors: { bg: "#191724", text: "#e0def4", accent: "#c4a7e7" },
    tokens: code({ comment: "#6e6a86", keyword: "#3e8fb0", string: "#f6c177", constant: "#ebbcba", entity: "#9ccfd8", variable: "#e0def4", tag: "#eb6f92" }),
  },
  {
    id: "solarized-dark",
    title: "Solarized",
    scheme: "dark",
    colors: { bg: "#002b36", text: "#93a1a1", accent: "#268bd2" },
    tokens: code({ comment: "#657b83", keyword: "#859900", string: "#2aa198", constant: "#d33682", entity: "#268bd2", variable: "#b58900", tag: "#cb4b16" }),
  },
];

/** Accents of middle lightness, which read in either scheme; the text on each is black or white, whichever reads. */
export const ACCENTS: readonly (Accent & { readonly id: string })[] = [
  { id: "blue", title: "Blue", color: "oklch(0.62 0.17 255)" },
  { id: "violet", title: "Violet", color: "oklch(0.6 0.19 290)" },
  { id: "pink", title: "Pink", color: "oklch(0.63 0.2 350)" },
  { id: "red", title: "Red", color: "oklch(0.62 0.2 25)" },
  { id: "orange", title: "Orange", color: "oklch(0.66 0.16 55)" },
  { id: "green", title: "Green", color: "oklch(0.6 0.14 150)" },
  { id: "teal", title: "Teal", color: "oklch(0.62 0.11 195)" },
];

const SANS = "ui-sans-serif, system-ui, sans-serif";
const MONO = "ui-monospace, monospace";
/** Common fonts to offer by name; one not installed falls back to the system's. */
export const FONTS: readonly (Font & { readonly id: string })[] = [
  { id: "inter", title: "Inter", kind: "ui", family: `Inter, ${SANS}` },
  { id: "geist", title: "Geist", kind: "ui", family: `Geist, ${SANS}` },
  { id: "ibm-plex-sans", title: "IBM Plex Sans", kind: "ui", family: `"IBM Plex Sans", ${SANS}` },
  { id: "source-sans", title: "Source Sans 3", kind: "ui", family: `"Source Sans 3", ${SANS}` },
  { id: "atkinson-hyperlegible", title: "Atkinson Hyperlegible", kind: "ui", family: `"Atkinson Hyperlegible", ${SANS}` },
  { id: "jetbrains-mono", title: "JetBrains Mono", kind: "mono", family: `"JetBrains Mono", ${MONO}` },
  { id: "geist-mono", title: "Geist Mono", kind: "mono", family: `"Geist Mono", ${MONO}` },
  { id: "berkeley-mono", title: "Berkeley Mono", kind: "mono", family: `"Berkeley Mono", ${MONO}` },
  { id: "fira-code", title: "Fira Code", kind: "mono", family: `"Fira Code", ${MONO}` },
  { id: "ibm-plex-mono", title: "IBM Plex Mono", kind: "mono", family: `"IBM Plex Mono", ${MONO}` },
  { id: "iosevka", title: "Iosevka", kind: "mono", family: `Iosevka, ${MONO}` },
  { id: "cascadia-code", title: "Cascadia Code", kind: "mono", family: `"Cascadia Code", ${MONO}` },
];
