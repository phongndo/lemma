import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import { Segmented, SettingRow } from "@lemma/look";
import type { NotifyService, PluginsService, SlotsService } from "@lemma/web";

/** The timeouts offered, in seconds; 0 is none. */
const PRESETS = [60, 300, 600, 1800, 0];

/** `600` reads as `10 min`, `0` as `None`. */
export const timeoutLabel = (seconds: number): string => (seconds === 0 ? "None" : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);

/** Its default timeout, in General › Agent: its host half's config, written as the Plugins page would. */
export const addSettings = (slots: SlotsService, host: PluginsService, notify: NotifyService, id: string) => {
  const timeout = configSetting<number>(host, notify, id, "timeout");
  slots.add(SettingsGroups, {
    id: "bash.settings",
    order: 50,
    section: SectionIds.general,
    title: "Agent",
    entries: () =>
      timeout.value() === undefined
        ? []
        : [
            {
              text: "Agent command timeout bash shell tool seconds minutes limit",
              view: () => {
                // A timeout set in the file that is none of these is offered beside them.
                const options = () =>
                  [...new Set([...PRESETS.filter((seconds) => seconds !== 0), timeout.value() ?? 600])]
                    .filter((seconds) => seconds !== 0)
                    .sort((a, b) => a - b)
                    .concat(0)
                    .map((seconds) => ({ value: String(seconds), label: timeoutLabel(seconds) }));
                return (
                  <SettingRow title="Command timeout" description="How long a shell command may run when the agent names no limit of its own.">
                    <Segmented label="Command timeout" value={String(timeout.value())} options={options()} onChange={(next) => timeout.set(Number(next))} />
                  </SettingRow>
                );
              },
            },
          ],
  });
};
