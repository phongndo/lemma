import { Option, Schema } from "effect";

/** The plugin whose config is the look; `appearance-page` edits its row. */
export const APPEARANCE_PLUGIN = "appearance";

/** The look, as `ui.appearance` in config.jsonc holds it. An absent field follows the default. */
export const AppearanceConfig = Schema.Struct({
  scheme: Schema.optional(Schema.Literals(["system", "light", "dark"])).annotate({
    title: "Scheme",
    description: "system (the default) follows the browser or OS setting.",
  }),
  lightTheme: Schema.optional(Schema.String).annotate({
    title: "Light theme",
    description: "The id of a theme a plugin offers for the light scheme. Unset, Lemma's own.",
  }),
  darkTheme: Schema.optional(Schema.String).annotate({
    title: "Dark theme",
    description: "The id of a theme a plugin offers for the dark scheme. Unset, Lemma's own.",
  }),
  accent: Schema.optional(Schema.String).annotate({
    title: "Accent",
    description: "An accent a plugin offers (`blue`, `violet`, `pink`, `red`, `orange`, `green`), or any CSS color (`#7aa2f7`). Unset, the theme's own.",
  }),
  font: Schema.optional(Schema.String).annotate({
    title: "Font",
    description: "A font a plugin offers (`inter`, `geist`, `ibm-plex-sans`), or a CSS font-family list. Unset, the system's.",
  }),
  monoFont: Schema.optional(Schema.String).annotate({
    title: "Monospace font",
    description: "A font a plugin offers (`jetbrains-mono`, `geist-mono`, `berkeley-mono`), or a CSS font-family list, for code and tool output.",
  }),
  textSize: Schema.optional(Schema.Literals(["small", "default", "large", "larger"])).annotate({
    title: "Text size",
    description: "Every font, in every plugin, scaled together (`--text-scale`).",
  }),
  corners: Schema.optional(Schema.Literals(["square", "default", "round"])).annotate({
    title: "Corners",
    description: "Every rounded corner, in every plugin, scaled together (`--radius-scale`).",
  }),
  contentWidth: Schema.optional(Schema.Literals(["default", "wide", "full"])).annotate({
    title: "Conversation width",
    description: "How wide the transcript and composer run on large screens.",
  }),
});
export type AppearanceSettings = typeof AppearanceConfig.Type;
export type Field = keyof AppearanceSettings;

/** The settings a plugin row holds, as far as they decode; none for a row that does not. */
export const decodeSettings = (values: unknown): AppearanceSettings => Option.getOrElse(Schema.decodeUnknownOption(AppearanceConfig)(values ?? {}), () => ({}));

/** Where an older app kept the scheme and width, in the browser (`localStorage`), before they were config. */
export const LEGACY_KEYS = { scheme: "lemma.theme", contentWidth: "lemma.contentWidth" } as const;

/**
 * What to carry into config from what an older app kept in the browser: each
 * value still valid, not the default, and not set in config already (config wins).
 */
export const legacySettings = (
  stored: { readonly scheme?: string | undefined; readonly contentWidth?: string | undefined },
  config: AppearanceSettings = {},
): AppearanceSettings => {
  const scheme = decodeSettings({ scheme: stored.scheme }).scheme;
  const contentWidth = decodeSettings({ contentWidth: stored.contentWidth }).contentWidth;
  return {
    ...(config.scheme !== undefined || settingValue("scheme", scheme) === undefined ? {} : { scheme }),
    ...(config.contentWidth !== undefined || settingValue("contentWidth", contentWidth) === undefined ? {} : { contentWidth }),
  };
};

/** The value each choice of a few has when unset. */
const DEFAULTS: Partial<Record<Field, string>> = { scheme: "system", textSize: "default", corners: "default", contentWidth: "default" };

/** What setting `field` to `value` writes: undefined, which unsets it, for a blank value or the default. */
export const settingValue = (field: Field, value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return !trimmed || trimmed === DEFAULTS[field] ? undefined : trimmed;
};

export type Scheme = "light" | "dark";
export type SchemeChoice = "system" | Scheme;
/** How wide the conversation runs. */
export type ContentWidth = "default" | "wide" | "full";
export type TextSize = "small" | "default" | "large" | "larger";
export type Corners = "square" | "default" | "round";

export const SCHEMES: readonly { readonly value: SchemeChoice; readonly label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
export const WIDTHS: readonly { readonly value: ContentWidth; readonly label: string }[] = [
  { value: "default", label: "Default" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];
export const TEXT_SIZES: readonly { readonly value: TextSize; readonly label: string }[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];
export const CORNERS: readonly { readonly value: Corners; readonly label: string }[] = [
  { value: "square", label: "Square" },
  { value: "default", label: "Default" },
  { value: "round", label: "Round" },
];
const CONTENT_WIDTHS: Record<ContentWidth, string | undefined> = { default: undefined, wide: "1040px", full: "none" };
const TEXT_SCALES: Record<TextSize, string | undefined> = { small: "0.93", default: undefined, large: "1.07", larger: "1.15" };
const RADIUS_SCALES: Record<Corners, string | undefined> = { square: "0", default: undefined, round: "1.5" };

/** A theme's base colors, each the token of its name (`bg` is `--bg`); the colors `styles.css` derives come from them. */
export const THEME_COLORS = ["bg", "text", "accent"] as const;
export type ThemeColorName = (typeof THEME_COLORS)[number];

/** What plugins offer to choose from (the `Themes`, `Accents`, and `Fonts` slots), in order. */
export interface LookChoices {
  readonly themes: readonly {
    readonly id: string;
    readonly scheme: Scheme;
    readonly colors: { readonly [Name in ThemeColorName]?: string | undefined };
    readonly tokens?: Readonly<Record<string, string>> | undefined;
  }[];
  readonly accents: readonly { readonly id: string; readonly color: string | { readonly light: string; readonly dark: string } }[];
  readonly fonts: readonly { readonly id: string; readonly kind: "ui" | "mono"; readonly family: string }[];
}

/** The page's look: its scheme, the tokens over the stylesheet's own, and what was chosen but cannot show. */
export interface Look {
  readonly scheme: Scheme;
  readonly tokens: Record<string, string>;
  /** Each a setting naming what no plugin offers now (its plugin is off) or no CSS color: the default shows. */
  readonly missing: readonly MissingChoice[];
}
export interface MissingChoice {
  readonly field: "lightTheme" | "darkTheme" | "accent";
  readonly value: string;
}

/** The scheme to paint: the chosen one, or the system's for `system`. */
export const resolveScheme = (scheme: SchemeChoice | undefined, prefersDark: boolean): Scheme =>
  scheme === "light" || scheme === "dark" ? scheme : prefersDark ? "dark" : "light";

/** Lemma's own theme for each scheme: the one showing when none is chosen, whatever else plugins offer. */
export const LEMMA_THEMES: Readonly<Record<Scheme, string>> = { light: "lemma-light", dark: "lemma-dark" };

/** The theme showing for `scheme` when none is chosen: Lemma's own if offered, else the first offered. */
export const defaultTheme = <T extends LookChoices["themes"][number]>(themes: readonly T[], scheme: Scheme): T | undefined => {
  const offered = themes.filter((theme) => theme.scheme === scheme);
  return offered.find((theme) => theme.id === LEMMA_THEMES[scheme]) ?? offered[0];
};

/** The theme showing for `scheme`: the one chosen if offered, else the default. */
export const themeFor = <T extends LookChoices["themes"][number]>(settings: AppearanceSettings, themes: readonly T[], scheme: Scheme): T | undefined => {
  const chosen = scheme === "light" ? settings.lightTheme : settings.darkTheme;
  return themes.find((theme) => theme.scheme === scheme && theme.id === chosen) ?? defaultTheme(themes, scheme);
};

/** The tokens a theme sets: its base colors (`bg` is `--bg`), then its other tokens. */
export const themeTokens = (theme: LookChoices["themes"][number] | undefined): Record<string, string> => {
  const tokens: Record<string, string> = {};
  for (const name of THEME_COLORS) {
    const color = theme?.colors[name];
    if (color) tokens[`--${name}`] = color;
  }
  return { ...tokens, ...theme?.tokens };
};

/** The accent's color for `scheme`: an offered accent's, or the setting itself if `isColor` takes it. */
export const accentColor = (accent: string | undefined, choices: LookChoices, scheme: Scheme, isColor: (value: string) => boolean): string | undefined => {
  const value = accent?.trim();
  if (!value) return undefined;
  const offered = choices.accents.find((candidate) => candidate.id === value);
  if (offered !== undefined) return typeof offered.color === "string" ? offered.color : offered.color[scheme];
  return isColor(value) ? value : undefined;
};

/** The tokens `scheme` shows with: its theme's, and the accent over them. What a preview of it paints. */
export const schemeTokens = (
  settings: AppearanceSettings,
  choices: LookChoices,
  scheme: Scheme,
  isColor: (value: string) => boolean,
): Record<string, string> => {
  const accent = accentColor(settings.accent, choices, scheme, isColor);
  return { ...themeTokens(themeFor(settings, choices.themes, scheme)), ...(accent === undefined ? {} : { "--accent": accent }) };
};

/** The system's fonts, after a font-family list that names no generic family to fall back to. */
const FALLBACKS: Record<"ui" | "mono", string> = { ui: "ui-sans-serif, system-ui, sans-serif", mono: "ui-monospace, monospace" };
const GENERIC = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong)$/i;

/**
 * The font-family list for a font setting: an offered font's, or the setting
 * as written (a list of one's own, or the id of a font whose plugin is off),
 * ending in the system's fonts unless it ends in a generic family already.
 */
const fontFamily = (value: string | undefined, kind: "ui" | "mono", choices: LookChoices) => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const family = choices.fonts.find((font) => font.id === trimmed && font.kind === kind)?.family ?? trimmed;
  const last = family
    .split(",")
    .at(-1)!
    .trim()
    .replace(/^["']|["']$/g, "");
  return GENERIC.test(last) ? family : `${family}, ${FALLBACKS[kind]}`;
};

/**
 * The look `settings` choose among `choices`: the scheme's theme and the
 * accent, then the fonts, sizes, and width. A theme or accent no plugin offers, or an
 * accent that is no color, is left out and listed in `missing`.
 */
export const resolveLook = (settings: AppearanceSettings, choices: LookChoices, prefersDark: boolean, isColor: (value: string) => boolean): Look => {
  const scheme = resolveScheme(settings.scheme, prefersDark);
  const missing: MissingChoice[] = [];
  for (const [field, wanted] of [
    ["lightTheme", "light"],
    ["darkTheme", "dark"],
  ] as const) {
    const theme = settings[field];
    if (theme !== undefined && !choices.themes.some((candidate) => candidate.id === theme && candidate.scheme === wanted))
      missing.push({ field, value: theme });
  }
  const tokens = schemeTokens(settings, choices, scheme, isColor);
  if (settings.accent?.trim() && accentColor(settings.accent, choices, scheme, isColor) === undefined)
    missing.push({ field: "accent", value: settings.accent.trim() });
  const font = fontFamily(settings.font, "ui", choices);
  if (font !== undefined) tokens["--font-ui"] = font;
  const mono = fontFamily(settings.monoFont, "mono", choices);
  if (mono !== undefined) tokens["--font-mono"] = mono;
  const content = CONTENT_WIDTHS[settings.contentWidth ?? "default"];
  if (content !== undefined) tokens["--content"] = content;
  const text = TEXT_SCALES[settings.textSize ?? "default"];
  if (text !== undefined) tokens["--text-scale"] = text;
  const radius = RADIUS_SCALES[settings.corners ?? "default"];
  if (radius !== undefined) tokens["--radius-scale"] = radius;
  return { scheme, tokens, missing };
};
