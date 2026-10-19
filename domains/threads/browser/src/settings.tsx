import { For, Show, createSignal } from "solid-js";
import { SectionIds, SettingsGroups, configSetting } from "@lemma/settings";
import { SettingRow } from "@lemma/look";
import type { NotifyService, PluginsService, SlotsService } from "@lemma/web";
import { ENGINES, SEARCH } from "./address.ts";

const CUSTOM = "\0custom";

/** Where the address bar sends a search: an engine by name, or an address of one's own. */
function SearchSetting(props: { value: string; onChange: (url: string) => void }) {
  const [writing, setWriting] = createSignal(false);
  const selected = () => (writing() || !ENGINES.some((engine) => engine.url === props.value) ? CUSTOM : props.value);
  let input: HTMLInputElement | undefined;
  return (
    <SettingRow title="Search engine" description="Where the browser's address bar sends what is not an address.">
      <div class="browser-search-setting">
        <select
          class="field"
          aria-label="Search engine"
          onChange={(event) => {
            const next = event.currentTarget.value;
            setWriting(next === CUSTOM);
            if (next === CUSTOM) queueMicrotask(() => input?.focus());
            else props.onChange(next);
          }}
        >
          <For each={ENGINES}>
            {(engine) => (
              <option value={engine.url} selected={selected() === engine.url}>
                {engine.title}
              </option>
            )}
          </For>
          <option value={CUSTOM} selected={selected() === CUSTOM}>
            Custom…
          </option>
        </select>
        <Show when={selected() === CUSTOM}>
          <input
            ref={input}
            class="field"
            aria-label="Search address: %s is what was typed"
            spellcheck={false}
            placeholder="https://example.com/search?q=%s"
            value={ENGINES.some((engine) => engine.url === props.value) ? "" : props.value}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              setWriting(false);
              const url = event.currentTarget.value.trim();
              if (url !== "") props.onChange(url);
            }}
          />
        </Show>
      </div>
    </SettingRow>
  );
}

/** Its search engine, in General: its own config, written as the Plugins page would. */
export const addSettings = (slots: SlotsService, webPlugins: PluginsService, notify: NotifyService, id: string, config: () => string) => {
  const search = configSetting<string>(webPlugins, notify, id, "search");
  slots.add(SettingsGroups, {
    id: "browser.settings",
    order: 60,
    section: SectionIds.general,
    title: "Browser",
    entries: () => [
      {
        text: `Browser search engine address bar web ${ENGINES.map((engine) => engine.title).join(" ")}`,
        view: () => <SearchSetting value={search.value() ?? config() ?? SEARCH} onChange={search.set} />,
      },
    ],
  });
};
