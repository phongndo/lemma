import { For, Show, createEffect, createMemo, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { isRoute } from "@lemma/router";
import { tildePath } from "../model/format.ts";
import { sessionTitle } from "../model/threads.ts";
import {
  Actions,
  Client,
  ComposerRegion,
  Layout,
  NewThreadRoute,
  Notify,
  Pages,
  Router,
  ThreadHeader,
  ThreadRoute,
  Threads,
  Slots,
  Views,
  Workspace,
} from "../ui/contracts.ts";
import type { Action } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem } from "../ui/slots.ts";
import { Contained, CopyIcon, Each, First, PenSquareIcon, SidebarIcon, Spinner, StopIcon } from "../ui/parts.tsx";
import { copyText } from "../lib/clipboard.ts";
import styles from "./thread-view.css?inline";

/**
 * The page for one thread (and for a new one): a header, the chosen view
 * (chat, trajectory, or any other plugin's), and the composer under views
 * that want it. Views are siblings over the same log; the address names the
 * view (`/threads/<id>/trajectory`, the first when absent), the choice
 * carries over when switching threads, and a new thread opens in the first.
 */
export default defineUiPlugin({
  id: "thread-view",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, slots: Slots, layout: Layout, notify: Notify, router: Router },
  setup: ({ client, threads, workspace, slots, layout, notify, router }, plugin) => {
    const views = () => slots.list(Views);
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
      for (const action of actions) plugin.onCleanup(slots.add(Actions, action));
    };
    add(
      {
        id: "thread.new-chat",
        order: 1,
        title: "New thread",
        category: "Thread",
        icon: PenSquareIcon,
        keys: "mod+shift+o",
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
          void copyText(id).then((ok) =>
            ok ? notify.toast({ level: "info", message: `Copied ${id}` }) : notify.toast({ level: "error", message: "Could not copy to the clipboard" }),
          );
        },
      },
    );
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
    const header = (id: string, order: number, side: "start" | "end", component: () => JSX.Element) =>
      plugin.onCleanup(slots.add(ThreadHeader, { id, order, side, component }));
    header("thread.sidebar-toggle", 0, "start", () => (
      <button class="icon-button sidebar-toggle" aria-label="Toggle sidebar" data-tip="Toggle sidebar" onClick={() => layout.toggleSidebar()}>
        <SidebarIcon />
      </button>
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
          <h1>{unknown() !== undefined ? "No thread here" : threads.activeId() === undefined ? "New thread" : sessionTitle(threads.active())}</h1>
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
    header("thread.views", 10, "end", () => (
      <Show when={threads.activeId() !== undefined && views().length > 1}>
        <div class="view-tabs" role="tablist" aria-label="Thread view">
          <For each={views()}>
            {(item) => (
              <button
                role="tab"
                class="view-tab"
                aria-label={item.title}
                data-tip={item.title}
                aria-selected={view()?.id === item.id}
                onClick={() => setChosen(item.id)}
              >
                <Contained slot={Views} item={item} component={item.icon} />
              </button>
            )}
          </For>
        </div>
      </Show>
    ));

    function Main() {
      return (
        <main class="main">
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
            <First slot={ComposerRegion} />
          </Show>
        </main>
      );
    }
    plugin.onCleanup(slots.add(Pages, { id: "thread-view.new", route: NewThreadRoute, component: Main }));
    plugin.onCleanup(
      slots.add(Pages, {
        id: "thread-view",
        route: ThreadRoute,
        component: Main,
        preload: (match) => {
          if (isRoute(match, ThreadRoute)) threads.preload(match.params.id);
        },
      }),
    );
  },
});
