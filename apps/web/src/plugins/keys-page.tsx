import { For, Show, createMemo, createSignal } from "solid-js";
import { bindingOf, formatKeys } from "../lib/keys.ts";
import { KEYMAP_PLUGIN, conflicts, defaultKeys, formatBindings, keysFor, overridesFrom, withOverride } from "../model/keybindings.ts";
import type { KeyOverrides } from "../model/keybindings.ts";
import { matchesQuery } from "../model/palette.ts";
import { Actions, Notify, Settings, SettingsGroups, SettingsSections, Slots, UiPlugins } from "../ui/contracts.ts";
import type { Action, NotifyService, UiPluginsService } from "../ui/contracts.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { CommandIcon, PlusIcon, RefreshIcon, SearchField, Segmented, SettingRow, XIcon } from "../ui/parts.tsx";
import styles from "./keys-page.css?inline";

const SECTION = "keyboard";
const COMPOSER_PLUGIN = "composer";

type Item = SlotItem<Action>;

interface Deps {
  readonly slots: SlotsService;
  readonly uiPlugins: UiPluginsService;
  readonly notify: NotifyService;
  readonly overrides: () => KeyOverrides;
  readonly save: (next: KeyOverrides) => Promise<void>;
  /** Every action's keys now, for finding conflicts. */
  readonly bound: () => readonly { readonly id: string; readonly keys: readonly string[] }[];
}

const titleOf = (action: Item) => (action.category === undefined ? action.title : `${action.category}: ${action.title}`);

/**
 * Listens for one shortcut while focused: the first non-modifier press is it.
 * Escape cancels; focus leaving cancels too.
 */
function Recorder(props: { onKeys: (binding: string) => void; onCancel: () => void }) {
  return (
    <span
      class="key-recorder"
      tabindex="0"
      role="textbox"
      aria-label="Press a shortcut"
      ref={(el) => queueMicrotask(() => el.focus())}
      onBlur={() => props.onCancel()}
      onKeyDown={(event) => {
        // Nothing else (the keymap, the settings' Escape) sees keys pressed here.
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") return props.onCancel();
        const binding = bindingOf(event);
        if (binding !== undefined) props.onKeys(binding);
      }}
    >
      Press keys…
    </span>
  );
}

/** One action: its keys as chips to replace or remove, a button to add one, and a reset when changed. */
function ShortcutRow(props: { deps: Deps; action: Item }) {
  const { deps } = props;
  const defaults = () => defaultKeys(props.action.keys);
  const keys = () => keysFor(props.action.id, props.action.keys, deps.overrides());
  const customized = () => deps.overrides()[props.action.id] !== undefined;
  // The binding being replaced (its index), "new" for one being added, or nothing.
  const [recording, setRecording] = createSignal<number | "new">();
  // Built-in shortcuts may share a key on purpose (Escape closes whatever is open); a clash only counts when the user made it.
  const others = createMemo(() => {
    const shared = conflicts(deps.bound());
    const userSet = (id: string, key: string) => deps.overrides()[id]?.includes(key) ?? false;
    const names = new Set<string>();
    for (const key of keys()) {
      for (const id of shared.get(key) ?? []) {
        if (id === props.action.id || !(userSet(props.action.id, key) || userSet(id, key))) continue;
        const other = deps.slots.list(Actions).find((action) => action.id === id);
        if (other !== undefined) names.add(titleOf(other));
      }
    }
    return [...names];
  });
  const change = (next: readonly string[] | undefined) => void deps.save(withOverride(deps.overrides(), props.action.id, next, defaults()));
  const record = (binding: string) => {
    const at = recording();
    setRecording(undefined);
    change(at === "new" || at === undefined ? [...keys(), binding] : keys().map((key, i) => (i === at ? binding : key)));
  };
  return (
    <div class="setting-row shortcut-row">
      <div class="setting-text">
        <div class="setting-title">{props.action.title}</div>
        <Show when={props.action.detail}>
          <div class="setting-desc">{props.action.detail}</div>
        </Show>
        <Show when={others().length > 0}>
          <div class="shortcut-conflict">Also used by {others().join(", ")}; the first one that applies runs.</div>
        </Show>
      </div>
      <div class="setting-control shortcut-keys">
        <For each={keys()}>
          {(key, i) => (
            <Show when={recording() !== i()} fallback={<Recorder onKeys={record} onCancel={() => setRecording(undefined)} />}>
              <span class="shortcut-chip">
                <button class="shortcut-key" data-tip="Change" onClick={() => setRecording(i())}>
                  <kbd>{formatKeys(key)}</kbd>
                </button>
                <button
                  class="icon-button shortcut-remove"
                  aria-label={`Remove ${formatKeys(key)}`}
                  data-tip="Remove"
                  onClick={() => change(keys().filter((_, j) => j !== i()))}
                >
                  <XIcon />
                </button>
              </span>
            </Show>
          )}
        </For>
        <Show
          when={recording() === "new"}
          fallback={
            <button
              class="icon-button shortcut-add"
              aria-label={`Add a shortcut for ${props.action.title}`}
              data-tip="Add shortcut"
              onClick={() => setRecording("new")}
            >
              <PlusIcon />
            </button>
          }
        >
          <Recorder onKeys={record} onCancel={() => setRecording(undefined)} />
        </Show>
        <button
          class="icon-button shortcut-reset"
          classList={{ hidden: !customized() }}
          aria-label={`Reset ${props.action.title}`}
          data-tip={defaults().length === 0 ? "Reset to none" : `Reset to ${defaults().map(formatKeys).join(", ")}`}
          disabled={!customized()}
          onClick={() => change(undefined)}
        >
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}

/** How the composer sends: a setting of the composer plugin, shown with the keys it is about. */
function SendRow(props: { deps: Deps }) {
  const composer = () => props.deps.uiPlugins.list().find((plugin) => plugin.id === COMPOSER_PLUGIN);
  const value = () => (composer()?.config?.values.send === "mod+enter" ? "mod+enter" : "enter");
  return (
    <Show when={composer()}>
      {(plugin) => (
        <SettingRow title="Send a message" description="The other one starts a new line, as does Shift+Enter.">
          <Segmented
            label="Send a message with"
            value={value()}
            options={[
              { value: "enter", label: formatKeys("enter") },
              { value: "mod+enter", label: formatKeys("mod+enter") },
            ]}
            onChange={(next) =>
              void props.deps.uiPlugins
                .setConfig(plugin(), { send: next === "enter" ? null : next })
                .catch((error) => props.deps.notify.report(error, "Could not change the send key"))
            }
          />
        </SettingRow>
      )}
    </Show>
  );
}

/** Every action by category, filtered by a search over titles and keys. */
function KeysBody(props: { deps: Deps }) {
  const [query, setQuery] = createSignal("");
  const keymapOn = () => props.deps.uiPlugins.list().some((plugin) => plugin.id === KEYMAP_PLUGIN && plugin.state === "active");
  const groups = createMemo(() => {
    const byCategory = new Map<string, Item[]>();
    for (const action of props.deps.slots.list(Actions)) {
      const keys = keysFor(action.id, action.keys, props.deps.overrides());
      if (!matchesQuery(query(), `${titleOf(action)} ${action.keywords?.join(" ") ?? ""} ${keys.map(formatKeys).join(" ")} ${keys.join(" ")}`)) continue;
      const category = action.category ?? "General";
      byCategory.set(category, [...(byCategory.get(category) ?? []), action]);
    }
    return [...byCategory.entries()];
  });
  return (
    <div class="keys-page">
      <SearchField value={query()} onInput={setQuery} placeholder="Search shortcuts by name or keys" label="Search shortcuts" />
      <Show when={!keymapOn()}>
        <p class="callout">The keymap plugin is off, so shortcuts do nothing until it is back on (Settings › Plugins).</p>
      </Show>
      <Show when={query().trim() === ""}>
        <section class="settings-group">
          <h3 class="settings-group-title">Composer</h3>
          <div class="settings-rows">
            <SendRow deps={props.deps} />
          </div>
        </section>
      </Show>
      <For each={groups()} fallback={<p class="settings-empty">No shortcuts match “{query().trim()}”</p>}>
        {([category, actions]) => (
          <section class="settings-group">
            <h3 class="settings-group-title">{category}</h3>
            <div class="settings-rows">
              <For each={actions}>{(action) => <ShortcutRow deps={props.deps} action={action} />}</For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

/**
 * Settings › Keyboard: every action's shortcuts, recorded by pressing them, and how
 * the composer sends. Shortcuts are the keymap plugin's `bindings` config, so they live in
 * config.jsonc; this page writes them without depending on that plugin, so it stays put while
 * the keymap restarts with them.
 */
export default defineUiPlugin({
  id: "keys-page",
  styles,
  requires: { slots: Slots, settings: Settings, uiPlugins: UiPlugins, notify: Notify },
  setup: ({ slots, settings, uiPlugins, notify }) => {
    // What was just saved, shown until the plugin list catches up with it.
    const [pending, setPending] = createSignal<KeyOverrides>();
    const overrides = () => pending() ?? overridesFrom(uiPlugins.list());
    const save = async (next: KeyOverrides) => {
      const keymap = uiPlugins.list().find((candidate) => candidate.id === KEYMAP_PLUGIN);
      if (keymap === undefined) {
        notify.toast({ level: "error", message: "The keymap plugin is not installed" });
        return;
      }
      setPending(next);
      try {
        await uiPlugins.setConfig(keymap, { bindings: Object.keys(next).length === 0 ? null : formatBindings(next) });
      } catch (error) {
        notify.report(error, "Could not save the shortcut");
      } finally {
        setPending(undefined);
      }
    };
    const bound = () => slots.list(Actions).map((action) => ({ id: action.id, keys: keysFor(action.id, action.keys, overrides()) }));
    const deps: Deps = { slots, uiPlugins, notify, overrides, save, bound };

    slots.add(SettingsSections, {
      id: SECTION,
      order: 15,
      title: "Keyboard",
      icon: CommandIcon,
      actions: () => (
        <Show when={Object.keys(overrides()).length > 0}>
          <button class="button small" onClick={() => void save({})}>
            Reset all
          </button>
        </Show>
      ),
      body: () => <KeysBody deps={deps} />,
    });
    // Browsing shows the body; these answer the settings search.
    slots.add(SettingsGroups, {
      id: SECTION,
      section: SECTION,
      title: "Shortcuts",
      entries: () =>
        slots.list(Actions).map((action) => ({
          text: `shortcut keybinding hotkey ${titleOf(action)} ${keysFor(action.id, action.keys, overrides()).map(formatKeys).join(" ")}`,
          view: () => <ShortcutRow deps={deps} action={action} />,
        })),
    });
    slots.add(Actions, {
      id: "keys-page.open",
      order: 12,
      title: "Keyboard shortcuts",
      category: "Settings",
      keywords: ["hotkeys", "keybindings", "keys"],
      icon: CommandIcon,
      keys: "mod+/",
      run: () => settings.open(SECTION),
    });
  },
});
