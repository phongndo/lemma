import { createEffect, createMemo, createSignal, createUniqueId } from "solid-js";
import { paint, unpaint } from "../../lib/paint.ts";
import { APPEARANCE_PLUGIN, AppearanceConfig, resolveLook } from "../../model/appearance.ts";
import { Accents, Fonts, Slots, Themes } from "../../ui/contracts.ts";
import { defineUiPlugin } from "../../ui/define.ts";
import { ACCENTS, FONTS, THEMES } from "./presets.ts";

const isColor = (value: string) => CSS.supports("color", value);

/**
 * The look: its config (`ui.appearance`) chooses a scheme, a theme for each
 * scheme, an accent, fonts, and the conversation width, among what the
 * `Themes`, `Accents`, and `Fonts` slots offer, and it paints that look on the
 * page (`lib/paint.ts`), which the next load shows before plugins start. It
 * adds Lemma's own choices to those slots as any plugin adds its, so a theme a
 * plugin adds is chosen the same way and stops showing when that plugin does.
 * It draws nothing: `appearance-page` edits its config, as anything may.
 * Turned off, the page returns to the system scheme and the stylesheet's look.
 */
export default defineUiPlugin({
  id: APPEARANCE_PLUGIN,
  config: AppearanceConfig,
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    for (const [index, theme] of THEMES.entries()) slots.add(Themes, { ...theme, order: index });
    for (const [index, accent] of ACCENTS.entries()) slots.add(Accents, { ...accent, order: 10 * (index + 1) });
    for (const [index, font] of FONTS.entries()) slots.add(Fonts, { ...font, order: 10 * (index + 1) });

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const [prefersDark, setPrefersDark] = createSignal(dark.matches);
    const onScheme = () => setPrefersDark(dark.matches);
    dark.addEventListener("change", onScheme);
    plugin.onCleanup(() => dark.removeEventListener("change", onScheme));

    const choices = () => ({ themes: slots.list(Themes), accents: slots.list(Accents), fonts: slots.list(Fonts) });
    const look = createMemo(() => resolveLook(plugin.config, choices(), prefersDark(), isColor));
    const owner = `appearance-${createUniqueId()}`;
    createEffect(() => paint({ theme: look().scheme, tokens: look().tokens }, owner));
    // A replacement paints before this instance stops; `unpaint` leaves its look alone.
    plugin.onCleanup(() => unpaint(owner));
  },
});
