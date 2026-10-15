import { For, Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { NewThreadRoute } from "@lemma/sessions";
import { withKeys } from "@lemma/web/keys";
import { loadJson, save } from "@lemma/web/storage";
import { Actions, shownKeys } from "@lemma/actions";
import { sessionTitle, ThreadActions, Threads, SidebarRowPart, SidebarRow } from "@lemma/threads";
import { createNow } from "@lemma/web/now";
import { ActionMenu, Layout, SidebarActions, SidebarFooter, SidebarRegion, TopRegion } from "@lemma/frame";
import type { LayoutService } from "@lemma/frame";
import { Router, Slots, WebPlugins, defineWebPlugin, Each } from "@lemma/web";
import type { Action } from "@lemma/actions";
import type { ThreadsService, SidebarRowProps } from "@lemma/threads";
import type { RouterService, SlotsService, WebPluginsService } from "@lemma/web";
import { PlusIcon, Popover, SidebarIcon, XIcon } from "@lemma/look";
import { afterClose, neighborOf, pruned, seedOpen, shownThreads, withClosed, withOpened } from "./open.ts";
import type { Shown } from "./open.ts";
import { Effect, Schema } from "effect";
import styles from "./sidebar.css?inline";

const OPEN_KEY = "lemma.frame.sidebar.open";

/** The default `sidebar.row` part: the title, and a dot while it runs or finished unseen; × closes it (always on the open one, on hover for the rest), a right-click opens its menu, a double-click renames. */
function ThreadRow(props: SidebarRowProps) {
  const [editing, setEditing] = createSignal(false);
  let openMenu: (() => void) | undefined;
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) props.rename(value);
  };
  return (
    <Show
      when={editing()}
      fallback={
        <div
          class="session-row"
          classList={{ active: props.active }}
          onContextMenu={(event) => {
            if (props.actions.length === 0) return;
            event.preventDefault();
            openMenu?.();
          }}
        >
          <a
            class="session-open"
            href={props.href}
            data-session-row
            aria-current={props.active ? "page" : undefined}
            onClick={(event) => {
              // A plain click opens it here; with a modifier, the browser opens the link elsewhere.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              props.select();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1 || props.close === undefined) return;
              event.preventDefault();
              props.close();
            }}
            onDblClick={() => setEditing(true)}
          >
            <span class="session-title" classList={{ untitled: props.session.title === undefined }}>
              {sessionTitle(props.session)}
            </span>
            <Show when={props.running || props.unread}>
              <span class="session-mark" classList={{ running: props.running }} data-tip={props.running ? "Running" : "Finished"} />
            </Show>
          </a>
          <Show when={props.close}>
            {(close) => (
              <button class="icon-button session-close" aria-label="Close thread" data-tip="Close" onClick={() => close()()}>
                <XIcon />
              </button>
            )}
          </Show>
          {/* Opened by a right-click; the trigger itself stays out of sight. */}
          <Show when={props.actions.length > 0}>
            <Popover
              label="Thread actions"
              trigger={<span />}
              triggerClass="session-menu-anchor"
              placement="bottom-start"
              controller={(handle) => (openMenu = handle.open)}
            >
              {(close) => (
                <ActionMenu subject={props.session} control={{ rename: () => setEditing(true) }} slot={ThreadActions} actions={props.actions} close={close} />
              )}
            </Popover>
          </Show>
        </div>
      }
    >
      <input
        class="session-rename"
        value={props.session.title ?? ""}
        aria-label="Thread title"
        ref={(el) =>
          queueMicrotask(() => {
            el.focus();
            el.select();
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
          else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }
        }}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
    </Show>
  );
}

interface Deps {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly router: RouterService;
  readonly webPlugins: WebPluginsService;
  readonly layout: LayoutService;
  readonly now: () => number;
  readonly shown: () => Shown;
  readonly unread: () => ReadonlySet<string>;
  readonly close: (id: string) => void;
}

/** A row of the open threads, as the `sidebar.row` part draws it, for either layout. */
const threadRow = (deps: Deps, onPick: () => void) => {
  const { threads, slots } = deps;
  const actionsFor = (session: SessionInfo) => slots.list(ThreadActions).filter((action) => action.when?.(session) ?? true);
  return (session: SessionInfo, closable: boolean) => (
    <li>
      <SidebarRow
        session={session}
        active={threads.activeId() === session.id}
        running={threads.running().includes(session.id)}
        unread={deps.unread().has(session.id)}
        now={deps.now()}
        href={threads.href(session.id)}
        select={() => {
          void threads.select(session.id);
          onPick();
        }}
        rename={(title) => void threads.rename(session.id, title)}
        actions={actionsFor(session)}
        close={closable ? () => deps.close(session.id) : undefined}
      />
    </li>
  );
};

/** Moves focus between rows with `keys`: [back, forward]. */
const rowKeys =
  (keys: readonly [string, string]) =>
  (event: KeyboardEvent): void => {
    const step = event.key === keys[0] ? -1 : event.key === keys[1] ? 1 : 0;
    if (step === 0) return;
    const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-session-row]")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index + step))]?.focus();
  };

/** The row of a thread not yet sent, while its page shows. */
const DraftRow = () => (
  <li>
    <div class="session-row active">
      <span class="session-open">
        <span class="session-title untitled">Thread</span>
      </span>
    </div>
  </li>
);

function Sidebar(props: { deps: Deps; onPick: () => void }) {
  const { threads, slots, router, webPlugins, layout } = props.deps;
  const toggleKeys = () => {
    const action = slots.get(Actions, "shell.toggle-sidebar");
    return action === undefined ? undefined : shownKeys(action, webPlugins.list());
  };
  const row = threadRow(props.deps, props.onPick);
  const drafting = () => threads.activeId() === undefined && router.matchOf(NewThreadRoute) !== undefined;
  return (
    <nav class="sidebar" aria-label="Open threads" onKeyDown={rowKeys(["ArrowUp", "ArrowDown"])}>
      <div class="sidebar-head">
        <button class="icon-button" aria-label="Toggle sidebar" data-tip={withKeys("Toggle sidebar", toggleKeys())} onClick={() => layout.toggleSidebar()}>
          <SidebarIcon />
        </button>
        <span class="spacer" />
        <div class="sidebar-actions">
          <Each slot={SidebarActions} props={{ onPick: props.onPick }} />
        </div>
      </div>
      <div class="session-groups">
        <Show when={props.deps.shown().pinned.length > 0}>
          <ul class="session-list pinned">
            <For each={props.deps.shown().pinned}>{(session) => row(session, false)}</For>
          </ul>
        </Show>
        <ul class="session-list">
          <For each={props.deps.shown().open}>{(session) => row(session, true)}</For>
          <Show when={drafting()}>
            <DraftRow />
          </Show>
        </ul>
      </div>
      <div class="sidebar-foot">
        <Each slot={SidebarFooter} props={{ onPick: props.onPick }} />
      </div>
    </nav>
  );
}

/** The open threads as tabs across the window's top, then a + for a new one; the sidebar's foot items sit at its end. */
function TabStrip(props: { deps: Deps }) {
  const { threads, router } = props.deps;
  const pick = () => undefined;
  const row = threadRow(props.deps, pick);
  const drafting = () => threads.activeId() === undefined && router.matchOf(NewThreadRoute) !== undefined;
  return (
    <nav class="tab-strip" aria-label="Open threads">
      <ul class="tab-list" onKeyDown={rowKeys(["ArrowLeft", "ArrowRight"])}>
        <For each={props.deps.shown().pinned}>{(session) => row(session, false)}</For>
        <For each={props.deps.shown().open}>{(session) => row(session, true)}</For>
        <Show when={drafting()}>
          <DraftRow />
        </Show>
      </ul>
      <button class="icon-button tab-new" aria-label="New thread" data-tip="New thread" onClick={() => threads.newThread()}>
        <PlusIcon />
      </button>
      <div class="sidebar-actions">
        <Each slot={SidebarActions} props={{ onPick: pick }} />
      </div>
      <span class="tab-spacer" />
      <div class="tab-foot">
        <Each slot={SidebarFooter} props={{ onPick: pick }} />
      </div>
    </nav>
  );
}

/** Where the open threads show. */
const SidebarConfig = Schema.Struct({
  tabs: Schema.Literals(["top", "side"])
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => "top" as const)))
    .annotate({
      title: "Tabs",
      description: "Show the open threads as tabs across the top of the window, or down a sidebar beside the thread.",
    }),
});

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The threads kept open, as a browser keeps tabs: across the window's top
 * (the default) or down the sidebar, each with a mark for a running turn or
 * one that finished unseen. Search is a command (the palette, its keys). Opening a
 * thread adds it, closing it only takes it out of the list; pinned ones stay,
 * and one still running stays in sight. Everything else about a thread is in
 * its page and in the palette.
 */
export default defineWebPlugin({
  id: "frame.sidebar",
  styles,
  config: SidebarConfig,
  requires: { threads: Threads, slots: Slots, router: Router, webPlugins: WebPlugins, layout: Layout },
  setup: ({ threads, slots, router, webPlugins, layout }, plugin) => {
    // Relative times refresh once a minute, for a row part that shows them.
    const now = createNow(60_000);
    const stored = loadJson<string[] | undefined>(OPEN_KEY, undefined, (value): value is string[] | undefined => isStrings(value));
    const [open, setOpenRaw] = createSignal<readonly string[]>(stored ?? []);
    const setOpen = (next: readonly string[]) => {
      setOpenRaw(next);
      save(OPEN_KEY, JSON.stringify(next));
    };
    // A first visit opens the few most recent threads; afterwards, gone and archived threads drop out.
    let seeded = stored !== undefined;
    createEffect(() => {
      if (!threads.loaded()) return;
      const list = threads.list();
      if (!seeded) {
        seeded = true;
        setOpen(seedOpen(list));
        return;
      }
      const kept = pruned(untrack(open), list);
      if (kept.length !== untrack(open).length) setOpen(kept);
    });
    // Opening a thread opens it here.
    createEffect(() => {
      const id = threads.activeId();
      if (id !== undefined) setOpen(withOpened(untrack(open), id));
    });

    // A turn that ends while another thread is open leaves its thread unread until it is opened.
    const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set());
    createEffect(
      on(threads.running, (running, before) => {
        const ended = (before ?? []).filter((id) => !running.includes(id) && id !== threads.activeId());
        if (ended.length > 0) setUnread(new Set([...unread(), ...ended]));
      }),
    );
    createEffect(() => {
      const id = threads.activeId();
      if (id === undefined || !untrack(unread).has(id)) return;
      const next = new Set(untrack(unread));
      next.delete(id);
      setUnread(next);
    });

    const shown = createMemo(() => shownThreads(threads.list(), open(), threads.running()));
    const order = () => [...shown().pinned, ...shown().open];
    const close = (id: string) => {
      const next = id === threads.activeId() ? afterClose(order(), id) : undefined;
      setOpen(withClosed(open(), id));
      if (id !== threads.activeId()) return;
      if (next !== undefined) void threads.select(next);
      else threads.newThread();
    };

    const deps: Deps = { threads, slots, router, webPlugins, layout, now, shown, unread, close };
    if (plugin.config.tabs === "side")
      slots.add(SidebarRegion, { id: "sidebar", phase: "default", component: (props) => <Sidebar deps={deps} onPick={props.onPick} /> });
    else slots.add(TopRegion, { id: "tabs", phase: "default", component: () => <TabStrip deps={deps} /> });
    slots.add(SidebarRowPart, { id: "sidebar.row", phase: "default", component: ThreadRow });

    // Moving through and closing the open threads, from the keyboard and the palette; Settings › Keyboard rebinds these.
    const move = (step: number) => {
      const next = neighborOf(order(), threads.activeId(), step);
      if (next !== undefined) void threads.select(next);
    };
    const add = (id: string, order: number, action: Omit<Action, "category">) => slots.add(Actions, { id, order, category: "Thread", ...action });
    add("sidebar.next-thread", 20, { title: "Next open thread", keys: ["mod+shift+]", "mod+alt+arrowdown"], whileTyping: true, run: () => move(1) });
    add("sidebar.previous-thread", 21, { title: "Previous open thread", keys: ["mod+shift+[", "mod+alt+arrowup"], whileTyping: true, run: () => move(-1) });
    add("sidebar.close-thread", 22, {
      title: "Close thread",
      detail: "Takes it out of the open threads; the thread stays",
      icon: XIcon,
      keys: "mod+w",
      whileTyping: true,
      when: () => {
        const id = threads.activeId();
        return id !== undefined && shown().open.some((session) => session.id === id);
      },
      run: () => {
        const id = threads.activeId();
        if (id !== undefined) close(id);
      },
    });
  },
});
