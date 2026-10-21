import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid";
import { isSortable, useSortable } from "@dnd-kit/solid/sortable";
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { loadJson, save } from "@lemma/web/storage";
import { withKeys } from "@lemma/web/keys";
import { ThreadHolds, Views } from "@lemma/threads";
import { ThreadRoute } from "@lemma/sessions";
import { Contained } from "@lemma/web";
import type { RouterService, SlotsService } from "@lemma/web";
import type { PaneService, ThreadView, ThreadsService } from "@lemma/threads";
import { MaximizeIcon, MinimizeIcon, PlusIcon, Popover, PopoverPart, SidebarIcon, XIcon } from "@lemma/look";
import {
  EMPTY,
  LEAST,
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

/**
 * A menu of views as keys reach it: its button, while drawn, holds what opens it (`hold`), and its items, while drawn,
 * what closes it (`shown`). One asked for before its button is drawn (the pane opening for it) opens once it is.
 */
interface Opener {
  /** Opens the menu, or closes it while it is open; false when no menu opens from here (none is drawn, or one opens only from its button). */
  readonly toggle: () => boolean;
  /** Opens the menu once its button is drawn. */
  readonly request: () => void;
  readonly hold: (open: () => void) => () => void;
  readonly shown: (close: () => void) => () => void;
}

const opener = (): Opener => {
  let held: (() => void) | undefined;
  let closer: (() => void) | undefined;
  let asked = false;
  return {
    toggle: () => {
      asked = false;
      // Read first: closing the menu lets go of what closes it.
      const [close, open] = [closer, held];
      if (close !== undefined) close();
      else open?.();
      return close !== undefined || open !== undefined;
    },
    request: () => {
      asked = true;
    },
    hold: (open) => {
      held = open;
      if (asked) {
        asked = false;
        open();
      }
      return () => {
        if (held === open) held = undefined;
      };
    },
    shown: (close) => {
      closer = close;
      return () => {
        if (closer === close) closer = undefined;
      };
    },
  };
};

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
  /** The shown thread's pane is open, at one of its tabs. */
  readonly open: () => boolean;
  readonly maximized: () => boolean;
  /** The views it can show: the thread's views after the first. */
  readonly views: () => readonly (ThreadView & { readonly id: string })[];
  /** The view of the tab shown. */
  readonly shownView: () => string | undefined;
  /** Opens the pane at the tab it showed last, or closes it; with no tab, offers the views instead (`offer`). */
  readonly toggle: () => void;
  /**
   * Offers the views to open in a new tab, or stops offering them: the pane's + menu, or, while it is closed with no
   * tab, its switch's. Where no menu can offer them (no popover is drawn), the first view opens.
   */
  readonly offer: () => void;
  readonly maximize: () => void;
  /** Shows `view`: the tab shown when it is one of it, else its first tab, else a new one. */
  readonly showView: (view: string) => void;
  /** A tab shows, and focus is in the pane, or in what the tab's view draws over it (`data-pane-tab`). */
  readonly focused: () => boolean;
  readonly closeShown: () => void;
  /**
   * The pane beside the chat, its `share` of the page wide (until its edge is dragged, its stylesheet's width) unless
   * it fills the page; `resize` starts a drag of its edge, and `reset` (a double-click on it) gives it its first width.
   */
  readonly Pane: (props: { readonly share: number | undefined; readonly resize: (event: PointerEvent) => void; readonly reset: () => void }) => JSX.Element;
  /** The thread header's switch while the pane is closed: opens it, or, with no tab, its menu of views. */
  readonly Switch: () => JSX.Element;
}

/**
 * Each thread's inspection pane, as T3 Code's right panel: the thread's own tabs, which views open in (its + menu,
 * each view's letter there), shown one at a time; a tab closes from its ×, a middle click, or its right-click menu,
 * and drags to another place. Closing the last tab closes the pane, and it never opens empty: with no tab, its switch
 * offers the views, by letter too. It may fill the page. Kept across reloads, per thread.
 */
export function createInspector(deps: {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly router: RouterService;
  /** Where focus goes when the pane closes from within: the composer. */
  readonly focusChat: () => void;
  /** The key an action runs on, as Settings › Keyboard binds it, for a button's tip. */
  readonly keysOf: (action: string) => string | undefined;
}): Inspector {
  const { threads, slots, router, keysOf } = deps;
  /** The tips' keys, read once for every tab. */
  const closeKeys = createMemo(() => keysOf("thread.inspect-close-tab"));
  const inspectKeys = createMemo(() => keysOf("thread.inspect"));
  const newTabKeys = createMemo(() => keysOf("thread.inspect-new-tab"));
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
  const open = () => thread() !== undefined && state().open && tabs().length > 0;
  // The tab it showed last, else (that view's plugin off) the first that shows.
  const shown = createMemo(() => (open() ? (tabs().find((tab) => tab.id === state().active) ?? tabs()[0]) : undefined));
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
  /** The menus of views: the pane's +, and its switch in the thread's header while it is closed with no tab. */
  const plus = opener();
  const switcher = opener();
  /** What a menu of views offers first, where none can be shown. */
  const openFirst = () => {
    const first = views()[0];
    if (first !== undefined) openTab(first.id);
  };
  const offer = () => {
    if (thread() === undefined) return;
    if (open()) return void (plus.toggle() || openFirst());
    if (tabs().length === 0) return void (switcher.toggle() || openFirst());
    // Closed with tabs: it opens, and its + once drawn.
    plus.request();
    update((current) => toggled(current, shows));
  };
  const toggle = () => {
    if (thread() === undefined) return;
    if (!open() && tabs().length === 0) return offer();
    update((current) => toggled(current, shows));
  };
  /** The pane opens from its switch's menu, whose button goes as it does: drawn, it gives focus to the tab opened. */
  let focusOpened = false;
  const openPicked = (view: string) => {
    focusOpened = true;
    openTab(view);
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

  /** A menu's row for a view: its icon, title, and the letter that picks it while the menu is open. */
  const ViewRow = (props: { view: ThreadView & { readonly id: string } }) => (
    <>
      <Contained slot={Views} item={props.view} component={props.view.icon} />
      <span class="menu-label">{props.view.title}</span>
      <Show when={props.view.letter}>{(letter) => <kbd class="thread-inspector-key">{letter().toUpperCase()}</kbd>}</Show>
    </>
  );

  /**
   * A button's menu of the views, one picked opening in a new tab; a letter picks one too. While the button is drawn,
   * `opener` opens its menu from a key, unless the popover drawing it opens only from its button (takes no `controller`).
   */
  function ViewMenu(props: {
    label: string;
    tip: string;
    trigger: JSX.Element;
    triggerClass: string;
    placement: "bottom-start" | "bottom-end";
    opener: Opener;
    pick: (view: string) => void;
  }) {
    let handle: { readonly open: () => void } | undefined;
    // Held once drawn, so a menu asked for as its button appears opens at it.
    onMount(() => {
      if (handle !== undefined) onCleanup(props.opener.hold(handle.open));
    });
    return (
      <Popover
        label={props.label}
        tip={props.tip}
        trigger={props.trigger}
        triggerClass={props.triggerClass}
        placement={props.placement}
        controller={(given) => (handle = given)}
      >
        {(close) => <ViewItems close={close} opener={props.opener} pick={props.pick} />}
      </Popover>
    );
  }

  /** A menu's views, while it is open: closing it is theirs to hold. */
  function ViewItems(props: { close: () => void; opener: Opener; pick: (view: string) => void }) {
    onCleanup(props.opener.shown(props.close));
    return (
      <For each={views()}>
        {(view) => (
          <button
            class="menu-item"
            role="menuitem"
            aria-keyshortcuts={view.letter?.toUpperCase()}
            onClick={() => {
              props.close();
              props.pick(view.id);
            }}
          >
            <ViewRow view={view} />
          </button>
        )}
      </For>
    );
  }

  /** A tab: its view's icon and name show it, and drag it; its × (on the tab shown, and under the pointer) closes it. */
  function TabItem(props: { tab: Tab; view: ThreadView; index: number }) {
    const label = () => props.view.label?.(props.tab.id) ?? props.view.title;
    const isShown = () => shown()?.id === props.tab.id;
    let openMenu: (() => void) | undefined;
    return (
      <SortableTab id={props.tab.id} index={props.index} shown={isShown()}>
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
          <span class="thread-inspector-kind">
            <Contained slot={Views} item={props.view} component={props.view.icon} />
          </span>
          <span class="thread-inspector-label">{label()}</span>
        </button>
        <button
          class="thread-inspector-close"
          aria-label={`Close ${label()}`}
          data-tip={isShown() ? withKeys("Close", closeKeys()) : "Close"}
          onClick={() => closeTab(props.tab.id)}
        >
          <XIcon />
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

  function Pane(props: { readonly share: number | undefined; readonly resize: (event: PointerEvent) => void; readonly reset: () => void }) {
    onCleanup(() => (strip = undefined));
    // Opened from its switch's menu: the tab opened takes focus, unless its view took it (the browser's address bar).
    onMount(() => {
      if (!focusOpened) return;
      focusOpened = false;
      if (!focusInPane()) strip?.querySelector<HTMLElement>(".thread-inspector-tab.shown .thread-inspector-open")?.focus();
    });
    return (
      <aside
        class="thread-inspector"
        aria-label="Inspection pane"
        style={{
          "--pane-width": props.share === undefined ? undefined : `${props.share * 100}%`,
          "--pane-least": `${LEAST.pane}px`,
          "--chat-least": `${LEAST.chat}px`,
        }}
      >
        <Show when={!maximized()}>
          <div
            class="thread-inspector-edge"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspection pane"
            data-tip="Drag to resize · double-click to reset"
            onPointerDown={(event) => props.resize(event)}
            onDblClick={() => props.reset()}
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
          <ViewMenu
            label="Open a view"
            tip={withKeys("New tab", newTabKeys())}
            trigger={<PlusIcon />}
            triggerClass="icon-button"
            placement="bottom-start"
            opener={plus}
            pick={(view) => openTab(view)}
          />
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
          <button class="icon-button inspect-toggle" aria-label="Close inspection pane" data-tip={withKeys("Close pane", inspectKeys())} onClick={toggle}>
            <SidebarIcon />
          </button>
        </header>
        <Show when={shown()} keyed>
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

  /**
   * Last in the thread's header, beside where the pane opens: with no tab, its menu of views is all it opens. With no
   * popover to draw that menu, it is a plain button, which opens the first view (`offer`).
   */
  function Switch() {
    return (
      <Show when={thread() !== undefined && views().length > 0 && !open()}>
        <Show
          when={tabs().length === 0 && slots.first(PopoverPart) !== undefined}
          fallback={
            <button class="icon-button inspect-toggle" aria-label="Open inspection pane" data-tip={withKeys("Inspection pane", inspectKeys())} onClick={toggle}>
              <SidebarIcon />
            </button>
          }
        >
          <ViewMenu
            label="Open inspection pane"
            tip={withKeys("Open a view", inspectKeys())}
            trigger={<SidebarIcon />}
            triggerClass="icon-button inspect-toggle"
            placement="bottom-end"
            opener={switcher}
            pick={openPicked}
          />
        </Show>
      </Show>
    );
  }

  return {
    service,
    open,
    maximized,
    views,
    shownView: () => shown()?.view,
    toggle,
    offer,
    maximize,
    showView,
    focused: () => shown() !== undefined && focusInPane(),
    closeShown: () => {
      const tab = shown();
      if (tab !== undefined) closeTab(tab.id);
    },
    Pane,
    Switch,
  };
}
