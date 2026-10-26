import { For, Show, createEffect, createMemo, createSignal, mapArray, on, onCleanup, onMount, untrack } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { formatKeys, withKeys } from "@lemma/web/keys";
import { shownKeysOf, Actions } from "@lemma/actions";
import { attentionOf, badgesOf, errorCount, filterGroups } from "./settings.ts";
import type { EntryGroup } from "./settings.ts";
import { Layout, SidebarFooter, SidebarRegion } from "@lemma/frame";
import { NewThreadRoute } from "@lemma/sessions";
import { SectionIds, Settings, SETTINGS_CONTRACT, SettingsGroups, SettingsMenu, SettingsRoute, SettingsSections } from "@lemma/settings";
import { PromptCommands } from "@lemma/threads";
import { Pages, Router, Slots, WebPlugins, defineWebPlugin, Contained } from "@lemma/web";
import type { SettingsEntry, SettingsGroup, SettingsSection } from "@lemma/settings";
import type { SlotItem } from "@lemma/web";
import { ArrowLeftIcon, GearIcon, Popover, SearchIcon, SidebarIcon, SlidersIcon, XIcon } from "@lemma/look";
import styles from "./settings.css?inline";

type Section = SlotItem<SettingsSection>;

/** A group and its entries, asked in a memo of its own: what one group reads changing asks no other group again. */
type Asked = { readonly group: SettingsGroup; readonly entries: Accessor<readonly SettingsEntry[]> };

/** A section's groups from every plugin, in order; groups with the same title merge. */
const groupsOf = (asked: readonly Asked[], section: string): EntryGroup<SettingsEntry>[] => {
  const merged: { title?: string; entries: SettingsEntry[] }[] = [];
  for (const { group, entries } of asked) {
    if (group.section !== section) continue;
    const same = merged.find((candidate) => candidate.title === group.title);
    if (same === undefined) merged.push({ ...(group.title === undefined ? {} : { title: group.title }), entries: [...entries()] });
    else same.entries.push(...entries());
  }
  return merged.filter((group) => group.entries.length > 0);
};

/**
 * Draws a list by key: an item stays drawn, and what is open in it, while the list around it changes. `<For>` alone
 * keys by object, and a list recomputed makes its objects anew.
 */
function Keyed<T>(props: { each: readonly T[]; key: (item: T) => string; children: (item: Accessor<T>) => JSX.Element }) {
  const byKey = createMemo(() => new Map(props.each.map((item) => [props.key(item), item])));
  return <For each={[...byKey().keys()]}>{(key) => <Show when={byKey().get(key)}>{(item) => props.children(item)}</Show>}</For>;
}

/** Groups by title (merged, each title is one group's, untitled ones too) and rows by entry: an entry given again keeps its row. */
function Groups(props: { groups: readonly EntryGroup<SettingsEntry>[] }) {
  return (
    <Keyed each={props.groups} key={(group) => group.title ?? "\u0000"}>
      {(group) => (
        <section class="settings-group">
          <Show when={group().title}>{(title) => <h2 class="settings-group-title">{title()}</h2>}</Show>
          <div class="settings-rows">
            <For each={group().entries}>{(entry) => entry.view()}</For>
          </div>
        </section>
      )}
    </Keyed>
  );
}

/**
 * A section's head, every section's alike, under the breadcrumb that names it: what the section is for, and its own
 * buttons at the end. A section with neither has none.
 */
function SectionHead(props: { section: Section }) {
  return (
    <Show when={props.section.description !== undefined || props.section.actions !== undefined}>
      <header class="settings-section-head">
        <Show when={props.section.description}>{(text) => <p class="settings-section-description">{text()}</p>}</Show>
        <Show when={props.section.actions} keyed>
          {(actions) => (
            <div class="settings-section-actions">
              <Contained slot={SettingsSections} item={props.section} component={actions} />
            </div>
          )}
        </Show>
      </header>
    </Show>
  );
}

/**
 * Settings: `/settings/<section>`, a page whose sections take the sidebar
 * region while it shows, with the section's own state in the search
 * (`?plugin=agent&tab=faults`). Plugins add
 * sections and the entries in them; the search runs across every section,
 * and clearing it returns to the section being browsed. Closing returns to
 * where settings were opened from.
 */
export default defineWebPlugin({
  id: "settings.page",
  implements: [SETTINGS_CONTRACT],
  styles,
  routes: [SettingsRoute],
  requires: { slots: Slots, router: Router, webPlugins: WebPlugins, layout: Layout },
  provides: { settings: Settings },
  setup: ({ slots, router, webPlugins, layout }) => {
    const [focus, setFocus] = createSignal<() => void>();
    /** Focuses the first control in the search's results, while the page shows; false when it has none. */
    const [toResults, setToResults] = createSignal<() => boolean>();
    /** Focuses the section's own search, else its first control, while the page shows. */
    const [toSection, setToSection] = createSignal<() => void>();
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
      setQuery("");
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
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      router.navigate(SettingsRoute, { section: open }, { search: next, replace: true });
    };

    /** One of its actions' bindings, as the user has it. */
    const keysOf = (id: string) => shownKeysOf(slots, webPlugins.list(), id);
    const [query, setQuery] = createSignal("");
    const searching = () => query().trim() !== "";
    const sections = () => slots.list(SettingsSections);
    const current = (): Section | undefined => sections().find((candidate) => candidate.id === section()) ?? sections()[0];
    // Each group's entries in a memo of its own, for as long as the group is there: a search, or another group's change,
    // asks it nothing, so its rows stay drawn (`SettingsGroup.entries`).
    const asked = mapArray(
      () => slots.list(SettingsGroups),
      (group): Asked => ({ group, entries: createMemo(() => group.entries()) }),
    );
    const groups = createMemo(() => {
      const shown = section() === undefined ? undefined : current();
      return shown === undefined ? [] : groupsOf(asked(), shown.id);
    });
    const results = createMemo(() =>
      searching()
        ? sections()
            .map((found) => ({ section: found, groups: filterGroups(groupsOf(asked(), found.id), query()) }))
            .filter((found) => found.groups.length > 0)
        : [],
    );
    const count = (id: string) =>
      results()
        .find((found) => found.section.id === id)
        ?.groups.reduce((sum, group) => sum + group.entries.length, 0) ?? 0;

    /** The sections, in the sidebar's place: the shell sizes, resizes, and collapses it as it does the threads. */
    function Nav(props: { onPick: () => void }) {
      let search!: HTMLInputElement;
      const previous = document.activeElement as HTMLElement | null;
      // Opened at General, the search takes focus; opened at another section (a way straight to it, as the composer's
      // Connect is), that section's first control does, as it does while the search is out of sight in a closed drawer.
      onMount(() => queueMicrotask(() => (section() === SectionIds.general && !layout.sidebarHidden() ? search.focus() : toSection()?.())));
      setFocus(() => () => {
        // Out of sight (a closed drawer, a collapsed sidebar), the search comes into view first.
        if (layout.sidebarHidden()) layout.toggleSidebar();
        queueMicrotask(() => {
          search.focus();
          search.select();
        });
      });
      onCleanup(() => {
        setFocus(undefined);
        previous?.focus?.();
      });
      const go = (id: string | undefined) => {
        open(id);
        props.onPick();
      };
      return (
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
                // Enter or Down goes on to the results, as a list being searched does.
                if ((event.key === "Enter" || event.key === "ArrowDown") && searching() && toResults()?.()) event.preventDefault();
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
                <Show when={!searching() && item.badge?.()}>
                  {(badge) => (
                    <span class="settings-nav-count" classList={{ err: item.badgeTone !== "info" }}>
                      {badge()}
                    </span>
                  )}
                </Show>
              </button>
            )}
          </For>
          <span class="spacer" />
          <button class="settings-nav-item" onClick={() => go(undefined)} data-tip={withKeys("Back to chats", keysOf("settings.close"))}>
            <ArrowLeftIcon />
            <span class="settings-nav-label">Back</span>
          </button>
        </nav>
      );
    }
    const opened = createMemo(() => section() !== undefined);
    createEffect(() => {
      if (opened()) onCleanup(untrack(() => slots.add(SidebarRegion, { id: "settings", order: -10, component: Nav })));
    });

    /** What Tab stops at, less what is turned off or not shown, faded out included (a row's tools, shown on hover). */
    const controls = (within: HTMLElement, selector: string) =>
      [...within.querySelectorAll<HTMLElement>(selector)].filter(
        (control) =>
          !control.matches(':disabled, [tabindex="-1"], [aria-disabled="true"]') &&
          control.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      );
    const tabStop = "button, input, select, textarea, a[href], [tabindex]";

    function Page() {
      let main!: HTMLDivElement;
      createEffect(on([section, searching], () => main.scrollTo({ top: 0 }), { defer: true }));
      // The first result's first control, else its section's link.
      setToResults(() => () => {
        const first = controls(main, `.settings-result .settings-rows :is(${tabStop})`)[0] ?? controls(main, ".settings-result-title")[0];
        first?.focus();
        return first !== undefined;
      });
      setToSection(() => () => {
        const content = main.querySelector<HTMLElement>(".settings-content") ?? main;
        (controls(content, 'input[type="search"]')[0] ?? controls(content, tabStop)[0])?.focus();
      });
      onCleanup(() => {
        setToResults(undefined);
        setToSection(undefined);
      });
      return (
        <div class="settings" role="region" aria-label="Settings" ref={main}>
          <header class="settings-head">
            <button
              class="icon-button"
              aria-label="Toggle sidebar"
              data-tip={withKeys("Toggle sidebar", keysOf("shell.toggle-sidebar"))}
              data-sidebar-toggle
              onClick={() => layout.toggleSidebar()}
            >
              <SidebarIcon />
            </button>
            <span class="muted">Settings</span>
            <span class="settings-crumb-sep">/</span>
            <span class="settings-crumb">{searching() ? "Search" : current()?.title}</span>
            <span class="spacer" />
            <button class="icon-button" aria-label="Close settings" data-tip={withKeys("Close", keysOf("settings.close"))} onClick={() => open(undefined)}>
              <XIcon />
            </button>
          </header>
          <div class="settings-content" classList={{ wide: !searching() && current()?.body !== undefined }}>
            <Show
              when={searching()}
              fallback={
                <Show when={current()}>
                  {(shown) => (
                    <>
                      <SectionHead section={shown()} />
                      <Show when={shown().intro}>{(intro) => <Contained slot={SettingsSections} item={shown()} component={intro()} />}</Show>
                      <Show
                        when={shown().body}
                        keyed
                        fallback={
                          <Show
                            when={groups().some((group) => group.entries.length > 0)}
                            fallback={<Show when={shown().empty}>{(empty) => <Contained slot={SettingsSections} item={shown()} component={empty()} />}</Show>}
                          >
                            <Groups groups={groups()} />
                          </Show>
                        }
                      >
                        {(body) => <Contained slot={SettingsSections} item={shown()} component={body} />}
                      </Show>
                    </>
                  )}
                </Show>
              }
            >
              <Show when={results().length > 0} fallback={<p class="settings-empty">No settings match “{query().trim()}”</p>}>
                <Keyed each={results()} key={(found) => found.section.id}>
                  {(found) => (
                    <section class="settings-result">
                      <button class="settings-result-title" onClick={() => open(found().section.id)} data-tip={`Open ${found().section.title}`}>
                        <Contained slot={SettingsSections} item={found().section} component={found().section.icon} />
                        {found().section.title}
                      </button>
                      <Groups groups={found().groups} />
                    </section>
                  )}
                </Keyed>
              </Show>
            </Show>
          </div>
        </div>
      );
    }
    slots.add(SettingsSections, { id: SectionIds.general, order: 0, title: "General", icon: SlidersIcon });
    slots.add(Pages, { id: "settings", route: SettingsRoute, component: Page });
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
    // The sidebar's foot: the way to settings, counting the error badges (news, an `info` badge, is only a dot), and
    // opening at the first section with a badge, errors first. While a plugin adds to its menu (`SettingsMenu`), it
    // opens that menu instead, with a row for each section in error, then Settings.
    const badges = createMemo(() => badgesOf(slots.list(SettingsSections)));
    const errors = () => badges().filter((badge) => badge.tone === "error");
    const openKeys = () => shownKeysOf(slots, webPlugins.list(), "settings.open");
    const toggle = () => {
      if (section() !== undefined) open(undefined);
      else open(badges()[0]?.section.id ?? SectionIds.general);
    };
    const menu = () => slots.list(SettingsMenu).filter((item) => item.when?.() ?? true);
    const face = () => menu().find((item) => item.face !== undefined);
    const name = () => (face() === undefined ? "Settings" : `${face()!.face!.label()} · Settings`);
    const named = (name: string) => [name, ...badges().map((badge) => `${badge.section.title}: ${badge.text}`)].join(" · ");
    const Badge = () => (
      <Show
        when={errors().length > 0}
        fallback={
          <Show when={badges().length > 0}>
            <span class="badge-dot" />
          </Show>
        }
      >
        <span class="count-badge">{errorCount(badges())}</span>
      </Show>
    );
    slots.add(SidebarFooter, {
      id: "settings",
      component: (props) => (
        <Show
          when={menu().length > 0}
          fallback={
            <button
              class="icon-button with-badge"
              classList={{ active: section() !== undefined }}
              aria-label="Settings"
              aria-pressed={section() !== undefined}
              data-tip={withKeys(named("Settings"), openKeys())}
              onClick={() => {
                toggle();
                props.onPick();
              }}
            >
              <GearIcon />
              <Badge />
            </button>
          }
        >
          <Popover
            label={name()}
            tip={named(name())}
            triggerClass={`icon-button with-badge settings-trigger${section() === undefined ? "" : " active"}`}
            menuClass="settings-menu"
            placement="top-start"
            trigger={
              <>
                <Show when={face()} keyed fallback={<GearIcon />}>
                  {(item) => <Contained slot={SettingsMenu} item={item} component={item.face!.icon} />}
                </Show>
                <Badge />
              </>
            }
          >
            {(close) => (
              <>
                <For each={menu()}>
                  {(item, index) => (
                    <>
                      <Show when={index() > 0}>
                        <div class="menu-sep" role="separator" />
                      </Show>
                      <Contained slot={SettingsMenu} item={item} component={item.component} props={{ close }} />
                    </>
                  )}
                </For>
                <div class="menu-sep" role="separator" />
                {/* What the count on the button stands for, each a way to its section. */}
                <For each={errors()}>
                  {(badge) => (
                    <button
                      class="menu-item"
                      role="menuitem"
                      onClick={() => {
                        close();
                        open(badge.section.id);
                        props.onPick();
                      }}
                    >
                      <Contained slot={SettingsSections} item={badge.section} component={badge.section.icon} />
                      <span class="menu-label">{badge.section.title}</span>
                      <span class="menu-hint settings-menu-attention">{attentionOf(badge.text)}</span>
                    </button>
                  )}
                </For>
                <button
                  class="menu-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    toggle();
                    props.onPick();
                  }}
                >
                  <GearIcon />
                  <span class="menu-label">Settings</span>
                  <Show when={openKeys()}>{(keys) => <span class="menu-hint">{formatKeys(keys())}</span>}</Show>
                </button>
              </>
            )}
          </Popover>
        </Show>
      ),
    });
    slots.add(PromptCommands, {
      id: "settings",
      order: 40,
      description: "Open settings, or one of its sections",
      icon: GearIcon,
      args: [
        {
          name: "section",
          optional: true,
          rest: true,
          values: () => slots.list(SettingsSections).map((found) => ({ value: found.id, detail: found.title })),
        },
      ],
      // By the whole text, so a title with spaces (`Archived threads`) names its section too.
      run: ({ text }) => {
        const wanted = text;
        if (wanted === "") return open(SectionIds.general);
        const found = slots.list(SettingsSections).find((candidate) => candidate.id === wanted || candidate.title.toLowerCase() === wanted.toLowerCase());
        if (found === undefined) throw new Error(`No settings section “${wanted}”`);
        open(found.id);
      },
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
    return { settings: { section, open, params, setParams } };
  },
});
