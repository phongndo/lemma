import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { load, save } from "@lemma/web/storage";
import {
  APPEARANCE_PLUGIN,
  LEGACY_KEYS,
  LOOK_PLUGINS,
  decodeSettings,
  legacySettings,
  resolveLook,
  settingValue,
  Accents,
  Fonts,
  Themes,
  PaletteIcon,
} from "@lemma/look";
import type { AppearanceSettings, Field, Scheme, SchemeChoice } from "@lemma/look";
import { Actions } from "@lemma/actions";
import { SectionIds, SettingsGroups, SettingsSections } from "@lemma/settings";
import { Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import styles from "./appearance-page.css?inline";
import { AccentPicker, CornersSetting, FontSetting, PluginSwitch, Preview, SchemePicker, TextSizeSetting, ThemeChoice, WidthSetting } from "./views.tsx";
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

    // The rows, each made once (a theme row again only when the themes a search finds it by change): a group asked for
    // its entries again then keeps its rows drawn, and a menu open in one (`SettingsGroup.entries`).
    const previewRows = [{ text: "Preview look config", view: () => <Preview deps={deps} /> }];
    const schemeRow = { text: "Theme scheme color mode dark light system", view: () => <SchemePicker deps={deps} /> };
    const lightRow = createMemo(() => ({ text: `Light theme palette ${titles("light")}`, view: () => <ThemeChoice deps={deps} scheme="light" /> }));
    const darkRow = createMemo(() => ({ text: `Dark theme palette ${titles("dark")}`, view: () => <ThemeChoice deps={deps} scheme="dark" /> }));
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
      entries: () => [schemeRow, ...(choosingLight() ? [lightRow()] : []), ...(choosingDark() ? [darkRow()] : []), accentRow],
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
      entries: () =>
        switches.flatMap((entry) => {
          const found = pluginRow(entry.id);
          return found === undefined
            ? []
            : [
                {
                  text: entry.text,
                  view: () => (
                    <PluginSwitch
                      title={entry.title}
                      description={entry.description}
                      on={isOn(pluginRow(entry.id) ?? found)}
                      onChange={(on) => turn(pluginRow(entry.id) ?? found, on)}
                    />
                  ),
                },
              ];
        }),
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
