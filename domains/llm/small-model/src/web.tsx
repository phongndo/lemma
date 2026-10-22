import { createMemo } from "solid-js";
import { chooseSmallModel, lowestThinking } from "@lemma/llm";
import type { ModelRef, ThinkingLevel } from "@lemma/llm";
import { Models, ModelPickerView, ThinkingPickerView } from "@lemma/llm/web";
import { SettingRow } from "@lemma/look";
import { configSetting, SectionIds, SettingsGroups } from "@lemma/settings";
import { Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import { Config } from "./config.ts";

/**
 * `llm.small-model`'s web half: its model and reasoning in Settings › General › Text generation models, written to its
 * row as the Plugins page would. Each shows what titles run on, for a thread on the composer's model: the model
 * chosen, or before one is, the fast model of that model's provider.
 */
export default defineWebPlugin({
  id: "llm.small-model",
  config: Config,
  requires: { models: Models, slots: Slots, webPlugins: WebPlugins, notify: Notify },
  setup: ({ models, slots, webPlugins, notify }, plugin) => {
    const model = configSetting<ModelRef | undefined>(webPlugins, notify, plugin.id, "model");
    const thinking = configSetting<ThinkingLevel | undefined>(webPlugins, notify, plugin.id, "thinking");
    /** What a thread on the composer's model gets its title from now, as the host chooses it: the model, and its level. */
    const choice = createMemo(() => chooseSmallModel(models.models(), { model: model.value(), thinking: thinking.value() }, models.selected()?.ref));
    /** A level, kept: the least the model offers is none, which stays the least of whichever model titles run on. */
    const chooseLevel = (level: ThinkingLevel) => thinking.set(level === lowestThinking(choice()?.model) ? undefined : level);
    plugin.onCleanup(
      slots.add(SettingsGroups, {
        id: "small-model",
        order: 30,
        section: SectionIds.general,
        title: "Text generation models",
        entries: () => [
          {
            text: "Text generation models thread titles name generate reasoning thinking effort level",
            view: () => (
              <SettingRow
                title="Model"
                description="Writes each thread's title. Until you pick one, a fast model of the thread's provider, such as Claude Haiku or Gemini Flash-Lite."
              >
                <ModelPickerView value={choice()?.model.ref} choose={model.set} />
                {/* The levels of the model it runs on, none for one that offers no choice. */}
                <ThinkingPickerView model={choice()?.model.ref} value={choice()?.thinking} choose={chooseLevel} />
              </SettingRow>
            ),
          },
        ],
      }),
    );
  },
});
