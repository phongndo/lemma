import { For, Show, createMemo, createSignal } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { NewThreadRoute } from "@lemma/sessions";
import { defineRoute } from "@lemma/router";
import { createNow } from "@lemma/web/now";
import { relativeTime } from "@lemma/web/format";
import { withKeys } from "@lemma/web/keys";
import { matchesQuery } from "@lemma/web/match";
import { sessionTitle, ThreadActions, Threads } from "@lemma/threads";
import type { ThreadsService } from "@lemma/threads";
import { Actions, shownKeys } from "@lemma/actions";
import { ActionMenu, SidebarFooter } from "@lemma/frame";
import { Settings, SettingsSections } from "@lemma/settings";
import { Workspace, WorkspaceActionIds } from "@lemma/workspace/web";
import type { WorkspaceService } from "@lemma/workspace/web";
import { Pages, Router, Slots, WebPlugins, defineWebPlugin, usePlugin } from "@lemma/web";
import type { RouterService, SlotsService, WebPluginsService } from "@lemma/web";
import { ArchiveIcon, FolderPlusIcon, GearIcon, GridIcon, HistoryIcon, PenSquareIcon, Popover, SearchField, TrashIcon, XIcon } from "@lemma/look";
import { byDay } from "./groups.ts";
import styles from "./history.css?inline";

const HistoryRoute = defineRoute("history", { path: "/history" });

type Shelf = "active" | "archived";

interface Deps {
  readonly threads: ThreadsService;
  readonly workspace: WorkspaceService;
  readonly slots: SlotsService;
  readonly router: RouterService;
  readonly webPlugins: WebPluginsService;
  /** The first settings section asking for attention, which the gear opens to. */
  readonly attention: () => { readonly id: string; readonly title: string; readonly badge: string } | undefined;
  readonly openSettings: () => void;
  readonly close: () => void;
}

const keysOf = (deps: Deps, id: string) => {
  const action = deps.slots.get(Actions, id);
  return action === undefined ? undefined : shownKeys(action, deps.webPlugins.list());
};

function Row(props: { deps: Deps; session: SessionInfo; now: number }) {
  const plugin = usePlugin();
  const { threads, workspace, slots } = props.deps;
  let openMenu: (() => void) | undefined;
  const archived = () => props.session.archived === true;
  const actions = () => (archived() ? [] : slots.list(ThreadActions).filter((action) => action.when?.(props.session) ?? true));
  const running = () => threads.running().includes(props.session.id);
  const openThread = plugin.action("open thread", () => threads.select(props.session.id));
  return (
    <li
      class="history-row"
      onContextMenu={(event) => {
        if (actions().length === 0) return;
        event.preventDefault();
        openMenu?.();
      }}
    >
      <a
        class="history-open"
        href={threads.href(props.session.id)}
        data-history-row
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openThread();
        }}
      >
        <Mark name={workspace.projectName(props.session.cwd)} />
        <span class="history-title" classList={{ untitled: props.session.title === undefined }}>
          {sessionTitle(props.session)}
        </span>
        <Show when={running()}>
          <span class="history-mark" data-tip="Running" />
        </Show>
        <span class="history-meta history-project">{workspace.projectName(props.session.cwd)}</span>
        <span class="history-spacer" />
        <span class="history-meta history-time">{relativeTime(props.session.updatedAt, props.now)}</span>
      </a>
      <span class="history-row-actions">
        <Show
          when={archived()}
          fallback={
            <button
              class="icon-button"
              aria-label="Archive thread"
              data-tip="Archive"
              onClick={plugin.action("archive thread", () => threads.mark(props.session.id, { archived: true }))}
            >
              <ArchiveIcon />
            </button>
          }
        >
          <button class="button small" onClick={plugin.action("unarchive thread", () => threads.mark(props.session.id, { archived: false }))}>
            Unarchive
          </button>
          <button
            class="icon-button"
            aria-label="Delete thread"
            data-tip="Delete for good"
            onClick={plugin.action("delete thread", () => threads.remove(props.session.id))}
          >
            <TrashIcon />
          </button>
        </Show>
      </span>
      <Show when={actions().length > 0}>
        <Popover
          label="Thread actions"
          trigger={<span />}
          triggerClass="history-menu-anchor"
          placement="bottom-start"
          controller={(handle) => (openMenu = handle.open)}
        >
          {(close) => <ActionMenu subject={props.session} control={{ rename: () => undefined }} slot={ThreadActions} actions={actions()} close={close} />}
        </Popover>
      </Show>
    </li>
  );
}

/** Moves focus between rows with the arrows; from the search field, down goes to the first. */
const rowKeys = (event: KeyboardEvent) => {
  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (step === 0) return;
  const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-history-row]")];
  const index = rows.indexOf(document.activeElement as HTMLElement);
  event.preventDefault();
  if (index === -1) rows[0]?.focus();
  else if (index + step < 0) (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input")?.focus();
  else rows[Math.min(rows.length - 1, index + step)]?.focus();
};

/** A project's mark: its name's first letter. */
const Mark = (props: { name: string }) => <span class="history-avatar">{props.name.charAt(0).toUpperCase() || "·"}</span>;

function HistoryPage(props: { deps: Deps }) {
  const plugin = usePlugin();
  const { threads, workspace, slots } = props.deps;
  const now = createNow(60_000);
  const [query, setQuery] = createSignal("");
  const [shelf, setShelf] = createSignal<Shelf>("active");
  const [project, setProject] = createSignal<string | undefined>();
  const shown = createMemo(() =>
    threads
      .list()
      .filter((session) => (session.archived === true) === (shelf() === "archived"))
      .filter((session) => project() === undefined || session.cwd === project())
      .filter((session) => matchesQuery(query(), `${sessionTitle(session)} ${workspace.projectName(session.cwd)} ${session.cwd}`)),
  );
  const groups = createMemo(() => byDay(shown(), now()));
  const archivedCount = () => threads.list().filter((session) => session.archived === true).length;
  const openFirst = plugin.action("open thread", () => {
    const first = groups()[0]?.sessions[0];
    return first === undefined ? undefined : threads.select(first.id);
  });
  const addProject = slots.get(Actions, WorkspaceActionIds.addProject);
  return (
    <div class="history" role="region" aria-label="History" onKeyDown={rowKeys}>
      <button
        class="icon-button history-close"
        aria-label="Close history"
        data-tip={withKeys("Close", keysOf(props.deps, "history.close"))}
        onClick={() => props.deps.close()}
      >
        <XIcon />
      </button>
      <div class="history-columns">
        <nav class="history-nav" aria-label="Filter threads">
          <div class="history-nav-head">
            <span>Projects</span>
            <Show when={addProject}>
              {(action) => (
                <button
                  class="icon-button"
                  aria-label="Add project"
                  data-tip={withKeys("Add project", keysOf(props.deps, action().id))}
                  onClick={() => action().run()}
                >
                  <FolderPlusIcon />
                </button>
              )}
            </Show>
          </div>
          <ul>
            <For each={workspace.projects()}>
              {(path) => (
                <li>
                  <button
                    class="history-nav-item"
                    classList={{ active: project() === path }}
                    aria-pressed={project() === path}
                    data-tip={path}
                    onClick={() => setProject(project() === path ? undefined : path)}
                  >
                    <Mark name={workspace.projectName(path)} />
                    <span class="history-nav-label">{workspace.projectName(path)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <ul class="history-nav-rest">
            <li>
              <button
                class="history-nav-item"
                classList={{ active: shelf() === "archived" }}
                aria-pressed={shelf() === "archived"}
                onClick={() => setShelf(shelf() === "archived" ? "active" : "archived")}
              >
                <ArchiveIcon />
                <span class="history-nav-label">Archived</span>
                <Show when={archivedCount() > 0}>
                  <span class="history-nav-count">{archivedCount()}</span>
                </Show>
              </button>
            </li>
            <li>
              <button
                class="history-nav-item with-badge"
                data-tip={
                  props.deps.attention() === undefined
                    ? withKeys("Settings", keysOf(props.deps, "settings.open"))
                    : `${props.deps.attention()!.title}: ${props.deps.attention()!.badge}`
                }
                onClick={() => props.deps.openSettings()}
              >
                <GearIcon />
                <span class="history-nav-label">Settings</span>
                <Show when={props.deps.attention()}>{(attention) => <span class="count-badge">{Number.parseInt(attention().badge, 10) || "!"}</span>}</Show>
              </button>
            </li>
          </ul>
        </nav>
        <div class="history-main">
          <div class="history-search">
            <SearchField
              value={query()}
              onInput={setQuery}
              placeholder={shelf() === "archived" ? "Search archived threads" : "Search threads"}
              label="Search threads"
              ref={(input) => queueMicrotask(() => input.focus())}
              onKeyDown={(event) => {
                if (event.key === "Enter") openFirst();
              }}
            />
          </div>
          <Show
            when={groups().length > 0}
            fallback={
              <>
                <div class="history-group-head">
                  <span />
                  <NewThread deps={props.deps} project={project()} />
                </div>
                <p class="history-empty muted">{query() !== "" ? "No thread matches." : shelf() === "archived" ? "No archived threads." : "No threads yet."}</p>
              </>
            }
          >
            <For each={groups()}>
              {(group, index) => (
                <section class="history-group">
                  <div class="history-group-head">
                    <h2>{group.label}</h2>
                    <Show when={index() === 0 && shelf() === "active"}>
                      <NewThread deps={props.deps} project={project()} />
                    </Show>
                  </div>
                  <ul>
                    <For each={group.sessions}>{(session) => <Row deps={props.deps} session={session} now={now()} />}</For>
                  </ul>
                </section>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** A new thread, in the project the page is filtered to when it is. */
const NewThread = (props: { deps: Deps; project: string | undefined }) => (
  <button class="history-new" onClick={() => props.deps.threads.newThread(props.project)}>
    <PenSquareIcon />
    New thread
  </button>
);

/**
 * Every thread, newest first by the day it was last used, as a browser's
 * history: search them, open one (it becomes a tab), archive, unarchive, or
 * delete. Its button stands where the open threads' foot items do, and the
 * page holds the way to settings.
 */
export default defineWebPlugin({
  id: "threads.history",
  styles,
  routes: [HistoryRoute],
  requires: { threads: Threads, workspace: Workspace, settings: Settings, slots: Slots, router: Router, webPlugins: WebPlugins },
  setup: ({ threads, workspace, settings, slots, router, webPlugins }) => {
    const showing = () => router.matchOf(HistoryRoute) !== undefined;
    // Where closing the page returns: the last place outside it.
    let outside: string | undefined;
    const remember = () => {
      if (!showing()) outside = router.location().href;
    };
    const open = () => {
      remember();
      router.navigate(HistoryRoute, {});
    };
    const close = () => {
      if (!showing()) return;
      if (outside !== undefined) router.navigate(outside);
      else router.navigate(NewThreadRoute, {});
    };
    const attention = () => {
      const section = slots.list(SettingsSections).find((candidate) => candidate.badge?.() !== undefined);
      return section === undefined ? undefined : { id: section.id, title: section.title, badge: section.badge!()! };
    };
    const deps: Deps = { threads, workspace, slots, router, webPlugins, attention, openSettings: () => settings.open(attention()?.id ?? "general"), close };

    slots.add(Pages, { id: "history", route: HistoryRoute, component: () => <HistoryPage deps={deps} /> });
    slots.add(SidebarFooter, {
      id: "history",
      component: () => (
        <button
          class="icon-button with-badge"
          classList={{ active: showing() }}
          aria-label="History"
          aria-pressed={showing()}
          data-tip={withKeys(attention() === undefined ? "History" : `History · ${attention()!.title}: ${attention()!.badge}`, keysOf(deps, "history.open"))}
          onClick={() => (showing() ? close() : open())}
        >
          <GridIcon />
          <Show when={attention()}>{(shown) => <span class="count-badge">{Number.parseInt(shown().badge, 10) || "!"}</span>}</Show>
        </button>
      ),
    });
    slots.add(Actions, {
      id: "history.open",
      order: 9,
      title: "History",
      detail: "Every thread, and the way to settings",
      category: "Thread",
      keywords: ["threads", "archived", "archive", "restore", "all", "sessions"],
      icon: HistoryIcon,
      keys: "mod+y",
      whileTyping: true,
      run: () => (showing() ? close() : open()),
    });
    slots.add(Actions, {
      id: "history.close",
      title: "Close history",
      hidden: true,
      keys: "escape",
      whileTyping: true,
      order: -10,
      when: showing,
      run: close,
    });
  },
});
