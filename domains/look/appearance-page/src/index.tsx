import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { load, save } from "@lemma/web/storage";
import {
  APPEARANCE_PLUGIN,
  LEGACY_KEYS,
  LOOK_PLUGINS,
  SCHEMES,
  decodeSettings,
  defaultTheme,
  legacySettings,
  resolveLook,
  settingValue,
  themeFor,
  themeTokens,
  Accents,
  Fonts,
  Themes,
  LaptopIcon,
  PaletteIcon,
} from "@lemma/look";
import type { Accent, AppearanceSettings, Field, Scheme } from "@lemma/look";
import { ActionIds, Actions } from "@lemma/actions";
import type { PaletteItem, PalettePage } from "@lemma/actions";
import { SectionIds, SettingsGroups, SettingsSections } from "@lemma/settings";
import { Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import styles from "./appearance-page.css?inline";
import { AccentPicker, CornersSetting, FontSetting, PluginSwitch, Preview, SchemePicker, TextSizeSetting, ThemeCards, WidthSetting } from "./views.tsx";
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
 * Settings › Appearance, and the palette's Theme page: an editor
 * of the `appearance` plugin's config, which it reads from the plugin list and
 * writes as the Plugins page would, without depending on that plugin, so it
 * stays put while the plugin restarts with each change. Its preview resolves
 * the look with the same model, from what the look's slots offer. On its first
 * start it carries the scheme and width an older app kept in the browser into
 * that config.
 */
export default defineWebPlugin({
  id: "look.appearance-page",
  styles,
  requires: { slots: Slots, webPlugins: WebPlugins, notify: Notify },
  setup: ({ slots, webPlugins, notify }, plugin) => {
    const row = () => webPlugins.list().find((candidate) => candidate.id === APPEARANCE_PLUGIN);
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
    let carried = webPlugins.safe;
    createEffect(() => {
      const appearance = row();
      if (carried || appearance === undefined) return;
      carried = true;
      const legacy = legacySettings({ scheme: load(LEGACY_KEYS.scheme), contentWidth: load(LEGACY_KEYS.contentWidth) }, saved());
      const forget = () => {
        for (const key of Object.values(LEGACY_KEYS)) save(key, undefined);
      };
      if (Object.keys(legacy).length === 0) return forget();
      webPlugins.setConfig(appearance, legacy).then(forget, (error) => notify.report(error, "Could not carry over the appearance"));
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
      webPlugins.setConfig(appearance, { [field]: next ?? null }).catch((error) => {
        setPending(undefined);
        notify.report(error, "Could not change the appearance");
      });
    };

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const [prefersDark, setPrefersDark] = createSignal(dark.matches);
    const onScheme = () => setPrefersDark(dark.matches);
    plugin.listen(dark, "change", onScheme);

    const choices = createMemo<Choices>(() => ({ themes: slots.list(Themes), accents: slots.list(Accents), fonts: slots.list(Fonts) }));
    const look = createMemo(() => resolveLook(settings(), choices(), prefersDark(), isColor));
    const deps: Deps = { settings, set, choices, look };

    // Which theme rows show: a scheme with a choice of themes, or a theme chosen that is gone. Memos, so a pick redraws no row.
    const choosing = (scheme: Scheme) =>
      createMemo(
        () =>
          choices().themes.filter((theme) => theme.scheme === scheme).length > 1 ||
          look().missing.some((choice) => choice.field === (scheme === "light" ? "lightTheme" : "darkTheme")),
      );
    /** The themes offered for `scheme`, for a search to find them by name. */
    const titles = (scheme: Scheme) =>
      choices()
        .themes.filter((theme) => theme.scheme === scheme)
        .map((theme) => theme.title)
        .join(" ");
    const choosingLight = choosing("light");
    const choosingDark = choosing("dark");

    // The rows, each made once: a group asked for its entries again (the Theme group, as the look changes) keeps its rows
    // drawn, and a menu open in one (`SettingsGroup.entries`).
    const previewRows = [{ text: "Preview look config", view: () => <Preview deps={deps} /> }];
    const schemeRow = { text: "Theme scheme color mode dark light system", view: () => <SchemePicker deps={deps} /> };
    // A theme row is one object, its text read as a search asks, so a theme added or removed keeps the row drawn.
    const themeRow = (scheme: Scheme) => ({
      get text() {
        return `${scheme === "light" ? "Light" : "Dark"} theme palette ${titles(scheme)}`;
      },
      view: () => <ThemeCards deps={deps} scheme={scheme} />,
    });
    const lightRow = themeRow("light");
    const darkRow = themeRow("dark");
    const accentRow = { text: "Accent color colour highlight primary buttons links", view: () => <AccentPicker deps={deps} /> };
    const textRows = [
      {
        text: "Font typeface interface family",
        view: () => <FontSetting deps={deps} kind="ui" title="Interface" description="Menus, settings, and the conversation." />,
      },
      {
        text: "Monospace font code typeface mono",
        view: () => <FontSetting deps={deps} kind="mono" title="Code" description="Code blocks, diffs, and tool output." />,
      },
      { text: "Text size font scale zoom larger smaller", view: () => <TextSizeSetting deps={deps} /> },
    ];
    const layoutRows = [
      { text: "Corners radius rounded square round", view: () => <CornersSetting deps={deps} /> },
      { text: "Conversation width layout wide full", view: () => <WidthSetting deps={deps} /> },
    ];
    const painting = () => row()?.state === "active";
    const customized = () => Object.values(settings()).some((value) => value !== undefined);
    const reset = () => {
      const appearance = row();
      if (appearance === undefined) return;
      const cleared = Object.fromEntries(Object.keys(settings()).map((field) => [field, null]));
      setPending({});
      return webPlugins.setConfig(appearance, cleared).catch((error) => {
        setPending(undefined);
        notify.report(error, "Could not reset the appearance");
      });
    };

    // The look's optional plugins, each a switch: on and off as the Plugins page turns them.
    type PluginStatus = ReturnType<typeof webPlugins.list>[number];
    const [switching, setSwitching] = createSignal<ReadonlyMap<string, boolean>>(new Map());
    const pluginRow = (id: string) => webPlugins.list().find((candidate) => candidate.id === id);
    const isOn = (found: PluginStatus) => switching().get(found.id) ?? found.enabled;
    const turn = (found: PluginStatus, on: boolean) => {
      setSwitching((now) => new Map(now).set(found.id, on));
      webPlugins
        .setEnabled(found, on)
        .catch((error) => notify.report(error, `Could not turn ${on ? "on" : "off"} ${found.id}`))
        .finally(() =>
          setSwitching((now) => {
            const next = new Map(now);
            next.delete(found.id);
            return next;
          }),
        );
    };
    const switches = [
      {
        id: LOOK_PLUGINS.highlight,
        title: "Syntax highlighting",
        text: "Syntax highlighting code colors shiki",
        description: "Colors code blocks by their language.",
      },
      {
        id: LOOK_PLUGINS.diagrams,
        title: "Diagrams",
        text: "Diagrams mermaid charts flowcharts",
        description: "Draws mermaid code blocks as diagrams, with their source a click away.",
      },
      {
        id: LOOK_PLUGINS.fileIcons,
        title: "File icons",
        text: "File icons type colored",
        description: "Shows each file's type as its own colored icon, wherever a file is named.",
      },
    ] as const;
    // Made once each, offered while their plugin is there.
    const switchRows = switches.map((entry) => ({
      id: entry.id,
      text: entry.text,
      view: () => (
        <Show when={pluginRow(entry.id)}>
          {(plugin) => <PluginSwitch title={entry.title} description={entry.description} on={isOn(plugin())} onChange={(on) => turn(plugin(), on)} />}
        </Show>
      ),
    }));

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
      actions: () => (
        <Show when={customized()}>
          <button class="button small" data-tip="Return every appearance setting to its default" onClick={plugin.action("reset appearance", reset)}>
            Reset
          </button>
        </Show>
      ),
    });
    slots.add(SettingsGroups, {
      id: "appearance.preview",
      order: 0,
      section,
      entries: () => previewRows,
    });
    slots.add(SettingsGroups, {
      id: "appearance.theme",
      order: 10,
      section,
      title: "Theme",
      entries: () => [schemeRow, ...(choosingLight() ? [lightRow] : []), ...(choosingDark() ? [darkRow] : []), accentRow],
    });
    slots.add(SettingsGroups, {
      id: "appearance.text",
      order: 20,
      section,
      title: "Text",
      entries: () => textRows,
    });
    slots.add(SettingsGroups, {
      id: "appearance.layout",
      order: 30,
      section,
      title: "Layout",
      entries: () => layoutRows,
    });
    slots.add(SettingsGroups, {
      id: "appearance.plugins",
      order: 40,
      section,
      title: "Code and files",
      entries: () => switchRows.filter((row) => pluginRow(row.id) !== undefined),
    });

    // The palette's Theme page: the Theme group's choices, the scheme, each scheme's theme, and the accent, each theme and
    // accent shown in its own colors.
    const themeSwatch = (scheme: Scheme, theme: Parameters<typeof themeTokens>[0]) => () => (
      <span class="appearance-swatch appearance-swatch-theme" data-theme={scheme} style={themeTokens(theme)} />
    );
    const accentSwatch = (color: string) => () => <span class="appearance-swatch" style={{ background: color }} />;
    const colorOf = (accent: Accent) => (typeof accent.color === "string" ? accent.color : accent.color[look().scheme]);
    const themePage = (scheme: Scheme): PalettePage => {
      const field = scheme === "light" ? "lightTheme" : "darkTheme";
      return {
        title: scheme === "light" ? "Light theme" : "Dark theme",
        items: () => {
          const themes = choices().themes;
          const shown = themeFor(settings(), themes, scheme);
          const fallback = defaultTheme(themes, scheme);
          return themes
            .filter((theme) => theme.scheme === scheme)
            .map((theme) => ({
              key: `appearance.theme:${theme.id}`,
              title: theme.title,
              icon: themeSwatch(scheme, theme),
              current: shown?.id === theme.id,
              run: () => set(field, theme.id === fallback?.id ? undefined : theme.id),
            }));
        },
      };
    };
    const accentPage: PalettePage = {
      title: "Accent",
      items: () => [
        {
          key: "appearance.accent:theme",
          title: "The theme's own",
          icon: themeSwatch(look().scheme, themeFor(settings(), choices().themes, look().scheme)),
          current: settings().accent === undefined,
          run: () => set("accent", undefined),
        },
        ...choices().accents.map((accent) => ({
          key: `appearance.accent:${accent.id}`,
          title: accent.title,
          icon: accentSwatch(colorOf(accent)),
          current: settings().accent === accent.id,
          run: () => set("accent", accent.id),
        })),
      ],
    };
    const themeItems = (): PaletteItem[] => {
      const scheme = settings().scheme ?? "system";
      const shownTheme = (each: Scheme) => themeFor(settings(), choices().themes, each);
      const accent = settings().accent;
      const preset = choices().accents.find((each) => each.id === accent);
      return [
        // Light and dark show their theme; the system's, the computer it follows.
        ...SCHEMES.map((choice) => ({
          key: `appearance.scheme:${choice.value}`,
          category: "Scheme",
          title: choice.label,
          keywords: ["mode"],
          icon: choice.value === "system" ? LaptopIcon : themeSwatch(choice.value, shownTheme(choice.value)),
          current: scheme === choice.value,
          run: () => set("scheme", choice.value),
        })),
        ...[...(choosingLight() ? (["light"] as const) : []), ...(choosingDark() ? (["dark"] as const) : [])].map((each: Scheme) => ({
          key: `appearance.${each}-theme`,
          title: each === "light" ? "Light theme" : "Dark theme",
          detail: shownTheme(each)?.title,
          icon: themeSwatch(each, shownTheme(each)),
          page: () => themePage(each),
        })),
        {
          key: "appearance.accent",
          title: "Accent",
          detail: accent === undefined ? "The theme's own" : (preset?.title ?? accent),
          icon: accent === undefined ? themeSwatch(look().scheme, shownTheme(look().scheme)) : accentSwatch(preset === undefined ? accent : colorOf(preset)),
          page: () => accentPage,
        },
      ];
    };
    slots.add(Actions, {
      id: "appearance.theme",
      order: 200,
      title: "Theme…",
      category: "Appearance",
      icon: PaletteIcon,
      keywords: ["scheme", "dark mode", "light mode", "accent", "color", "colour"],
      page: () => ({ title: "Theme", items: themeItems }),
      run: () => slots.get(Actions, ActionIds.palette)?.run("appearance.theme"),
    });
  },
});
