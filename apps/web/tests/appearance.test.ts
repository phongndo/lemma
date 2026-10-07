import { describe, expect, it } from "vitest";
import { decodeSettings, legacySettings, resolveLook, resolveScheme, schemeTokens, settingValue } from "../src/model/appearance.ts";
import type { LookChoices } from "../src/model/appearance.ts";

const choices: LookChoices = {
  themes: [
    { id: "lemma-light", scheme: "light", colors: {} },
    { id: "lemma-dark", scheme: "dark", colors: {} },
    { id: "night", scheme: "dark", colors: { bg: "#101020", text: "#e0e0ff" }, tokens: { "--code-keyword": "#ff79c6" } },
  ],
  accents: [
    { id: "blue", color: "oklch(0.62 0.17 255)" },
    { id: "duo", color: { light: "#003366", dark: "#99ccff" } },
  ],
  fonts: [
    { id: "inter", kind: "ui", family: "Inter, sans-serif" },
    { id: "jetbrains", kind: "mono", family: "JetBrains Mono, monospace" },
  ],
};
const isColor = (value: string) => value.startsWith("#") || value.startsWith("rgb");

describe("resolveLook", () => {
  it("sets no tokens by default, leaving the stylesheet's own look", () => {
    expect(resolveLook({}, choices, false, isColor)).toEqual({ scheme: "light", tokens: {}, missing: [] });
    expect(resolveLook({ contentWidth: "default", accent: " ", font: "" }, choices, true, isColor)).toEqual({ scheme: "dark", tokens: {}, missing: [] });
  });

  it("paints the scheme's theme as its base colors and tokens, with the accent, fonts, and width over it", () => {
    const look = resolveLook(
      { scheme: "dark", darkTheme: "night", accent: "blue", font: "inter", monoFont: "jetbrains", contentWidth: "full" },
      choices,
      false,
      isColor,
    );
    expect(look).toEqual({
      scheme: "dark",
      tokens: {
        "--bg": "#101020",
        "--text": "#e0e0ff",
        "--code-keyword": "#ff79c6",
        "--accent": "oklch(0.62 0.17 255)",
        "--font-ui": "Inter, sans-serif",
        "--font-mono": "JetBrains Mono, monospace",
        "--content": "none",
      },
      missing: [],
    });
    // The light scheme keeps its own theme.
    expect(resolveLook({ scheme: "light", darkTheme: "night" }, choices, true, isColor).tokens).toEqual({});
  });

  it("takes an accent's color for the scheme, a CSS color, or a font-family list as written", () => {
    expect(schemeTokens({ accent: "duo" }, choices, "light", isColor)).toEqual({ "--accent": "#003366" });
    expect(schemeTokens({ accent: "duo", darkTheme: "night" }, choices, "dark", isColor)["--accent"]).toBe("#99ccff");
    expect(resolveLook({ accent: "#7aa2f7", font: "Georgia, serif" }, choices, false, isColor).tokens).toEqual({
      "--accent": "#7aa2f7",
      "--font-ui": "Georgia, serif",
    });
    // A list without a generic family, or the id of a font whose plugin is off, falls back to the system's.
    expect(resolveLook({ font: "Iosevka", monoFont: "plugin-mono" }, choices, false, isColor).tokens).toEqual({
      "--font-ui": "Iosevka, ui-sans-serif, system-ui, sans-serif",
      "--font-mono": "plugin-mono, ui-monospace, monospace",
    });
  });

  it("scales every font and corner by the text size and corners chosen", () => {
    expect(resolveLook({ textSize: "large", corners: "square" }, choices, false, isColor).tokens).toEqual({ "--text-scale": "1.07", "--radius-scale": "0" });
    expect(resolveLook({ textSize: "default", corners: "default" }, choices, false, isColor).tokens).toEqual({});
  });

  it("keeps Lemma's theme as the default whatever order a plugin offers its theme in", () => {
    const first = { ...choices, themes: [{ id: "loud", scheme: "dark" as const, colors: { bg: "red" } }, ...choices.themes] };
    expect(resolveLook({ scheme: "dark" }, first, false, isColor).tokens).toEqual({});
    expect(resolveLook({ scheme: "dark", darkTheme: "loud" }, first, false, isColor).tokens).toEqual({ "--bg": "red" });
  });

  it("shows the default for a choice no plugin offers, and says which", () => {
    const look = resolveLook({ scheme: "dark", darkTheme: "gone", lightTheme: "night", accent: "teal" }, choices, false, isColor);
    expect(look.tokens).toEqual({});
    expect(look.missing).toEqual([
      { field: "lightTheme", value: "night" },
      { field: "darkTheme", value: "gone" },
      { field: "accent", value: "teal" },
    ]);
  });

  it("follows the system scheme unless one is chosen", () => {
    expect([resolveScheme(undefined, true), resolveScheme("system", false), resolveScheme("light", true), resolveScheme("dark", false)]).toEqual([
      "dark",
      "light",
      "light",
      "dark",
    ]);
  });
});

describe("the config row", () => {
  it("decodes what it can, and nothing from a row that does not decode", () => {
    expect(decodeSettings({ scheme: "dark", accent: "blue" })).toEqual({ scheme: "dark", accent: "blue" });
    expect(decodeSettings(undefined)).toEqual({});
    expect(decodeSettings({ scheme: "sepia" })).toEqual({});
  });

  it("carries over what an older app kept in the browser, where it is still valid and not the default", () => {
    expect(legacySettings({ scheme: "dark", contentWidth: "full" })).toEqual({ scheme: "dark", contentWidth: "full" });
    expect(legacySettings({ scheme: "system", contentWidth: "default" })).toEqual({});
    expect(legacySettings({ scheme: "sepia", contentWidth: "wide" })).toEqual({ contentWidth: "wide" });
    expect(legacySettings({})).toEqual({});
    // A field config sets wins; the other still carries over.
    expect(legacySettings({ scheme: "dark", contentWidth: "full" }, { accent: "blue", contentWidth: "wide" })).toEqual({ scheme: "dark" });
  });

  it("writes a value, and unsets a blank one or the default", () => {
    expect(settingValue("accent", " blue ")).toBe("blue");
    for (const [field, value] of [
      ["accent", " "],
      ["scheme", "system"],
      ["contentWidth", "default"],
      ["textSize", "default"],
      ["corners", "default"],
      ["font", undefined],
    ] as const) {
      expect(settingValue(field, value), field).toBeUndefined();
    }
  });
});
