import { For, Show, createMemo, createSignal } from "solid-js";
import { bindingOf, formatKeys } from "../lib/keys.ts";
import { KEYMAP_PLUGIN, bindingRows, conflicts, defaultKeys, formatBindings, keysFor, labelOf, overridesFrom, withOverride } from "../model/keybindings.ts";
import type { KeyOverrides } from "../model/keybindings.ts";
import { matchesQuery } from "../model/palette.ts";
import { Actions, Notify, SectionIds, Settings, SettingsGroups, SettingsSections, Slots, UiPlugins } from "../ui/contracts.ts";
import type { Action, UiPluginsService } from "../ui/contracts.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { CommandIcon, PlusIcon, Popover, RefreshIcon, SearchField, SearchIcon, XIcon } from "../ui/parts.tsx";
import styles from "./keys-page.css?inline";

const SECTION = SectionIds.keyboard;

type Item = SlotItem<Action>;

interface Deps {
  readonly slots: SlotsService;
  readonly uiPlugins: UiPluginsService;
  readonly overrides: () => KeyOverrides;
  readonly save: (next: KeyOverrides) => Promise<void>;
  /** Every action's keys now, for finding conflicts. */
  readonly bound: () => readonly { readonly id: string; readonly keys: readonly string[] }[];
}

/** Sets an action's keys, dropping the override when they are its own again. */
const setKeys = (deps: Deps, action: Item, next: readonly string[] | undefined) =>
  void deps.save(withOverride(deps.overrides(), action.id, next, defaultKeys(action.keys)));

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

/** An action's name, its category muted before it. */
function ActionName(props: { action: Item }) {
  return (
    <>
      <Show when={props.action.category}>{(category) => <span class="shortcut-category">{category()}: </span>}</Show>
      {props.action.title}
    </>
  );
}

/**
 * One line of the list: an action and one of its keys, to change by pressing
 * new ones or to remove; without a key, a button to give it one. Reset puts
 * back the action's own keys once the user changed them.
 */
function BindingLine(props: { deps: Deps; action: Item; binding: string | undefined }) {
  const { deps } = props;
  const keys = () => keysFor(props.action.id, props.action.keys, deps.overrides());
  const defaults = () => defaultKeys(props.action.keys);
  const customized = () => deps.overrides()[props.action.id] !== undefined;
  const [recording, setRecording] = createSignal(false);
  // Built-in shortcuts may share a key on purpose (Escape closes whatever is open); a clash only counts when the user made it.
  const others = createMemo(() => {
    const key = props.binding;
    if (key === undefined) return [];
    const users = (conflicts(deps.bound()).get(key) ?? []).flatMap((id) => deps.slots.list(Actions).find((action) => action.id === id) ?? []);
    // The user set it on an action when it is not one of that action's own keys.
    const userSet = (action: Item) => !defaultKeys(action.keys).includes(key);
    return users.filter((other) => other.id !== props.action.id && (userSet(props.action) || userSet(other))).map(labelOf);
  });
  const record = (binding: string) => {
    setRecording(false);
    const at = props.binding;
    setKeys(deps, props.action, at === undefined ? [...keys(), binding] : keys().map((key) => (key === at ? binding : key)));
  };
  return (
    <div class="setting-row shortcut-row" classList={{ unbound: props.binding === undefined }}>
      <div class="setting-text">
        <div class="setting-title" data-tip={props.action.id}>
          <ActionName action={props.action} />
          <Show when={props.binding !== undefined && !defaults().includes(props.binding)}>
            <span class="shortcut-custom">custom</span>
          </Show>
        </div>
        <Show when={others().length > 0}>
          <div class="shortcut-conflict">Also used by {others().join(", ")}; the first one that applies runs.</div>
        </Show>
      </div>
      <div class="setting-control shortcut-keys">
        {/* Shown on hover beside the key, so the keys stay against the edge. */}
        <span class="shortcut-tools">
          <Show when={customized()}>
            <button
              class="icon-button"
              aria-label={`Reset ${labelOf(props.action)}`}
              data-tip={defaults().length === 0 ? "Reset to none" : `Reset to ${defaults().map(formatKeys).join(", ")}`}
              onClick={() => setKeys(deps, props.action, undefined)}
            >
              <RefreshIcon />
            </button>
          </Show>
          <Show when={!recording() && props.binding}>
            {(key) => (
              <button
                class="icon-button"
                aria-label={`Remove ${formatKeys(key())} from ${labelOf(props.action)}`}
                data-tip="Remove"
                onClick={() =>
                  setKeys(
                    deps,
                    props.action,
                    keys().filter((other) => other !== key()),
                  )
                }
              >
                <XIcon />
              </button>
            )}
          </Show>
        </span>
        <Show when={!recording()} fallback={<Recorder onKeys={record} onCancel={() => setRecording(false)} />}>
          <Show
            when={props.binding}
            fallback={
              <button class="shortcut-assign" aria-label={`Add a shortcut for ${labelOf(props.action)}`} onClick={() => setRecording(true)}>
                <PlusIcon />
                Add shortcut
              </button>
            }
          >
            {(key) => (
              <button class="shortcut-key" aria-label={`Change ${formatKeys(key())}`} data-tip="Change" onClick={() => setRecording(true)}>
                <kbd>{formatKeys(key())}</kbd>
              </button>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

/** A line for each of an action's keys, or one to give it a key: what the settings search shows for an action. */
function ActionLines(props: { deps: Deps; action: Item }) {
  const keys = () => [...new Set(keysFor(props.action.id, props.action.keys, props.deps.overrides()))];
  return (
    <For each={keys()} fallback={<BindingLine deps={props.deps} action={props.action} binding={undefined} />}>
      {(key) => <BindingLine deps={props.deps} action={props.action} binding={key} />}
    </For>
  );
}

/** The new binding's line at the top of the list: the action picked, waiting for its keys. */
function NewBinding(props: { deps: Deps; action: Item; onDone: () => void }) {
  const keys = () => keysFor(props.action.id, props.action.keys, props.deps.overrides());
  return (
    <div class="setting-row shortcut-row shortcut-new">
      <div class="setting-text">
        <div class="setting-title">
          <ActionName action={props.action} />
        </div>
        <Show when={keys().length > 0}>
          <div class="setting-desc">Adds to {keys().map(formatKeys).join(", ")}</div>
        </Show>
      </div>
      <div class="setting-control shortcut-keys">
        <Recorder
          onKeys={(binding) => {
            props.onDone();
            setKeys(props.deps, props.action, [...keys(), binding]);
          }}
          onCancel={props.onDone}
        />
        <button
          class="icon-button shortcut-cancel"
          aria-label="Cancel"
          data-tip="Cancel"
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onDone}
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

/** The + button: every action, searchable, to pick one to bind. */
function AddBinding(props: { deps: Deps; onPick: (action: Item) => void }) {
  const [query, setQuery] = createSignal("");
  const choices = createMemo(() =>
    props.deps.slots
      .list(Actions)
      .filter((action) => matchesQuery(query(), `${labelOf(action)} ${action.keywords?.join(" ") ?? ""} ${action.id}`))
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
  );
  return (
    <Popover
      label="Add shortcut"
      triggerClass="icon-button shortcut-add"
      placement="bottom-end"
      menuClass="shortcut-menu"
      onOpen={() => setQuery("")}
      trigger={<PlusIcon />}
    >
      {(close) => (
        <>
          <label class="shortcut-search">
            <SearchIcon />
            <input
              placeholder="Search commands"
              aria-label="Search commands"
              autocomplete="off"
              spellcheck={false}
              data-autofocus
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div class="shortcut-choices" role="listbox">
            <For each={choices()} fallback={<div class="picker-empty">No commands match</div>}>
              {(action) => (
                <button
                  class="menu-item"
                  role="option"
                  onClick={() => {
                    close();
                    props.onPick(action);
                  }}
                >
                  <span class="menu-label">
                    <ActionName action={action} />
                  </span>
                  <span class="menu-hint">{keysFor(action.id, action.keys, props.deps.overrides()).map(formatKeys).join(" ")}</span>
                </button>
              )}
            </For>
          </div>
        </>
      )}
    </Popover>
  );
}

/** One continuous list of every binding, by action name; the search finds actions without keys too, to give them one. */
function KeysBody(props: { deps: Deps }) {
  const { deps } = props;
  const [query, setQuery] = createSignal("");
  const [adding, setAdding] = createSignal<Item>();
  const keymapOn = () => deps.uiPlugins.list().some((plugin) => plugin.id === KEYMAP_PLUGIN && plugin.state === "active");
  const actions = createMemo(() => new Map(deps.slots.list(Actions).map((action) => [action.id, action])));
  const rows = createMemo(() => bindingRows([...actions().values()], deps.overrides(), query(), formatKeys));
  // A line per row by its action and key, so one being re-recorded survives the list updating.
  const lines = createMemo(() => rows().map((row) => JSON.stringify([row.action.id, row.key ?? null])));
  const bound = () => rows().filter((row) => row.key !== undefined).length;
  // What other plugins add to this section (the composer's send key) comes first.
  const extras = createMemo(() =>
    deps.slots
      .list(SettingsGroups)
      .filter((group) => group.section === SECTION && group.id !== SECTION)
      .map((group) => ({ group, entries: group.entries().filter((entry) => matchesQuery(query(), entry.text)) }))
      .filter(({ entries }) => entries.length > 0),
  );
  return (
    <div class="keys-page">
      <SearchField value={query()} onInput={setQuery} placeholder="Search by command or keys" label="Search shortcuts">
        <span class="shortcut-count">
          {bound()} {bound() === 1 ? "shortcut" : "shortcuts"}
        </span>
        <AddBinding deps={deps} onPick={setAdding} />
      </SearchField>
      <Show when={!keymapOn()}>
        <p class="callout">The keymap plugin is off, so shortcuts do nothing until it is back on (Settings › Plugins).</p>
      </Show>
      <For each={extras()}>
        {({ group, entries }) => (
          <section class="settings-group">
            <Show when={group.title}>{(title) => <h3 class="settings-group-title">{title()}</h3>}</Show>
            <div class="settings-rows">
              <For each={entries}>{(entry) => entry.view()}</For>
            </div>
          </section>
        )}
      </For>
      <section class="settings-group">
        <h3 class="settings-group-title">Shortcuts</h3>
        <div class="settings-rows shortcut-list">
          <Show when={adding()} keyed>
            {(action) => <NewBinding deps={deps} action={action} onDone={() => setAdding(undefined)} />}
          </Show>
          <For each={lines()} fallback={<p class="settings-empty">No commands or keys match “{query().trim()}”</p>}>
            {(line) => {
              const [id, key] = JSON.parse(line) as [string, string | null];
              return <Show when={actions().get(id)}>{(action) => <BindingLine deps={deps} action={action()} binding={key ?? undefined} />}</Show>;
            }}
          </For>
        </div>
      </section>
    </div>
  );
}

/**
 * Settings › Keyboard: every shortcut in one list, recorded by pressing it, a
 * + to bind any action, and how the composer sends. Shortcuts are the keymap
 * plugin's `bindings` config, so they live in config.jsonc; this page writes
 * them without depending on that plugin, so it stays put while the keymap
 * restarts with them.
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
    const deps: Deps = { slots, uiPlugins, overrides, save, bound };

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
          text: `shortcut keybinding hotkey ${labelOf(action)} ${keysFor(action.id, action.keys, overrides()).map(formatKeys).join(" ")}`,
          view: () => <ActionLines deps={deps} action={action} />,
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
