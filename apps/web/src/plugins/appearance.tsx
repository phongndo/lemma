import { createEffect, createSignal, createUniqueId } from "solid-js";
import { paint, unpaint } from "../lib/paint.ts";
import { load, save } from "../lib/storage.ts";
import { SettingsGroups, SettingsSections, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { PaletteIcon, Segmented, SettingRow } from "../ui/parts.tsx";

type Theme = "system" | "light" | "dark";
/** How wide the conversation runs. */
type ContentWidth = "default" | "wide" | "full";

const THEME_KEY = "lemma.theme";
const WIDTH_KEY = "lemma.contentWidth";
const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const WIDTHS: readonly { value: ContentWidth; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];
const CONTENT_WIDTHS: Record<ContentWidth, string | undefined> = { default: undefined, wide: "1040px", full: "none" };

/** A remembered choice, or the default when absent or not one of `choices` (an old or hand-edited value). */
const stored = <T extends string>(key: string, choices: readonly { readonly value: T }[], fallback: T): T => {
  const value = load(key);
  return choices.find((choice) => choice.value === value)?.value ?? fallback;
};
const storedTheme = () => stored<Theme>(THEME_KEY, THEMES, "system");
const storedWidth = () => stored<ContentWidth>(WIDTH_KEY, WIDTHS, "default");
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Theme and conversation width, remembered in this browser and painted on the
 * page (`lib/paint.ts`), which the next load shows before plugins start.
 * Turned off, the page returns to the system theme. Stylesheets in
 * `~/.lemma/ui` override any other `--` token.
 */
export default defineUiPlugin({
  id: "appearance",
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    const [theme, setTheme] = createSignal(storedTheme());
    const [width, setWidth] = createSignal(storedWidth());
    const dark = darkQuery();
    const [prefersDark, setPrefersDark] = createSignal(dark.matches);
    const onScheme = () => setPrefersDark(dark.matches);
    dark.addEventListener("change", onScheme);
    plugin.onCleanup(() => dark.removeEventListener("change", onScheme));
    const owner = `appearance-${createUniqueId()}`;
    createEffect(() => {
      const content = CONTENT_WIDTHS[width()];
      paint(
        { theme: theme() === "system" ? (prefersDark() ? "dark" : "light") : (theme() as "light" | "dark"), ...(content === undefined ? {} : { content }) },
        owner,
      );
    });
    // A replacement paints before this instance stops; `unpaint` leaves its look alone.
    plugin.onCleanup(() => unpaint(owner));

    slots.add(SettingsSections, { id: "appearance", order: 10, title: "Appearance", icon: PaletteIcon });
    slots.add(SettingsGroups, {
      id: "appearance",
      section: "appearance",
      entries: () => [
        {
          text: "Theme color scheme dark light system mode",
          view: () => (
            <SettingRow title="Theme" description="System follows your browser or OS setting.">
              <Segmented
                label="Theme"
                value={theme()}
                options={THEMES}
                onChange={(next) => {
                  save(THEME_KEY, next === "system" ? undefined : next);
                  setTheme(next);
                }}
              />
            </SettingRow>
          ),
        },
        {
          text: "Conversation width layout wide full",
          view: () => (
            <SettingRow title="Conversation width" description="How wide the transcript and composer run on large screens.">
              <Segmented
                label="Conversation width"
                value={width()}
                options={WIDTHS}
                onChange={(next) => {
                  save(WIDTH_KEY, next === "default" ? undefined : next);
                  setWidth(next);
                }}
              />
            </SettingRow>
          ),
        },
      ],
    });
  },
});
