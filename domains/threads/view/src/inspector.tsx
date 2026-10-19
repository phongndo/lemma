import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid";
import { isSortable, useSortable } from "@dnd-kit/solid/sortable";
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { loadJson, save } from "@lemma/web/storage";
import { ThreadHolds, Views } from "@lemma/threads";
import { ThreadRoute } from "@lemma/sessions";
import { Contained } from "@lemma/web";
import type { RouterService, SlotsService } from "@lemma/web";
import type { PaneService, ThreadView, ThreadsService } from "@lemma/threads";
import { MaximizeIcon, MinimizeIcon, PlusIcon, Popover, SidebarIcon, XIcon } from "@lemma/look";
import {
  EMPTY,
  freshId,
  moved,
  onlyTab,
  paneOf,
  pruned,
  readPanes,
  showing,
  toggled,
  withPane,
  withTab,
  withoutRightOf,
  withoutTab,
  withoutTabs,
} from "./pane.ts";
import type { PaneState, Panes, Shows, Tab } from "./pane.ts";

const PANES_KEY = "lemma.threads.view.panes";

/**
 * The tabs, which drag along the strip to another place among them, as the thread tabs do: the tab follows the
 * pointer, the others make room, and `move` keeps the new order on the drop; `onStart` hears which was picked up.
 */
function SortableTabs(props: {
  list: () => HTMLElement | undefined;
  move: (id: string, index: number) => void;
  onStart: (id: string) => void;
  children: JSX.Element;
}) {
  return (
    <DragDropProvider
      sensors={[
        PointerSensor.configure({
          activationConstraints: (event) => [new PointerActivationConstraints.Distance({ value: event.pointerType === "touch" ? 8 : 4 })],
          // Its close button keeps its own pointer.
          preventActivation: (event) => event.target instanceof Element && event.target.closest(".thread-inspector-close") !== null,
        }),
      ]}
      modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => props.list() ?? null })]}
      plugins={(defaults) => [
        ...defaults.filter((plugin) => plugin !== Accessibility),
        AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
        Feedback.configure({ dropAnimation: null }),
      ]}
      onDragStart={(event) => {
        const source = event.operation.source;
        if (source !== null) props.onStart(source.id.toString());
      }}
      onDragEnd={(event) => {
        const source = event.operation.source;
        if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return;
        props.move(source.id.toString(), source.index);
      }}
    >
      {props.children}
    </DragDropProvider>
  );
}

/** A tab at `index` in the strip, inside `SortableTabs`. */
function SortableTab(props: { id: string; index: number; shown: boolean; children: JSX.Element }) {
  const sortable = useSortable({
    get id() {
      return props.id;
    },
    get index() {
      return props.index;
    },
  });
  return (
    <div ref={sortable.ref} class="thread-inspector-tab" classList={{ shown: props.shown, dragging: sortable.isDragSource() }}>
      {props.children}
    </div>
  );
}

export interface Inspector {
  readonly service: PaneService;
  /** The shown thread's pane is open. */
  readonly open: () => boolean;
  readonly maximized: () => boolean;
  /** The views it can show: the thread's views after the first. */
  readonly views: () => readonly (ThreadView & { readonly id: string })[];
  /** The view of the tab shown. */
  readonly shownView: () => string | undefined;
  readonly toggle: () => void;
  readonly maximize: () => void;
  /** Shows `view`: the tab shown when it is one of it, else its first tab, else a new one. */
  readonly showView: (view: string) => void;
  /** A tab shows, and focus is in the pane, or in what the tab's view draws over it (`data-pane-tab`). */
  readonly focused: () => boolean;
  readonly closeShown: () => void;
  /** The pane beside the chat, `width` px wide unless it fills the page; `resize` starts a drag of its edge. */
  readonly Pane: (props: { readonly width: number; readonly resize: (event: PointerEvent) => void }) => JSX.Element;
}

/**
 * Each thread's inspection pane, as T3 Code's right panel: the thread's own tabs, which views open in (its + menu,
 * each view's letter there), shown one at a time; a tab closes from its icon (an × under the pointer), a middle click,
 * or its right-click menu, and drags to another place. Closing the last tab closes the pane; opened with none, it
 * offers the views, by letter too. It may fill the page. Kept across reloads, per thread.
 */
export function createInspector(deps: {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly router: RouterService;
  /** Where focus goes when the pane closes from within: the composer. */
  readonly focusChat: () => void;
}): Inspector {
  const { threads, slots, router } = deps;
  const views = () => slots.list(Views).slice(1);
  const viewOf = (tab: Tab) => views().find((item) => item.id === tab.view);
  const shows: Shows = (tab) => viewOf(tab) !== undefined;

  const [panes, setPanes] = createSignal<Panes>(readPanes(loadJson<unknown>(PANES_KEY, {}, (_value): _value is unknown => true)));
  createEffect(on(panes, (next) => save(PANES_KEY, JSON.stringify(next)), { defer: true }));
  // A thread with tabs in its pane (a browser page, a trace) is kept, though nothing has been sent in it yet.
  slots.add(ThreadHolds, { id: "thread-view.pane", holds: (thread) => paneOf(panes(), thread).tabs.length > 0 });
  // A deleted thread's pane goes with it.
  createEffect(() => {
    if (!threads.loaded()) return;
    const known = new Set(threads.list().map((session) => session.id));
    const current = untrack(panes);
    if (Object.keys(current).some((thread) => !known.has(thread))) setPanes(pruned(current, known));
  });

  const thread = () => threads.activeId();
  const state = createMemo(() => {
    const id = thread();
    return id === undefined ? EMPTY : paneOf(panes(), id);
  });
  const update = (change: (state: PaneState) => PaneState, id = thread()) => {
    if (id !== undefined) setPanes((current) => withPane(current, id, change(paneOf(current, id))));
  };
  /** The shown thread's tabs whose view is on. */
  const tabs = createMemo(() => state().tabs.filter(shows));
  const open = () => thread() !== undefined && state().open;
  const shown = createMemo(() => (open() ? tabs().find((tab) => tab.id === state().active) : undefined));
  const maximized = () => open() && state().maximized === true;

  const random = () => Math.random().toString(36).slice(2, 8);
  const openTab = (view: string, background = false, owner = thread()): string | undefined => {
    if (owner === undefined) return undefined;
    const tab: Tab = { id: freshId(untrack(panes), view, random), view };
    update((current) => withTab(current, tab, background), owner);
    return tab.id;
  };
  const show = (id: string) => update((current) => showing(current, id));
  const showView = (view: string) => {
    const of = tabs().filter((tab) => tab.view === view);
    const tab = of.find((candidate) => candidate.id === state().active) ?? of[0];
    if (tab === undefined) openTab(view);
    else show(tab.id);
  };
  /** Focus is in the pane, or in what a view draws over it for the tab shown. */
  const focusInPane = () => {
    const tab = shown();
    const at = document.activeElement;
    return at?.closest(".thread-inspector") != null || (tab !== undefined && at?.closest(`[data-pane-tab="${CSS.escape(tab.id)}"]`) != null);
  };
  /**
   * Closes tabs by `change`. Focus there (or left nowhere, its button gone) goes on to the tab shown next, or to the
   * chat once the pane closes.
   */
  const closing = (change: (state: PaneState) => PaneState) => {
    const refocus = focusInPane() || document.activeElement === null || document.activeElement.localName === "body";
    update(change);
    if (!refocus) return;
    queueMicrotask(() => {
      const next = strip?.querySelector<HTMLElement>(".thread-inspector-tab.shown .thread-inspector-open");
      if (next !== null && next !== undefined) next.focus();
      else if (!open()) deps.focusChat();
    });
  };
  /** The tabs' strip while the pane is drawn. */
  let strip: HTMLDivElement | undefined;
  const closeTab = (id: string) => closing((current) => withoutTab(current, id, shows));
  /** Opened with no tab to show, the empty pane takes focus, for its keys; on a thread switch or reload it does not. */
  let focusEmpty = false;
  const toggle = () => {
    const id = thread();
    if (id === undefined) return;
    const next = toggled(paneOf(untrack(panes), id), shows);
    focusEmpty = next.open && next.active === undefined;
    update(() => next, id);
  };
  const maximize = () => update((current) => ({ ...current, maximized: current.maximized === true ? undefined : true }));
  const move = (id: string, index: number) => update((current) => moved(current, id, index, shows));

  // A view the address names opens in the thread's pane; the address then names the thread alone, as the pane is the
  // thread's. While the view's plugin is off the address is left as it is.
  createEffect(() => {
    const named = router.matchOf(ThreadRoute)?.params.view;
    const id = thread();
    if (named === undefined || id === undefined || !views().some((item) => item.id === named)) return;
    untrack(() => showView(named));
    router.navigate(threads.href(id), { replace: true });
  });

  const service: PaneService = {
    tabs: createMemo(() => Object.entries(panes()).flatMap(([owner, pane]) => pane.tabs.map((tab) => ({ id: tab.id, view: tab.view, thread: owner })))),
    open: (view, options) => openTab(view, options?.background === true, options?.thread ?? thread()),
  };

  /** The + menu's and the empty pane's row for a view: its icon, title, and letter. */
  const ViewRow = (props: { view: ThreadView & { readonly id: string } }) => (
    <>
      <Contained slot={Views} item={props.view} component={props.view.icon} />
      <span class="menu-label">{props.view.title}</span>
      <Show when={props.view.letter}>{(letter) => <kbd class="thread-inspector-key">{letter().toUpperCase()}</kbd>}</Show>
    </>
  );

  /** With no tab, the views to open: ↑/↓ and Enter, a click, or a view's letter; it takes focus, so the keys reach it. */
  function EmptyPane() {
    const id = `pane-views-${createUniqueId()}`;
    const [moved, setActive] = createSignal(0);
    /** The row active, within the views there are. */
    const active = () => Math.min(moved(), Math.max(0, views().length - 1));
    let list!: HTMLDivElement;
    onMount(() => {
      if (!focusEmpty) return;
      focusEmpty = false;
      list.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const all = views();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (all.length > 0) setActive((active() + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length);
      } else if (event.key === "Enter") {
        const view = all[active()];
        if (view === undefined) return;
        event.preventDefault();
        openTab(view.id);
      } else {
        const view = all.find((candidate) => candidate.letter?.toLowerCase() === event.key.toLowerCase());
        if (view === undefined) return;
        event.preventDefault();
        openTab(view.id);
      }
    };
    return (
      <div class="thread-inspector-empty">
        <h2>Open a view</h2>
        <div
          ref={list}
          class="thread-inspector-choices"
          role="listbox"
          aria-label="Open a view"
          tabindex="0"
          aria-activedescendant={views().length > 0 ? `${id}-${active()}` : undefined}
          onKeyDown={onKeyDown}
        >
          <For each={views()}>
            {(view, index) => (
              <div
                id={`${id}-${index()}`}
                class="menu-item thread-inspector-choice"
                role="option"
                aria-selected={index() === active()}
                aria-keyshortcuts={view.letter?.toUpperCase()}
                data-active={String(index() === active())}
                onPointerMove={() => setActive(index())}
                onClick={() => openTab(view.id)}
              >
                <ViewRow view={view} />
              </div>
            )}
          </For>
        </div>
      </div>
    );
  }

  /** A tab: its view's icon, an × under the pointer, closes it; its name shows it, and drags it. */
  function TabItem(props: { tab: Tab; view: ThreadView; index: number }) {
    const label = () => props.view.label?.(props.tab.id) ?? props.view.title;
    const isShown = () => shown()?.id === props.tab.id;
    let openMenu: (() => void) | undefined;
    return (
      <SortableTab id={props.tab.id} index={props.index} shown={isShown()}>
        <button class="thread-inspector-close" aria-label={`Close ${label()}`} data-tip="Close" onClick={() => closeTab(props.tab.id)}>
          <span class="thread-inspector-kind">
            <Contained slot={Views} item={props.view} component={props.view.icon} />
          </span>
          <XIcon />
        </button>
        <button
          class="thread-inspector-open"
          aria-current={isShown() ? "true" : undefined}
          data-tip={label()}
          onClick={() => show(props.tab.id)}
          onMouseDown={(event) => {
            // A middle click closes it, rather than scrolling.
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            closeTab(props.tab.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu?.();
          }}
        >
          {label()}
        </button>
        {/* Opened by a right-click; the trigger itself stays out of sight. */}
        <Popover
          label="Tab actions"
          trigger={<span />}
          triggerClass="thread-inspector-menu-anchor"
          placement="bottom-start"
          controller={(handle) => (openMenu = handle.open)}
        >
          {(close) => {
            const item = (name: string, enabled: boolean, run: () => void) => (
              <button
                class="menu-item"
                role="menuitem"
                aria-disabled={enabled ? undefined : "true"}
                onClick={() => {
                  if (!enabled) return;
                  close();
                  run();
                }}
              >
                <span class="menu-label">{name}</span>
              </button>
            );
            return (
              <>
                {item("Close", true, () => closeTab(props.tab.id))}
                {item("Close others", tabs().length > 1, () => closing((current) => onlyTab(current, props.tab.id, shows)))}
                {item("Close to the right", props.index < tabs().length - 1, () => closing((current) => withoutRightOf(current, props.tab.id, shows)))}
                {item("Close all", true, () => closing((current) => withoutTabs(current, shows)))}
              </>
            );
          }}
        </Popover>
      </SortableTab>
    );
  }

  function Pane(props: { readonly width: number; readonly resize: (event: PointerEvent) => void }) {
    onCleanup(() => (strip = undefined));
    return (
      <aside class="thread-inspector" aria-label="Inspection pane" style={maximized() ? undefined : { width: `${props.width}px` }}>
        <Show when={!maximized()}>
          <div
            class="thread-inspector-edge"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspection pane"
            onPointerDown={(event) => props.resize(event)}
          />
        </Show>
        <header class="main-head thread-inspector-head">
          {/* A tab picked up shows its view, as a browser's does. */}
          <SortableTabs list={() => strip} move={move} onStart={show}>
            <div class="thread-inspector-tabs" role="group" aria-label="Open views" ref={strip}>
              <For each={tabs()}>
                {(tab, index) => (
                  <Show when={viewOf(tab)} keyed>
                    {(view) => <TabItem tab={tab} view={view} index={index()} />}
                  </Show>
                )}
              </For>
            </div>
          </SortableTabs>
          <Popover label="Open a view" trigger={<PlusIcon />} triggerClass="icon-button" placement="bottom-start">
            {(close) => (
              <For each={views()}>
                {(view) => (
                  <button
                    class="menu-item"
                    role="menuitem"
                    aria-keyshortcuts={view.letter?.toUpperCase()}
                    onClick={() => {
                      close();
                      openTab(view.id);
                    }}
                  >
                    <ViewRow view={view} />
                  </button>
                )}
              </For>
            )}
          </Popover>
          <span class="spacer" />
          <button
            class="icon-button"
            aria-label={maximized() ? "Restore inspection pane" : "Maximize inspection pane"}
            aria-pressed={maximized()}
            data-tip={maximized() ? "Restore" : "Maximize"}
            onClick={maximize}
          >
            <Show when={maximized()} fallback={<MaximizeIcon />}>
              <MinimizeIcon />
            </Show>
          </button>
          <button class="icon-button inspect-toggle" aria-label="Close inspection pane" data-tip="Close pane" onClick={toggle}>
            <SidebarIcon />
          </button>
        </header>
        <Show when={shown()} keyed fallback={<EmptyPane />}>
          {(tab) => (
            <Show when={viewOf(tab)} keyed>
              {(view) => (
                <div class="thread-inspector-view" role="region" aria-label={view.label?.(tab.id) ?? view.title}>
                  <Contained slot={Views} item={view} component={view.component} props={{ tab: tab.id }} />
                </div>
              )}
            </Show>
          )}
        </Show>
      </aside>
    );
  }

  return {
    service,
    open,
    maximized,
    views,
    shownView: () => shown()?.view,
    toggle,
    maximize,
    showView,
    focused: () => shown() !== undefined && focusInPane(),
    closeShown: () => {
      const tab = shown();
      if (tab !== undefined) closeTab(tab.id);
    },
    Pane,
  };
}
