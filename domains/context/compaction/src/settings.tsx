import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import { Segmented, SettingRow } from "@lemma/look";
import type { NotifyService, PluginsService, SlotsService } from "@lemma/web";

/** The shares offered, of the context window. */
const PRESETS = [0.6, 0.7, 0.8, 0.9];

/** `0.8` reads as `80%`. */
const share = (at: number) => `${Math.round(at * 1000) / 10}%`;

/** When it summarizes, in General › Agent: its config, which both halves share, written as the Plugins page would. */
export const addSettings = (slots: SlotsService, webPlugins: PluginsService, notify: NotifyService, id: string, config: () => number) => {
  const at = configSetting<number>(webPlugins, notify, id, "at");
  const current = () => at.value() ?? config();
  slots.add(SettingsGroups, {
    id: "compaction.settings",
    order: 45,
    section: SectionIds.general,
    title: "Agent",
    entries: () => [
      {
        text: "Agent summarize compact compaction context window full auto summary at percent",
        view: () => {
          // A share set in the file that is none of these is offered beside them.
          const options = () => [...new Set([...PRESETS, current()])].sort((a, b) => a - b).map((value) => ({ value: String(value), label: share(value) }));
          return (
            <SettingRow
              title="Summarize at"
              description="Once a thread fills this much of its model's context window, its older turns are summarized to make room. /compact does it now."
            >
              <Segmented label="Summarize at" value={String(current())} options={options()} onChange={(next) => at.set(Number(next))} />
            </SettingRow>
          );
        },
      },
    ],
  });
};
