import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { isRoute } from "@lemma/router";
import { tildePath } from "@lemma/web/format";
import { sessionTitle, ComposerRegion, ThreadActions, ThreadHeader, Threads, Views } from "@lemma/threads";
import { Actions } from "@lemma/actions";
import { ActionMenu, Layout } from "@lemma/frame";
import { NewThreadRoute, ThreadRoute } from "@lemma/sessions";
import { Client, Notify, Pages, Router, Slots, defineWebPlugin, Contained, Each, First } from "@lemma/web";
import { Workspace } from "@lemma/workspace/web";
import type { Action } from "@lemma/actions";
import type { SlotItem } from "@lemma/web";
import type { ThreadAction } from "@lemma/threads";
import { ArchiveIcon, CopyIcon, MoreIcon, PenSquareIcon, PencilIcon, PinIcon, Popover, SidebarIcon, Spinner, StopIcon, TrashIcon } from "@lemma/look";
import { copyAndTell } from "@lemma/web/clipboard";
import styles from "./thread-view.css?inline";

/**
 * The page for one thread (and for a new one): a header, the chosen view
 * (chat, trajectory, or any other plugin's), and the composer under views
 * that want it. Views are siblings over the same log, switched from the
 * keyboard and the palette; the address names the view
 * (`/threads/<id>/trajectory`, the first when absent), the choice carries
 * over when switching threads, and a new thread opens in the first.
 */
export default defineWebPlugin({
  id: "threads.view",
  styles,
  routes: [NewThreadRoute, ThreadRoute],
  requires: { client: Client, threads: Threads, workspace: Workspace, slots: Slots, layout: Layout, notify: Notify, router: Router },
  setup: ({ client, threads, workspace, slots, layout, notify, router }) => {
    const views = () => slots.list(Views);
    /** The header's title is being edited in place. */
    const [renaming, setRenaming] = createSignal(false);
    /** The view the address names while it exists (its plugin may be off: the address is left as it is), else the first. */
    const view = createMemo(() => {
      const all = views();
      const named = router.matchOf(ThreadRoute)?.params.view;
      return (threads.activeId() === undefined ? undefined : all.find((candidate) => candidate.id === named)) ?? all[0];
    });
    const setChosen = (id: string) => {
      const sessionId = threads.activeId();
      if (sessionId !== undefined) router.navigate(threads.href(sessionId, id === views()[0]?.id ? undefined : id));
    };
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
        // ⌘T as a browser opens a tab; in a browser tab it stays the browser's, so ⌘⇧O works there.
        keys: ["mod+t", "mod+shift+o"],
        global: true,
        run: () => {
          threads.newThread();
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
        id: "thread.archive",
        order: 16,
        title: "Archive thread",
        category: "Thread",
        icon: ArchiveIcon,
        keys: "mod+alt+a",
        when: () => threads.active() !== undefined && threads.active()?.archived !== true,
        run: () => {
          const session = threads.active();
          if (session !== undefined) void threads.mark(session.id, { archived: true });
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
    // The views take turns from the keyboard; the header has no switch of its own.
    slots.add(Actions, {
      id: "thread.next-view",
      order: 12,
      title: "Switch thread view",
      detail: "Transcript, trajectory, and any other view, in turn",
      category: "View",
      keys: "mod+i",
      whileTyping: true,
      when: () => threads.active() !== undefined && views().length > 1,
      run: () => {
        const all = views();
        const at = all.findIndex((item) => item.id === view()?.id);
        const next = all[(at + 1) % all.length];
        if (next !== undefined) setChosen(next.id);
      },
    });
    // One action per view, as views come and go.
    createEffect(() => {
      for (const item of views()) {
        onCleanup(
          slots.add(Actions, {
            id: `thread.view.${item.id}`,
            order: 12,
            title: `Show ${item.title.toLowerCase()}`,
            category: "View",
            icon: item.icon,
            when: () => threads.active() !== undefined && view()?.id !== item.id,
            run: () => setChosen(item.id),
          }),
        );
      }
    });

    // Its header's items go through the slot other plugins add theirs to.
    const header = (id: string, order: number, side: "start" | "end", component: () => JSX.Element) => slots.add(ThreadHeader, { id, order, side, component });
    // While the sidebar shows, its own head has the toggle.
    header("thread.sidebar-toggle", 0, "start", () => (
      <Show when={!layout.sidebarShown()}>
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
    header("thread.running", 0, "end", () => (
      <Show when={threads.busy()}>
        <span class="busy-chip">
          <Spinner /> Running
        </span>
      </Show>
    ));

    header("thread.menu", 20, "end", () => (
      <Show when={threads.active()} keyed>
        {(session) => {
          const actions = () => slots.list(ThreadActions).filter((action) => action.when?.(session) ?? true);
          return (
            <Show when={actions().length > 0}>
              <Popover label="Thread actions" tip="Thread" trigger={<MoreIcon />} triggerClass="icon-button" placement="bottom-end">
                {(close) => (
                  <ActionMenu subject={session} control={{ rename: () => setRenaming(true) }} slot={ThreadActions} actions={actions()} close={close} />
                )}
              </Popover>
            </Show>
          );
        }}
      </Show>
    ));

    function Main() {
      let main!: HTMLElement;
      // The composer lies over the view's bottom: its height, for the view to pad its end by and scroll under it.
      const dock = (element: HTMLDivElement) => {
        const observer = new ResizeObserver(() => main.style.setProperty("--composer-height", `${element.offsetHeight}px`));
        observer.observe(element);
        onCleanup(() => {
          observer.disconnect();
          main.style.removeProperty("--composer-height");
        });
      };
      return (
        <main class="main" ref={main}>
          <header class="main-head">
            <Each slot={ThreadHeader} filter={(item) => item.side === "start"} />
            <span class="spacer" />
            <Each slot={ThreadHeader} filter={(item) => item.side === "end"} />
          </header>
          <Show
            when={unknown()}
            fallback={
              <Show when={view()} keyed fallback={<div class="scroller" />}>
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
          <Show when={unknown() === undefined && view()?.composer === true}>
            <div class="composer-dock" ref={dock}>
              <First slot={ComposerRegion} />
            </div>
          </Show>
        </main>
      );
    }
    slots.add(Pages, { id: "thread-view.new", route: NewThreadRoute, component: Main });
    slots.add(Pages, {
      id: "thread-view",
      route: ThreadRoute,
      component: Main,
      preload: (match) => {
        if (isRoute(match, ThreadRoute)) threads.preload(match.params.id);
      },
    });
  },
});
