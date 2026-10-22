import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import type { ConfigSetting, SettingsEntry } from "@lemma/settings";
import { SettingRow, Toggle } from "@lemma/look";
import { HostPlugins, Notify, Slots, defineWebPlugin } from "@lemma/web";
import styles from "./web.css?inline";

const ID = "agent.loop";

/** A whole number at least `min`, saved on Enter or on leaving the field; a blank or smaller one goes back to what is set. */
function Count(props: { label: string; value: number; min: number; unit: string; onChange: (value: number) => void }) {
  let input!: HTMLInputElement;
  const commit = () => {
    const next = Number(input.value);
    if (input.value.trim() === "" || !Number.isInteger(next) || next < props.min) input.value = String(props.value);
    else props.onChange(next);
  };
  return (
    <label class="agent-count">
      <input
        ref={input}
        class="field"
        type="number"
        inputmode="numeric"
        min={props.min}
        step="1"
        aria-label={props.label}
        value={props.value}
        onKeyDown={(event) => {
          if (event.key === "Enter") input.blur();
          if (event.key === "Escape") {
            input.value = String(props.value);
            input.blur();
          }
        }}
        onBlur={commit}
      />
      <span class="muted">{props.unit}</span>
    </label>
  );
}

/**
 * `agent.loop`'s web half: its settings, in General › Agent, read from its host half's row and written to it as the
 * Plugins page would. Each change restarts the loop, which suspends running turns and resumes them.
 */
export default defineWebPlugin({
  id: ID,
  styles,
  requires: { host: HostPlugins, notify: Notify, slots: Slots },
  setup: ({ host, notify, slots }) => {
    const maxSteps = configSetting<number>(host, notify, ID, "maxSteps");
    const maxRunning = configSetting<number>(host, notify, ID, "maxRunning");
    const keepCancelled = configSetting<boolean>(host, notify, ID, "keepCancelled");
    /** An entry while its plugin's row has the field. */
    const shown = <T,>(setting: ConfigSetting<T>, entry: SettingsEntry) => (setting.value() === undefined ? [] : [entry]);
    // Each row made once, so a change made in it (which `shown` reads) leaves it drawn, with focus where it was.
    const steps: SettingsEntry = {
      text: "Agent steps per turn max steps model calls limit",
      view: () => (
        <SettingRow title="Steps per turn" description="Model calls one turn may make before it stops to ask you to go on.">
          <Count label="Steps per turn" value={maxSteps.value() ?? 0} min={1} unit="steps" onChange={maxSteps.set} />
        </SettingRow>
      ),
    };
    const running: SettingsEntry = {
      text: "Agent turns at once concurrent parallel threads running max running",
      view: () => (
        <SettingRow title="Turns at once" description="Threads whose turns run together; another waits for one to end.">
          <Count label="Turns at once" value={maxRunning.value() ?? 0} min={1} unit="turns" onChange={maxRunning.set} />
        </SettingRow>
      ),
    };
    const keep: SettingsEntry = {
      text: "Agent keep stopped replies cancelled interrupted text context",
      view: () => (
        <SettingRow title="Keep stopped replies" description="When you stop a reply, what it had written stays in what the model reads next, as you read it.">
          <Toggle label="Keep stopped replies" checked={keepCancelled.value() ?? true} onChange={keepCancelled.set} />
        </SettingRow>
      ),
    };
    slots.add(SettingsGroups, {
      id: "agent.loop",
      order: 40,
      section: SectionIds.general,
      title: "Agent",
      entries: () => [...shown(maxSteps, steps), ...shown(maxRunning, running), ...shown(keepCancelled, keep)],
    });
  },
});
