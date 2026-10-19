import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import { SettingRow, Toggle } from "@lemma/look";
import type { NotifyService, PluginsService, SlotsService } from "@lemma/web";
import type { ChatConfig } from "./config.ts";

type Config = typeof ChatConfig.Type;
type BooleanKey = { readonly [K in keyof Config]: Config[K] extends boolean ? K : never }[keyof Config];

/** Each switch of its config: its row's title, what it does, and what a search of the settings matches. */
const SWITCHES: readonly { readonly key: BooleanKey; readonly title: string; readonly description: string; readonly text: string }[] = [
  {
    key: "foldWork",
    title: "Fold finished work",
    description: "Once a turn ends, its thinking and tool calls fold into one line above the answer.",
    text: "Fold finished work collapse thinking tool calls turn",
  },
  {
    key: "expandTools",
    title: "Open tool calls",
    description: "Show every tool call's arguments and output, instead of one quiet line.",
    text: "Open tool calls expand expanded arguments output details",
  },
  {
    key: "promptRail",
    title: "Prompt rail",
    description: "Mark your prompts beside the chat, where there is room: point at one to preview it, click to go to it.",
    text: "Prompt rail minimap jump to prompts outline navigation",
  },
];

/** How the conversation shows, in General: its own config, written as the Plugins page would. */
export const addSettings = (slots: SlotsService, webPlugins: PluginsService, notify: NotifyService, id: string, config: Config) => {
  const settings = SWITCHES.map((entry) => ({ ...entry, setting: configSetting<boolean>(webPlugins, notify, id, entry.key) }));
  slots.add(SettingsGroups, {
    id: "chat.settings",
    order: 30,
    section: SectionIds.general,
    title: "Conversation",
    entries: () =>
      settings.map((entry) => ({
        text: entry.text,
        view: () => (
          <SettingRow title={entry.title} description={entry.description}>
            <Toggle label={entry.title} checked={entry.setting.value() ?? config[entry.key]} onChange={entry.setting.set} />
          </SettingRow>
        ),
      })),
  });
};
