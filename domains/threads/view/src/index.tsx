import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { isRoute } from "@lemma/router";
import { tildePath } from "@lemma/web/format";
import { load, save } from "@lemma/web/storage";
import { dragEdge } from "@lemma/web/drag";
import {
  sessionTitle,
  ComposerRegion,
  ComposerTakeovers,
  Pane,
  ThreadActions,
  ThreadHeader,
  Threads,
  ThreadsActionIds,
  ThreadCard,
  ThreadStart,
  Views,
} from "@lemma/threads";
import { Actions } from "@lemma/actions";
import { Layout } from "@lemma/frame";
import { NewThreadRoute, ThreadRoute } from "@lemma/sessions";
import { Client, Notify, Pages, Router, Slots, defineWebPlugin, Contained, Each, First } from "@lemma/web";
import { Workspace } from "@lemma/workspace/web";
import type { Action } from "@lemma/actions";
import type { SlotItem } from "@lemma/web";
import type { ThreadAction } from "@lemma/threads";
import { ArchiveIcon, CopyIcon, LogIcon, PenSquareIcon, PencilIcon, PinIcon, SidebarIcon, Spinner, StopIcon, TrashIcon } from "@lemma/look";
import { copyAndTell } from "@lemma/web/clipboard";
import { CostRow } from "./card.tsx";
import { createInspector } from "./inspector.tsx";
import styles from "./thread-view.css?inline";

const WIDTH_KEY = "lemma.threads.view.inspector-width";
/** Whether the thread card is kept open, in this browser: open until closed. */
const CARD_KEY = "lemma.threads.view.card";
/** The inspection pane's width (px) when none is kept, and the least it and the chat beside it take. */
const WIDTH = 480;
const MIN_WIDTH = 280;
const MIN_CHAT = 360;

/**
 * The page for one thread (and for a new one): its header, its first view
 * (the chat), with the composer under it when it wants one, and beside it the
 * thread's inspection pane (`inspector.tsx`), whose tabs are the thread's other
 * views (the trace, a browser, any other plugin's), as many of each as are
 * wanted: it provides `Pane`. Views are siblings over the same log. An address
 * naming a view (`/threads/<id>/trajectory`) opens it in the thread's pane. The
 * pane opens from the keyboard (⌘I), the header, and the palette, and is
 * resized by its edge.
 */
export default defineWebPlugin({
  id: "threads.view",
  styles,
  routes: [NewThreadRoute, ThreadRoute],
  requires: { client: Client, threads: Threads, workspace: Workspace, slots: Slots, layout: Layout, notify: Notify, router: Router },
  provides: { pane: Pane },
  setup: ({ client, threads, workspace, slots, layout, notify, router }) => {
    const views = () => slots.list(Views);
    /** The header's title is being edited in place. */
    const [renaming, setRenaming] = createSignal(false);
    /** The view filling the page: the first. */
    const main = () => views()[0];
    const inspector = createInspector({ threads, slots, router, focusChat: () => slots.get(Actions, ThreadsActionIds.focusComposer)?.run() });
    /** The thread card (`ThreadCard`) is kept open, over an open thread's chat: until closed, and remembered. */
    const [cardOpen, setCardOpen] = createSignal(load(CARD_KEY) !== "0");
    const toggleCard = () => {
      setCardOpen(!cardOpen());
      save(CARD_KEY, cardOpen() ? undefined : "0");
    };
    /** An open thread with something sent: what the card is of (a new one has its start line instead). */
    const started = () => threads.activeId() !== undefined && !threads.blank();
    /** The address names a thread the host does not have. */
    const unknown = () => {
      const named = router.matchOf(ThreadRoute)?.params.id;
      return named !== undefined && threads.loaded() && threads.activeId() === undefined ? named : undefined;
    };

    const add = (...actions: SlotItem<Action>[]) => {
      for (const action of actions) slots.add(Actions, action);
    };
    add(
      {
        id: "thread.new-chat",
        order: 1,
        title: "New thread",
        category: "Thread",
        icon: PenSquareIcon,
        // ⌘N, as Codex and T3 Code have it; in a browser it stays the browser's (a new window), so ⌘⇧O works there.
        keys: ["mod+n", "mod+shift+o"],
        global: true,
        inPages: true,
        run: () => {
          void threads.newThread();
          layout.closeDrawer();
        },
      },
      {
        id: "thread.cancel",
        order: 11,
        title: "Stop the running turn",
        category: "Thread",
        keywords: ["cancel"],
        icon: StopIcon,
        keys: "escape",
        when: threads.busy,
        run: threads.cancel,
      },
      {
        id: "thread.rename",
        order: 13,
        title: "Rename thread…",
        category: "Thread",
        keywords: ["title", "session"],
        keys: "mod+alt+r",
        icon: PenSquareIcon,
        when: () => threads.active() !== undefined,
        input: () => ({ title: `Rename “${sessionTitle(threads.active())}”`, placeholder: sessionTitle(threads.active()) }),
        run: (value) => {
          const session = threads.active();
          if (session !== undefined && value !== undefined) void threads.rename(session.id, value);
        },
      },
      {
        id: "thread.copy-id",
        order: 14,
        title: "Copy thread ID",
        category: "Thread",
        keywords: ["cli", "lemma"],
        icon: CopyIcon,
        when: () => threads.active() !== undefined,
        run: () => {
          const id = threads.activeId();
          if (id === undefined) return;
          void copyAndTell(notify, id);
        },
      },
      {
        id: "thread.pin",
        order: 15,
        title: "Pin or unpin thread",
        category: "Thread",
        icon: PinIcon,
        keys: "mod+alt+p",
        when: () => threads.active() !== undefined,
        run: () => {
          const session = threads.active();
          if (session !== undefined) void threads.mark(session.id, { pinned: session.pinned !== true });
        },
      },
      {
        id: "thread.delete",
        order: 17,
        title: "Delete thread",
        category: "Thread",
        icon: TrashIcon,
        when: () => threads.active() !== undefined,
        run: () => {
          const session = threads.active();
          if (session !== undefined) void threads.remove(session.id);
        },
      },
    );

    // A thread's menu (its header's ⋯, a right-click on its row) goes through the slot other plugins add theirs to.
    const menuItem = (id: string, order: number, action: ThreadAction) => slots.add(ThreadActions, { id, order, ...action });
    menuItem("thread.menu.rename", 10, { label: () => "Rename", icon: PencilIcon, run: (_, row) => row.rename() });
    menuItem("thread.menu.pin", 20, {
      label: (session) => (session.pinned === true ? "Unpin" : "Pin"),
      icon: PinIcon,
      run: (session) => void threads.mark(session.id, { pinned: session.pinned !== true }),
    });
    menuItem("thread.menu.archive", 30, {
      label: (session) => (session.archived === true ? "Unarchive" : "Archive"),
      icon: ArchiveIcon,
      run: (session) => void threads.mark(session.id, { archived: session.archived !== true }),
    });
    menuItem("thread.menu.delete", 40, {
      label: () => "Delete",
      icon: TrashIcon,
      danger: true,
      section: true,
      confirm: () => "Delete for good?",
      run: (session) => void threads.remove(session.id),
    });
    // The inspection pane opens and closes from the keyboard and the header's button, at the tab it last showed.
    add(
      {
        id: "thread.card",
        order: 12,
        title: "Toggle thread details",
        detail: "The open thread's mode, where it works, its context, and its cost, over its chat",
        category: "View",
        icon: LogIcon,
        when: started,
        run: toggleCard,
      },
      {
        id: "thread.inspect",
        order: 12,
        title: "Toggle inspection pane",
        detail: "The trace, a browser, or any other view, beside the chat",
        category: "View",
        keys: "mod+i",
        whileTyping: true,
        when: () => threads.active() !== undefined && inspector.views().length > 0,
        run: () => inspector.toggle(),
      },
      {
        id: "thread.inspect-maximize",
        order: 12,
        title: "Maximize or restore inspection pane",
        category: "View",
        when: inspector.open,
        run: () => inspector.maximize(),
      },
      {
        // Ahead of closing the thread: with focus in the pane, ⌘W closes its tab, as a browser's closes the page's.
        id: "thread.inspect-close-tab",
        order: 12,
        title: "Close the inspection pane's tab",
        category: "View",
        keys: "mod+w",
        whileTyping: true,
        inPages: true,
        when: inspector.focused,
        run: () => inspector.closeShown(),
      },
    );
    // One action per view it can show, as views come and go.
    createEffect(() => {
      for (const item of inspector.views()) {
        onCleanup(
          slots.add(Actions, {
            id: `thread.view.${item.id}`,
            order: 12,
            title: `Show ${item.title.toLowerCase()}`,
            category: "View",
            icon: item.icon,
            when: () => threads.active() !== undefined && inspector.shownView() !== item.id,
            run: () => inspector.showView(item.id),
          }),
        );
      }
    });

    // Its header's items go through the slot other plugins add theirs to.
    const header = (id: string, order: number, side: "start" | "end", component: () => JSX.Element) => slots.add(ThreadHeader, { id, order, side, component });
    // While the sidebar shows, its own head has the toggle.
    header("thread.sidebar-toggle", 0, "start", () => (
      <Show when={layout.sidebarHidden()}>
        <button class="icon-button sidebar-toggle" aria-label="Toggle sidebar" data-tip="Toggle sidebar" onClick={() => layout.toggleSidebar()}>
          <SidebarIcon />
        </button>
      </Show>
    ));
    header("thread.title", 10, "start", () => {
      const cwd = () => workspace.workingDir();
      // The project by its folder's name, the full path on hover: `lemma / Fix the build`.
      return (
        <div class="main-title">
          <Show when={!workspace.isStandalone(cwd()) && cwd()}>
            {(dir) => {
              const path = () => tildePath(dir(), client.info()?.home);
              return (
                <>
                  <span class="main-project" data-tip={path()}>
                    {workspace.projectName(dir())}
                  </span>
                  <span class="main-sep" aria-hidden="true">
                    /
                  </span>
                </>
              );
            }}
          </Show>
          <Show
            when={renaming() && threads.active()}
            keyed
            fallback={
              <h1 onDblClick={() => threads.active() !== undefined && setRenaming(true)}>
                {unknown() !== undefined ? "No thread here" : threads.activeId() === undefined ? "Thread" : sessionTitle(threads.active())}
              </h1>
            }
          >
            {(session) => {
              const commit = (value: string) => {
                setRenaming(false);
                if (value.trim() !== "" && value.trim() !== session.title) void threads.rename(session.id, value);
              };
              return (
                <input
                  class="main-rename"
                  value={session.title ?? ""}
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
                      setRenaming(false);
                    }
                  }}
                  onBlur={(event) => commit(event.currentTarget.value)}
                />
              );
            }}
          </Show>
        </div>
      );
    });
    // First of the header's end: it comes and goes, and at the outer edge nothing beside it moves when it does.
    header("thread.running", -20, "end", () => (
      <Show when={threads.busy()}>
        <span class="busy-chip">
          <Spinner /> Running
        </span>
      </Show>
    ));

    // The inspection pane's switch, last, beside where it opens; while it is open, its own head has the switch.
    header("thread.inspect", 30, "end", () => (
      <Show when={threads.activeId() !== undefined && inspector.views().length > 0 && !inspector.open()}>
        <button class="icon-button inspect-toggle" aria-label="Open inspection pane" data-tip="Inspection pane" onClick={() => inspector.toggle()}>
          <SidebarIcon />
        </button>
      </Show>
    ));
    // The thread card's switch. The thread's actions are its row's menu in the sidebar (a right-click), and the palette's.
    header("thread.card", 15, "end", () => (
      <Show when={started()}>
        <button
          class="icon-button card-toggle"
          classList={{ on: cardOpen() }}
          aria-label="Thread details"
          aria-pressed={cardOpen()}
          data-tip={cardOpen() ? "Hide thread details" : "Show thread details"}
          onClick={toggleCard}
        >
          <LogIcon />
        </button>
      </Show>
    ));
    // Its own row: what the thread has cost, after the others' (its mode, where it works, its context).
    slots.add(ThreadCard, { id: "thread.cost", order: 100, group: "usage", component: () => <CostRow threads={threads} /> });
    /** The card's groups, in the order their first rows come. */
    const cardGroups = createMemo(() => [...new Set(slots.list(ThreadCard).map((row) => row.group ?? row.id))]);

    /** The inspection pane's width, kept across reloads; the page narrows it to leave the chat room. */
    const [width, setWidth] = createSignal(Number(load(WIDTH_KEY)) || WIDTH);

    function Main() {
      let chat!: HTMLElement;
      let page!: HTMLElement;
      // The composer lies over the view's bottom: its height, for the view to pad its end by and scroll under it.
      const dock = (element: HTMLDivElement) => {
        const observer = new ResizeObserver(() => chat.style.setProperty("--composer-height", `${element.offsetHeight}px`));
        observer.observe(element);
        onCleanup(() => {
          observer.disconnect();
          chat.style.removeProperty("--composer-height");
        });
      };
      const [resizing, setResizing] = createSignal(false);
      // No edge, no drag: the pane closed or filling the page ends one under way.
      createEffect(() => {
        if (!inspector.open() || inspector.maximized()) setResizing(false);
      });
      /** Its edge's drag sets its width from the pointer, leaving the chat its least. */
      // The drag ends however the pointer is let go: released, cancelled, or the edge gone (the pane closed mid-drag).
      const resize = (event: PointerEvent) => {
        const started = dragEdge(event, {
          move: (moved) => {
            const bounds = page.getBoundingClientRect();
            setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(bounds.width - MIN_CHAT, bounds.right - moved.clientX))));
          },
          end: () => {
            setResizing(false);
            save(WIDTH_KEY, String(width()));
          },
        });
        if (started) setResizing(true);
      };
      /** A new thread, nothing sent yet: its prompt in the middle of the page, over what it starts with (`ThreadStart`). */
      const starting = () => threads.blank() && unknown() === undefined && main()?.composer === true;
      return (
        <main class="main" classList={{ resizing: resizing(), maximized: inspector.maximized() }} ref={page}>
          {/* Out of sight while the pane fills the page, so focus does not go into it. */}
          <section class="thread-chat" classList={{ starting: starting() }} ref={chat} inert={inspector.maximized() || undefined}>
            <header class="main-head">
              <Each slot={ThreadHeader} filter={(item) => item.side === "start"} />
              <span class="spacer" />
              <Each slot={ThreadHeader} filter={(item) => item.side === "end"} />
            </header>
            <Show when={cardOpen() && started() && unknown() === undefined}>
              <aside class="menu thread-card" aria-label="Thread details">
                <For each={cardGroups()}>
                  {(group) => (
                    <div class="thread-card-group">
                      <Each slot={ThreadCard} filter={(row) => (row.group ?? row.id) === group} />
                    </div>
                  )}
                </For>
              </aside>
            </Show>
            <Show
              when={unknown()}
              fallback={
                <Show when={main()} keyed fallback={<div class="scroller" />}>
                  {(item) => <Contained slot={Views} item={item} component={item.component} />}
                </Show>
              }
            >
              {(id) => (
                <div class="thread-unknown">
                  <h2>No thread here</h2>
                  <p class="muted">
                    The host has no thread <code>{id()}</code>: it may have been deleted. <a href={router.href(NewThreadRoute, {})}>Start a new thread</a>
                  </p>
                </div>
              )}
            </Show>
            <Show when={unknown() === undefined && main()?.composer === true}>
              <div class="composer-dock" ref={dock}>
                <First slot={ComposerRegion} />
                <Show when={starting()}>
                  <div class="thread-start">
                    <Each slot={ThreadStart} />
                  </div>
                </Show>
              </div>
            </Show>
          </section>
          <Show when={unknown() === undefined && inspector.open()}>
            <inspector.Pane width={width()} resize={resize} />
          </Show>
        </main>
      );
    }
    // A thread whose log is damaged reads up to the damage and takes no prompts: the composer says so, and goes on in a
    // fork of it, from its last event that reads (`sessions.fork`).
    const damaged = () => threads.active()?.damaged;
    slots.add(ComposerTakeovers, {
      id: "thread-view.damaged",
      sessionId: () => (damaged() === undefined ? undefined : threads.activeId()),
      key: () => `damaged:${threads.activeId() ?? ""}`,
      banner: () => (
        <div class="thread-damaged" role="status">
          <strong>This thread's log is damaged</strong>
          <span class="muted">
            {" "}
            at line {damaged()?.line} ({damaged()?.reason}). It reads up to there and takes no prompts; fork it to go on from its last event.
          </span>
        </div>
      ),
      waiting: () => <span class="muted">This thread's log is damaged: it takes no prompts.</span>,
      text: () => "",
      setText: () => {},
      placeholder: () => "Read-only",
      readOnly: () => true,
      submit: () => void threads.fork(),
      submitLabel: () => "Fork and go on",
      canSubmit: () => threads.active()?.leaf !== undefined,
    });

    slots.add(Pages, { id: "thread-view.new", route: NewThreadRoute, component: Main });
    slots.add(Pages, {
      id: "thread-view",
      route: ThreadRoute,
      component: Main,
      preload: (match) => {
        if (isRoute(match, ThreadRoute)) threads.preload(match.params.id);
      },
    });
    return { pane: inspector.service };
  },
});
