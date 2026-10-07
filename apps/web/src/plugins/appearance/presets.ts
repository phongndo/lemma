import { LEMMA_THEMES } from "../../model/appearance.ts";
import type { Accent, Font, Theme } from "../../ui/contracts.ts";

/** Lemma's own themes: each scheme's base colors as `styles.css` sets them. A plugin adds others to `Themes` beside them. */
export const THEMES: readonly (Theme & { readonly id: string })[] = [
  { id: LEMMA_THEMES.light, title: "Lemma", scheme: "light", colors: {} },
  { id: LEMMA_THEMES.dark, title: "Lemma", scheme: "dark", colors: {} },
];

/** Accents of middle lightness, which read in either scheme; the text on each is black or white, whichever reads. */
export const ACCENTS: readonly (Accent & { readonly id: string })[] = [
  { id: "blue", title: "Blue", color: "oklch(0.62 0.17 255)" },
  { id: "violet", title: "Violet", color: "oklch(0.6 0.19 290)" },
  { id: "pink", title: "Pink", color: "oklch(0.63 0.2 350)" },
  { id: "red", title: "Red", color: "oklch(0.62 0.2 25)" },
  { id: "orange", title: "Orange", color: "oklch(0.66 0.16 55)" },
  { id: "green", title: "Green", color: "oklch(0.6 0.14 150)" },
];

const SANS = "ui-sans-serif, system-ui, sans-serif";
const MONO = "ui-monospace, monospace";
/** Common fonts to offer by name; one not installed falls back to the system's. */
export const FONTS: readonly (Font & { readonly id: string })[] = [
  { id: "inter", title: "Inter", kind: "ui", family: `Inter, ${SANS}` },
  { id: "geist", title: "Geist", kind: "ui", family: `Geist, ${SANS}` },
  { id: "ibm-plex-sans", title: "IBM Plex Sans", kind: "ui", family: `"IBM Plex Sans", ${SANS}` },
  { id: "jetbrains-mono", title: "JetBrains Mono", kind: "mono", family: `"JetBrains Mono", ${MONO}` },
  { id: "geist-mono", title: "Geist Mono", kind: "mono", family: `"Geist Mono", ${MONO}` },
  { id: "berkeley-mono", title: "Berkeley Mono", kind: "mono", family: `"Berkeley Mono", ${MONO}` },
];
