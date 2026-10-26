import { Show, createSignal, createUniqueId } from "solid-js";
import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import type { ConfigSetting, SettingsEntry } from "@lemma/settings";
import { SettingRow, Toggle } from "@lemma/look";
import { HostPlugins, Notify, Slots, defineWebPlugin } from "@lemma/web";
import styles from "./web.css?inline";

const ID = "agent.loop";

/**
 * A whole number at least `min`, saved on Enter or on leaving the field. One that is not says so under the field while
 * it has the focus (Enter keeps it there), and leaving it goes back to what is set.
 */
function Count(props: { label: string; value: number; min: number; unit: string; onChange: (value: number) => void }) {
  let input!: HTMLInputElement;
  const hint = createUniqueId();
  const [invalid, setInvalid] = createSignal(false);
  const valid = () => input.value.trim() !== "" && Number.isInteger(Number(input.value)) && Number(input.value) >= props.min;
  const commit = () => {
    setInvalid(false);
    if (valid()) props.onChange(Number(input.value));
    else input.value = String(props.value);
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
        aria-invalid={invalid()}
        aria-describedby={invalid() ? hint : undefined}
        value={props.value}
        // A blank field is one being typed in: it says nothing until Enter.
        onInput={() => setInvalid(input.value.trim() !== "" && !valid())}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (valid()) input.blur();
            else setInvalid(true);
          }
          if (event.key === "Escape") {
            // Undoing an edit is all it does; with none, it closes what is open, as Escape does.
            if (input.value !== String(props.value)) {
              event.preventDefault();
              event.stopPropagation();
            }
            input.value = String(props.value);
            input.blur();
          }
        }}
        onBlur={commit}
      />
      <span class="muted">{props.unit}</span>
      <Show when={invalid()}>
        <span id={hint} class="agent-count-hint">
          A whole number, {props.min} or more
        </span>
      </Show>
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
