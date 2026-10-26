import { For, Show, createEffect, createMemo, createSignal, mapArray, onCleanup } from "solid-js";
import { bindingOf, formatKeys } from "@lemma/web/keys";
import { KEYMAP_PLUGIN, bindingRows, conflicts, defaultKeys, formatBindings, keysFor, labelOf, overridesFrom, withOverride, Actions } from "@lemma/actions";
import type { KeyOverrides, Action } from "@lemma/actions";
import { matchesQuery } from "@lemma/web/match";
import { SectionIds, Settings, SettingsGroups, SettingsSections } from "@lemma/settings";
import { Notify, Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import type { WebPluginsService, SlotItem, SlotsService } from "@lemma/web";
import { CommandIcon, PlusIcon, Popover, RefreshIcon, SearchField, SearchIcon, XIcon } from "@lemma/look";
import styles from "./keys-page.css?inline";

const SECTION = SectionIds.keyboard;
/** The page's group for actions in no category. */
const GENERAL = "General";

type Item = SlotItem<Action>;

/** A line's key, in the list and in `Deps.lines`: its action and its key, none for a line that gives it one. */
const lineOf = (id: string, key: string | undefined) => JSON.stringify([id, key ?? null]);
/** The page's + button, in `Deps.lines`. */
const ADD = "+";
/** Keys that, pressed alone, press what has focus: never a shortcut on their own. */
const NOT_SHORTCUTS = new Set(["enter", "space"]);

interface Deps {
  readonly slots: SlotsService;
  readonly webPlugins: WebPluginsService;
  readonly overrides: () => KeyOverrides;
  readonly save: (next: KeyOverrides) => Promise<void>;
  /** Every action's keys now, for finding conflicts. */
  readonly bound: () => readonly { readonly id: string; readonly keys: readonly string[] }[];
  /**
   * How to focus each line drawn (its key, or the button that gives it one), by `lineOf`, and the page's + (`ADD`): a
   * key recorded, removed, or reset draws lines anew, and focus goes to what takes their place.
   */
  readonly lines: Map<string, () => void>;
}

/** The same shortcuts, whatever order their actions came in. */
const sameOverrides = (a: KeyOverrides, b: KeyOverrides): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, keys]) => b[id]?.join("\n") === keys.join("\n"));

/** Sets an action's keys, dropping the override when they are its own again. */
const setKeys = (deps: Deps, action: Item, next: readonly string[] | undefined) =>
  void deps.save(withOverride(deps.overrides(), action.id, next, defaultKeys(action.keys)));

/** Once the list has drawn again, focuses the first of the action's lines for `keys` that is there, else the page's +. */
const focusLine = (deps: Deps, id: string, keys: readonly (string | undefined)[]) =>
  queueMicrotask(() => [...keys.map((key) => lineOf(id, key)), ADD].map((line) => deps.lines.get(line)).find((focus) => focus !== undefined)?.());

/**
 * Listens for one shortcut while focused: the first non-modifier press is it,
 * though not Enter or Space alone. Escape cancels (`refocus`, to put focus back
 * where recording started); focus leaving cancels too, as Tab does, which
 * moves it on.
 */
function Recorder(props: { onKeys: (binding: string) => void; onCancel: (refocus: boolean) => void }) {
  return (
    <span
      class="key-recorder"
      tabindex="0"
      role="textbox"
      aria-label="Press a shortcut"
      ref={(el) => queueMicrotask(() => el.focus())}
      onBlur={() => props.onCancel(false)}
      // Its own listener, not the document's delegated one: stopping it here keeps every key pressed in it, Tab too,
      // from the keymap and the settings' Escape, which listen on the document.
      on:keydown={(event) => {
        event.stopPropagation();
        // Tab, with Shift or without, moves focus on as it does anywhere; leaving cancels.
        if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) return;
        event.preventDefault();
        if (event.key === "Escape") return props.onCancel(true);
        const binding = bindingOf(event);
        if (binding !== undefined && !NOT_SHORTCUTS.has(binding)) props.onKeys(binding);
      }}
    >
      Press keys…
    </span>
  );
}

/** An action's name, with its category muted before it where nothing around it names that (`showCategory`). */
function ActionName(props: { action: Item; showCategory: boolean }) {
  return (
    <>
      <Show when={props.showCategory && props.action.category}>{(category) => <span class="shortcut-category">{category()}: </span>}</Show>
      {props.action.title}
    </>
  );
}

/**
 * One line of the list: an action and one of its keys, to change by pressing
 * new ones or to remove; without a key, a button to give it one. Reset puts
 * back the action's own keys once the user changed them. `showCategory` names
 * the action's category, where no heading above it does.
 */
function BindingLine(props: { deps: Deps; action: Item; binding: string | undefined; showCategory: boolean }) {
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
  let target: HTMLButtonElement | undefined;
  const line = lineOf(props.action.id, props.binding);
  const focus = () => target?.focus();
  deps.lines.set(line, focus);
  onCleanup(() => deps.lines.get(line) === focus && deps.lines.delete(line));
  const record = (binding: string) => {
    setRecording(false);
    const at = props.binding;
    setKeys(deps, props.action, at === undefined ? [...keys(), binding] : keys().map((key) => (key === at ? binding : key)));
    focusLine(deps, props.action.id, [binding]);
  };
  return (
    <div class="setting-row shortcut-row" classList={{ unbound: props.binding === undefined }}>
      <div class="setting-text">
        <div class="setting-title" data-tip={props.action.id}>
          <ActionName action={props.action} showCategory={props.showCategory} />
          <Show when={props.binding !== undefined && !defaults().includes(props.binding)}>
            <span class="shortcut-custom">custom</span>
          </Show>
        </div>
        <Show when={others().length > 0}>
          <div class="shortcut-conflict">Also used by {others().join(", ")}; the first one that applies runs.</div>
        </Show>
      </div>
      <div class="setting-control shortcut-keys">
        <Show
          when={!recording()}
          fallback={
            <Recorder
              onKeys={record}
              onCancel={(refocus) => {
                setRecording(false);
                if (refocus) focusLine(deps, props.action.id, [props.binding]);
              }}
            />
          }
        >
          <Show
            when={props.binding}
            fallback={
              <button ref={target} class="shortcut-assign" aria-label={`Add a shortcut for ${labelOf(props.action)}`} onClick={() => setRecording(true)}>
                <PlusIcon />
                Add shortcut
              </button>
            }
          >
            {(key) => (
              <button ref={target} class="shortcut-key" aria-label={`Change ${formatKeys(key())}`} data-tip="Change" onClick={() => setRecording(true)}>
                <kbd>{formatKeys(key())}</kbd>
              </button>
            )}
          </Show>
        </Show>
        {/* Shown on hover beside the key, so the keys stay against the edge; after it, so Tab and the settings search reach the key first. */}
        <span class="shortcut-tools">
          <Show when={customized()}>
            <button
              class="icon-button"
              aria-label={`Reset ${labelOf(props.action)}`}
              data-tip={defaults().length === 0 ? "Reset to none" : `Reset to ${defaults().map(formatKeys).join(", ")}`}
              onClick={() => {
                setKeys(deps, props.action, undefined);
                focusLine(deps, props.action.id, [props.binding, ...defaults(), undefined]);
              }}
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
                onClick={() => {
                  const rest = keys().filter((other) => other !== key());
                  setKeys(deps, props.action, rest);
                  focusLine(deps, props.action.id, [...rest, undefined]);
                }}
              >
                <XIcon />
              </button>
            )}
          </Show>
        </span>
      </div>
    </div>
  );
}

/**
 * A line for each of an action's keys, or one to give it a key: what the settings search shows for an action. The line
 * without a key is in the list (`null`), not `<For>`'s fallback, which draws again whenever the list does.
 */
function ActionLines(props: { deps: Deps; action: Item }) {
  const keys = () => {
    const keys = [...new Set(keysFor(props.action.id, props.action.keys, props.deps.overrides()))];
    return keys.length === 0 ? [null] : keys;
  };
  return <For each={keys()}>{(key) => <BindingLine deps={props.deps} action={props.action} binding={key ?? undefined} showCategory />}</For>;
}

/** The new binding's line at the top of the list: the action picked, waiting for its keys. */
function NewBinding(props: { deps: Deps; action: Item; onDone: () => void }) {
  const keys = () => keysFor(props.action.id, props.action.keys, props.deps.overrides());
  return (
    <div class="setting-row shortcut-row shortcut-new">
      <div class="setting-text">
        <div class="setting-title">
          <ActionName action={props.action} showCategory />
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
            focusLine(props.deps, props.action.id, [binding]);
          }}
          onCancel={(refocus) => {
            props.onDone();
            if (refocus) focusLine(props.deps, props.action.id, []);
          }}
        />
        {/* The pointer's way out (keys have Escape): Tab passes it by, on to the list, as leaving the recorder cancels. */}
        <button
          class="icon-button shortcut-cancel"
          aria-label="Cancel"
          data-tip="Cancel"
          tabindex="-1"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            props.onDone();
            focusLine(props.deps, props.action.id, []);
          }}
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
                    <ActionName action={action} showCategory />
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

/**
 * Every binding, a group per category (those in none first, under General), by action name within it; the search finds
 * actions without keys too, to give them one.
 */
function KeysBody(props: { deps: Deps }) {
  const { deps } = props;
  const [query, setQuery] = createSignal("");
  const [adding, setAdding] = createSignal<Item>();
  const keymapOn = () => deps.webPlugins.list().some((plugin) => plugin.id === KEYMAP_PLUGIN && plugin.state === "active");
  const actions = createMemo(() => new Map(deps.slots.list(Actions).map((action) => [action.id, action])));
  const rows = createMemo(() => bindingRows([...actions().values()], deps.overrides(), query(), formatKeys));
  // A line per row by its action and key, and a group by its category's name, so one being re-recorded survives the
  // list updating.
  const lines = createMemo(() => {
    const byCategory = new Map<string, string[]>();
    for (const row of rows()) {
      const category = row.action.category ?? GENERAL;
      byCategory.set(category, [...(byCategory.get(category) ?? []), lineOf(row.action.id, row.key)]);
    }
    return byCategory;
  });
  const categories = createMemo(() => [...lines().keys()].sort((a, b) => (a === GENERAL ? -1 : b === GENERAL ? 1 : a.localeCompare(b))));
  const bound = () => rows().filter((row) => row.key !== undefined).length;
  // What other plugins add to this section comes first: each group's entries in a memo of its own, as Settings asks
  // them (`SettingsGroup.entries`), and the search choosing among them, so neither another group's change nor a
  // keystroke draws again the rows that stay.
  const extras = createMemo(
    mapArray(
      () => deps.slots.list(SettingsGroups).filter((group) => group.section === SECTION && group.id !== SECTION),
      (group) => {
        const entries = createMemo(() => group.entries());
        return { group, shown: createMemo(() => entries().filter((entry) => matchesQuery(query(), entry.text))) };
      },
    ),
  );
  let page!: HTMLDivElement;
  const add = () => page.querySelector<HTMLElement>(".shortcut-add")?.focus();
  deps.lines.set(ADD, add);
  onCleanup(() => deps.lines.get(ADD) === add && deps.lines.delete(ADD));
  return (
    <div class="keys-page" ref={page}>
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
        {({ group, shown }) => (
          <Show when={shown().length > 0}>
            <section class="settings-group">
              <Show when={group.title}>{(title) => <h3 class="settings-group-title">{title()}</h3>}</Show>
              <div class="settings-rows">
                <For each={shown()}>{(entry) => entry.view()}</For>
              </div>
            </section>
          </Show>
        )}
      </For>
      <Show when={adding()} keyed>
        {(action) => (
          <div class="settings-rows">
            <NewBinding deps={deps} action={action} onDone={() => setAdding(undefined)} />
          </div>
        )}
      </Show>
      <For each={categories()} fallback={<p class="settings-empty">No commands or keys match “{query().trim()}”</p>}>
        {(category) => (
          <section class="settings-group">
            <h3 class="settings-group-title">{category}</h3>
            <div class="settings-rows">
              <For each={lines().get(category) ?? []}>
                {(line) => {
                  const [id, key] = JSON.parse(line) as [string, string | null];
                  return (
                    <Show when={actions().get(id)}>
                      {(action) => <BindingLine deps={deps} action={action()} binding={key ?? undefined} showCategory={false} />}
                    </Show>
                  );
                }}
              </For>
            </div>
          </section>
        )}
      </For>
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
export default defineWebPlugin({
  id: "actions.keys-page",
  styles,
  requires: { slots: Slots, settings: Settings, webPlugins: WebPlugins, notify: Notify },
  setup: ({ slots, settings, webPlugins, notify }, plugin) => {
    // What was just saved, shown until the plugin list catches up with it, so a line just focused is not drawn away.
    const [pending, setPending] = createSignal<KeyOverrides>();
    const saved = () => overridesFrom(webPlugins.list());
    const overrides = () => pending() ?? saved();
    createEffect(() => {
      const waiting = pending();
      if (waiting !== undefined && sameOverrides(waiting, saved())) setPending(undefined);
    });
    const save = async (next: KeyOverrides) => {
      const keymap = webPlugins.list().find((candidate) => candidate.id === KEYMAP_PLUGIN);
      if (keymap === undefined) {
        notify.toast({ level: "error", message: "The keymap plugin is not installed" });
        return;
      }
      setPending(next);
      try {
        await webPlugins.setConfig(keymap, { bindings: Object.keys(next).length === 0 ? null : formatBindings(next) });
      } catch (error) {
        // Not saved: what shows is what is there.
        setPending(undefined);
        notify.report(error, "Could not save the shortcut");
      }
    };
    const bound = () => slots.list(Actions).map((action) => ({ id: action.id, keys: keysFor(action.id, action.keys, overrides()) }));
    const deps: Deps = { slots, webPlugins, overrides, save, bound, lines: new Map() };

    slots.add(SettingsSections, {
      id: SECTION,
      order: 15,
      title: "Keyboard",
      icon: CommandIcon,
      description: "The keys for each command; a command's keys can be changed, or more added.",
      actions: () => (
        <Show when={Object.keys(overrides()).length > 0}>
          <button class="button small" onClick={plugin.action("reset keys", () => save({}))}>
            Reset all
          </button>
        </Show>
      ),
      body: () => <KeysBody deps={deps} />,
    });
    // Browsing shows the body; these answer the settings search. An entry per action for as long as it is there, its
    // text read anew as its keys change, so a key changed in the search's results keeps its row, and focus in it.
    const entries = createMemo(
      mapArray(
        () => slots.list(Actions),
        (action) => ({
          get text() {
            return `shortcut keybinding hotkey ${labelOf(action)} ${keysFor(action.id, action.keys, overrides()).map(formatKeys).join(" ")}`;
          },
          view: () => <ActionLines deps={deps} action={action} />,
        }),
      ),
    );
    slots.add(SettingsGroups, { id: SECTION, order: 10, section: SECTION, title: "Shortcuts", entries });
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
