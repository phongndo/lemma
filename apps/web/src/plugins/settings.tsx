import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { withKeys } from "../lib/keys.ts";
import { shownKeys } from "../model/keybindings.ts";
import { filterGroups } from "../model/settings.ts";
import type { EntryGroup } from "../model/settings.ts";
import {
  Actions,
  NewThreadRoute,
  Pages,
  Router,
  SectionIds,
  Settings,
  SettingsGroups,
  SettingsRoute,
  SettingsSections,
  SidebarFooter,
  Slots,
  UiPlugins,
} from "../ui/contracts.ts";
import type { SettingsEntry, SettingsSection } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";
import { ArrowLeftIcon, Contained, GearIcon, SearchIcon, SlidersIcon, XIcon } from "../ui/parts.tsx";
import styles from "./settings.css?inline";

type Section = SlotItem<SettingsSection>;

/** A section's groups from every plugin, in order; groups with the same title merge. */
const groupsOf = (slots: SlotsService, section: string): EntryGroup<SettingsEntry>[] => {
  const merged: { title?: string; entries: SettingsEntry[] }[] = [];
  for (const group of slots.list(SettingsGroups)) {
    if (group.section !== section) continue;
    const same = merged.find((candidate) => candidate.title === group.title);
    if (same === undefined) merged.push({ ...(group.title === undefined ? {} : { title: group.title }), entries: [...group.entries()] });
    else same.entries.push(...group.entries());
  }
  return merged.filter((group) => group.entries.length > 0);
};

function SettingsView(props: {
  slots: SlotsService;
  section: () => string;
  /** Changes on every `open`, even of the open section: the search clears, so a result that navigates lands there. */
  visits: () => number;
  open: (section: string | undefined) => void;
  setFocus: (focus: (() => void) | undefined) => void;
  /** The binding that closes settings, as the user has it. */
  closeKeys: () => string | undefined;
}) {
  const { slots } = props;
  const [query, setQuery] = createSignal("");
  const searching = () => query().trim() !== "";
  const sections = () => slots.list(SettingsSections);
  let main!: HTMLDivElement;
  let search!: HTMLInputElement;
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => queueMicrotask(() => search.focus()));
  props.setFocus(() => {
    search.focus();
    search.select();
  });
  onCleanup(() => {
    props.setFocus(undefined);
    previous?.focus?.();
  });
  createEffect(on([props.section, searching], () => main.scrollTo({ top: 0 }), { defer: true }));
  createEffect(on(props.visits, () => setQuery(""), { defer: true }));

  const current = (): Section | undefined => sections().find((candidate) => candidate.id === props.section()) ?? sections()[0];
  const groups = createMemo(() => {
    const section = current();
    return section === undefined ? [] : groupsOf(slots, section.id);
  });
  const results = createMemo(() =>
    searching()
      ? sections()
          .map((section) => ({ section, groups: filterGroups(groupsOf(slots, section.id), query()) }))
          .filter((found) => found.groups.length > 0)
      : [],
  );
  const count = (id: string) =>
    results()
      .find((found) => found.section.id === id)
      ?.groups.reduce((sum, group) => sum + group.entries.length, 0) ?? 0;
  const go = (id: string) => {
    setQuery("");
    props.open(id);
  };

  return (
    <div class="settings" role="region" aria-label="Settings">
      <nav class="settings-nav" aria-label="Settings sections">
        <label class="search-box">
          <SearchIcon />
          <input
            ref={search}
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query() !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          <Show when={query() === ""}>
            <span class="search-key" data-tip="Press / to search">
              /
            </span>
          </Show>
          <Show when={query() !== ""}>
            <button class="icon-button search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <XIcon />
            </button>
          </Show>
        </label>
        <div class="settings-nav-items">
          <For each={sections()}>
            {(item) => (
              <button
                class="settings-nav-item"
                classList={{ active: !searching() && current()?.id === item.id, dim: searching() && count(item.id) === 0 }}
                aria-current={!searching() && current()?.id === item.id ? "page" : undefined}
                onClick={() => go(item.id)}
              >
                <Contained slot={SettingsSections} item={item} component={item.icon} />
                <span class="settings-nav-label">{item.title}</span>
                <Show when={searching() && count(item.id) > 0}>
                  <span class="settings-nav-count">{count(item.id)}</span>
                </Show>
                <Show when={!searching() && item.badge?.()}>{(badge) => <span class="settings-nav-count err">{badge()}</span>}</Show>
              </button>
            )}
          </For>
        </div>
        <span class="spacer" />
        <button class="settings-nav-item" onClick={() => props.open(undefined)} data-tip={withKeys("Back to chats", props.closeKeys())}>
          <ArrowLeftIcon />
          <span class="settings-nav-label">Back</span>
        </button>
      </nav>
      <div class="settings-main" ref={main}>
        <header class="settings-head">
          <span class="muted">Settings</span>
          <span class="settings-crumb-sep">/</span>
          <span>{searching() ? "Search" : current()?.title}</span>
          <span class="spacer" />
          <Show when={!searching() && current()?.actions !== undefined && current()} keyed>
            {(section) => <Contained slot={SettingsSections} item={section} component={section.actions} />}
          </Show>
          <button class="icon-button" aria-label="Close settings" data-tip={withKeys("Close", props.closeKeys())} onClick={() => props.open(undefined)}>
            <XIcon />
          </button>
        </header>
        <div class="settings-content" classList={{ wide: !searching() && current()?.body !== undefined }}>
          <Show
            when={searching()}
            fallback={
              <Show when={current()}>
                {(section) => (
                  <>
                    <Show when={section().intro}>{(intro) => <Contained slot={SettingsSections} item={section()} component={intro()} />}</Show>
                    <Show
                      when={section().body}
                      keyed
                      fallback={
                        <Show
                          when={groups().some((group) => group.entries.length > 0)}
                          fallback={<Show when={section().empty}>{(empty) => <Contained slot={SettingsSections} item={section()} component={empty()} />}</Show>}
                        >
                          <Groups groups={groups()} />
                        </Show>
                      }
                    >
                      {(body) => <Contained slot={SettingsSections} item={section()} component={body} />}
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            <Show when={results().length > 0} fallback={<p class="settings-empty">No settings match “{query().trim()}”</p>}>
              <For each={results()}>
                {(found) => (
                  <section class="settings-result">
                    <button class="settings-result-title" onClick={() => go(found.section.id)} data-tip={`Open ${found.section.title}`}>
                      <Contained slot={SettingsSections} item={found.section} component={found.section.icon} />
                      {found.section.title}
                    </button>
                    <Groups groups={found.groups} />
                  </section>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function Groups(props: { groups: readonly EntryGroup<SettingsEntry>[] }) {
  return (
    <For each={props.groups}>
      {(group) => (
        <section class="settings-group">
          <Show when={group.title}>
            <h2 class="settings-group-title">{group.title}</h2>
          </Show>
          <div class="settings-rows">
            <For each={group.entries}>{(entry) => entry.view()}</For>
          </div>
        </section>
      )}
    </For>
  );
}

/**
 * Settings, a page covering the app: `/settings/<section>`, with the
 * section's own state in the search (`?plugin=agent&tab=faults`). Plugins add
 * sections and the entries in them; the search runs across every section,
 * and clearing it returns to the section being browsed. Closing returns to
 * where settings were opened from.
 */
export default defineUiPlugin({
  id: "settings",
  styles,
  requires: { slots: Slots, router: Router, uiPlugins: UiPlugins },
  provides: { settings: Settings },
  setup: ({ slots, router, uiPlugins }) => {
    const [visits, setVisits] = createSignal(0);
    const [focus, setFocus] = createSignal<() => void>();
    const here = () => router.matchOf(SettingsRoute);
    const section = createMemo(() => {
      const found = here();
      return found === undefined ? undefined : (found.params.section ?? SectionIds.general);
    });
    const params = createMemo(() => here()?.search ?? {}, undefined, {
      equals: (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value),
    });
    /** Each section's state as last left, so opening it again returns there. */
    const left = new Map<string, Readonly<Record<string, string>>>();
    createEffect(() => {
      const open = section();
      if (open !== undefined) left.set(open, params());
    });
    /**
     * The last place outside settings: where closing them returns. Each
     * settings entry keeps it with itself, so a reload, or back and forward
     * into settings, still knows the way out.
     */
    type Outside = { readonly href: string; readonly index: number };
    let outside: Outside | undefined;
    const way = () => router.entry<Outside>("settings.return");
    createEffect(() => {
      const location = router.location();
      if (section() === undefined) outside = { href: location.href, index: location.index };
      // After a reload into settings only the entry knows the way out; the entries opened next keep it too.
      else if (outside === undefined) outside = way().get();
      else if (way().get() === undefined) way().set(outside);
    });

    const open = (next: string | undefined, nextParams?: Readonly<Record<string, string>>) => {
      setVisits((count) => count + 1);
      if (next !== undefined) {
        router.navigate(SettingsRoute, { section: next }, { search: nextParams ?? left.get(next) ?? {} });
        return;
      }
      if (section() === undefined) return;
      const at = router.location().index;
      const back = way().get() ?? outside;
      // Back through the settings pages to the entry they were opened from, when it is still behind them; else go there anew.
      if (back !== undefined && back.index < at) router.go(back.index - at);
      else if (back !== undefined) router.navigate(back.href);
      else router.navigate(NewThreadRoute, {});
    };
    const setParams = (patch: Readonly<Record<string, string | undefined>>) => {
      const open = section();
      if (open === undefined) return;
      const next: Record<string, string> = { ...params() };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === "") delete next[key];
        else next[key] = value;
      }
      router.navigate(SettingsRoute, { section: open }, { search: next, replace: true });
    };

    /** One of its actions' bindings, as the user has it. */
    const keysOf = (id: string) => {
      const action = slots.get(Actions, id);
      return action === undefined ? undefined : shownKeys(action, uiPlugins.list());
    };
    slots.add(SettingsSections, { id: SectionIds.general, order: 0, title: "General", icon: SlidersIcon });
    slots.add(Pages, {
      id: "settings",
      route: SettingsRoute,
      component: () => (
        <SettingsView
          slots={slots}
          section={() => section() ?? SectionIds.general}
          visits={visits}
          open={open}
          setFocus={(next) => setFocus(() => next)}
          closeKeys={() => keysOf("settings.close")}
        />
      ),
    });
    slots.add(Actions, {
      id: "settings.open",
      order: 8,
      title: "Open settings",
      category: "Settings",
      keywords: ["preferences", "theme", "appearance", "general"],
      icon: GearIcon,
      keys: "mod+,",
      when: () => section() === undefined,
      run: () => open("general"),
    });
    slots.add(Actions, {
      id: "settings.close",
      title: "Close settings",
      category: "Settings",
      icon: ArrowLeftIcon,
      keys: ["escape", "mod+,"],
      whileTyping: true,
      order: -10,
      when: () => section() !== undefined,
      run: () => open(undefined),
    });
    slots.add(Actions, {
      id: "settings.search",
      title: "Search settings",
      hidden: true,
      keys: "/",
      order: -10,
      when: () => section() !== undefined && focus() !== undefined,
      run: () => focus()?.(),
    });
    // A section needing attention is the likeliest reason to open settings, so the button goes straight to it.
    const attention = () => slots.list(SettingsSections).find((candidate) => candidate.badge?.() !== undefined);
    slots.add(SidebarFooter, {
      id: "settings",
      component: (props) => (
        <button
          class="icon-button with-badge"
          aria-label="Settings"
          data-tip={attention() === undefined ? withKeys("Settings", keysOf("settings.open")) : `Settings · ${attention()!.title}: ${attention()!.badge!()}`}
          onClick={() => {
            open(attention()?.id ?? "general");
            props.onPick();
          }}
        >
          <GearIcon />
          <Show when={attention()?.badge?.()}>{(badge) => <span class="count-badge">{Number.parseInt(badge(), 10) || "!"}</span>}</Show>
        </button>
      ),
    });
    return { settings: { section, open, params, setParams } };
  },
});
