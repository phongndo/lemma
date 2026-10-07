import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { load, save } from "../../lib/storage.ts";
import { APPEARANCE_PLUGIN, LEGACY_KEYS, decodeSettings, legacySettings, resolveLook, schemeTokens, settingValue } from "../../model/appearance.ts";
import type { AppearanceSettings, Field, Scheme, SchemeChoice } from "../../model/appearance.ts";
import { Accents, Actions, Fonts, Notify, SectionIds, SettingsGroups, SettingsSections, Slots, Themes, UiPlugins } from "../../ui/contracts.ts";
import { defineUiPlugin } from "../../ui/define.ts";
import { PaletteIcon } from "../../ui/parts.tsx";
import styles from "./appearance-page.css?inline";
import { AccentPicker, CornersSetting, FontSetting, Preview, SchemePicker, TextSizeSetting, ThemeChoice, WidthSetting } from "./views.tsx";
import type { Choices, Deps } from "./views.tsx";

const isColor = (value: string) => CSS.supports("color", value);
/** Settings as one comparable value: what is set, by name. */
const same = (a: AppearanceSettings, b: AppearanceSettings) => {
  const set = (settings: AppearanceSettings) =>
    JSON.stringify(
      Object.entries(settings)
        .filter(([, value]) => value !== undefined)
        .sort(),
    );
  return set(a) === set(b);
};

/**
 * Settings › Appearance, and the palette's commands for the scheme: an editor
 * of the `appearance` plugin's config, which it reads from the plugin list and
 * writes as the Plugins page would, without depending on that plugin, so it
 * stays put while the plugin restarts with each change. Its preview resolves
 * the look with the same model, from what the look's slots offer. On its first
 * start it carries the scheme and width an older app kept in the browser into
 * that config.
 */
export default defineUiPlugin({
  id: "appearance-page",
  styles,
  requires: { slots: Slots, uiPlugins: UiPlugins, notify: Notify },
  setup: ({ slots, uiPlugins, notify }, plugin) => {
    const row = () => uiPlugins.list().find((candidate) => candidate.id === APPEARANCE_PLUGIN);
    const saved = createMemo(() => decodeSettings(row()?.config?.values), undefined, { equals: same });
    // What was just set shows until the plugin list catches up with it.
    const [pending, setPending] = createSignal<AppearanceSettings>();
    createEffect(() => {
      const wanted = pending();
      if (wanted !== undefined && same(wanted, saved())) setPending(undefined);
    });
    const settings = () => pending() ?? saved();
    // Once: carry the scheme and width an older app kept in this browser into config, then forget them. A field
    // config sets already wins. `?safe` ignores the config, so it would look empty: the keys wait for a normal start.
    let carried = uiPlugins.safe;
    createEffect(() => {
      const appearance = row();
      if (carried || appearance === undefined) return;
      carried = true;
      const legacy = legacySettings({ scheme: load(LEGACY_KEYS.scheme), contentWidth: load(LEGACY_KEYS.contentWidth) }, saved());
      const forget = () => {
        for (const key of Object.values(LEGACY_KEYS)) save(key, undefined);
      };
      if (Object.keys(legacy).length === 0) return forget();
      uiPlugins.setConfig(appearance, legacy).then(forget, (error) => notify.report(error, "Could not carry over the appearance"));
    });
    const set = (field: Field, value: string | undefined) => {
      const next = settingValue(field, value);
      if (settings()[field] === next) return;
      const appearance = row();
      if (appearance === undefined) {
        notify.toast({ level: "error", message: "The appearance plugin is not installed" });
        return;
      }
      setPending({ ...settings(), [field]: next });
      uiPlugins.setConfig(appearance, { [field]: next ?? null }).catch((error) => {
        setPending(undefined);
        notify.report(error, "Could not change the appearance");
      });
    };

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const [prefersDark, setPrefersDark] = createSignal(dark.matches);
    const onScheme = () => setPrefersDark(dark.matches);
    dark.addEventListener("change", onScheme);
    plugin.onCleanup(() => dark.removeEventListener("change", onScheme));

    const choices = createMemo<Choices>(() => ({ themes: slots.list(Themes), accents: slots.list(Accents), fonts: slots.list(Fonts) }));
    const look = createMemo(() => resolveLook(settings(), choices(), prefersDark(), isColor));
    const tokensFor = (scheme: Scheme) => schemeTokens(settings(), choices(), scheme, isColor);
    const deps: Deps = { settings, set, choices, look, tokensFor };

    // Which theme rows show: a scheme with a choice of themes, or a theme chosen that is gone. Memos, so a pick redraws no row.
    const choosing = (scheme: Scheme) =>
      createMemo(
        () =>
          choices().themes.filter((theme) => theme.scheme === scheme).length > 1 ||
          look().missing.some((choice) => choice.field === (scheme === "light" ? "lightTheme" : "darkTheme")),
      );
    const choosingLight = choosing("light");
    const choosingDark = choosing("dark");
    const painting = () => row()?.state === "active";

    const section = SectionIds.appearance;
    slots.add(SettingsSections, {
      id: section,
      order: 10,
      title: "Appearance",
      icon: PaletteIcon,
      intro: () => (
        <Show when={!painting()}>
          <p class="callout">The appearance plugin is off, so the system scheme and Lemma's own look show. These settings apply when it is on.</p>
        </Show>
      ),
    });
    slots.add(SettingsGroups, {
      id: "appearance.preview",
      order: 0,
      section,
      entries: () => [{ text: "Preview look config", view: () => <Preview deps={deps} /> }],
    });
    slots.add(SettingsGroups, {
      id: "appearance.theme",
      order: 10,
      section,
      title: "Theme",
      entries: () => [
        { text: "Theme scheme color mode dark light system", view: () => <SchemePicker deps={deps} /> },
        ...(choosingLight() ? [{ text: "Light theme", view: () => <ThemeChoice deps={deps} scheme="light" /> }] : []),
        ...(choosingDark() ? [{ text: "Dark theme", view: () => <ThemeChoice deps={deps} scheme="dark" /> }] : []),
        { text: "Accent color colour highlight primary buttons links", view: () => <AccentPicker deps={deps} /> },
      ],
    });
    slots.add(SettingsGroups, {
      id: "appearance.text",
      order: 20,
      section,
      title: "Text",
      entries: () => [
        {
          text: "Font typeface interface family",
          view: () => <FontSetting deps={deps} kind="ui" title="Interface" description="Menus, settings, and the conversation." />,
        },
        {
          text: "Monospace font code typeface mono",
          view: () => <FontSetting deps={deps} kind="mono" title="Code" description="Code blocks, diffs, and tool output." />,
        },
        { text: "Text size font scale zoom larger smaller", view: () => <TextSizeSetting deps={deps} /> },
      ],
    });
    slots.add(SettingsGroups, {
      id: "appearance.layout",
      order: 30,
      section,
      title: "Layout",
      entries: () => [
        { text: "Corners radius rounded square round", view: () => <CornersSetting deps={deps} /> },
        { text: "Conversation width layout wide full", view: () => <WidthSetting deps={deps} /> },
      ],
    });

    const schemes: readonly { readonly value: SchemeChoice; readonly title: string }[] = [
      { value: "light", title: "Use the light scheme" },
      { value: "dark", title: "Use the dark scheme" },
      { value: "system", title: "Follow the system scheme" },
    ];
    for (const [index, scheme] of schemes.entries()) {
      slots.add(Actions, {
        id: `appearance.scheme.${scheme.value}`,
        order: 200 + index,
        title: scheme.title,
        category: "Appearance",
        icon: PaletteIcon,
        keywords: ["theme", "dark mode", "light mode"],
        when: () => (settings().scheme ?? "system") !== scheme.value,
        run: () => set("scheme", scheme.value),
      });
    }
  },
});
