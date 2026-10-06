import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { SessionInfo } from "@lemma/contracts";
import { copyAndTell } from "../lib/clipboard.ts";
import { stepFor, withKeys } from "../lib/keys.ts";
import { loadJson, save } from "../lib/storage.ts";
import { relativeTime, tildePath } from "../model/format.ts";
import { shownKeys } from "../model/keybindings.ts";
import { fileSessions, sessionTitle } from "../model/threads.ts";
import { createNow } from "../lib/now.ts";
import {
  ActionIds,
  Actions,
  Client,
  Notify,
  ProjectActions,
  ThreadActions,
  Threads,
  SidebarActions,
  SidebarFooter,
  SidebarRegion,
  SidebarRowPart,
  Slots,
  UiPlugins,
  Workspace,
} from "../ui/contracts.ts";
import type { Action, ClientService, MenuAction, ThreadAction, ThreadsService, SidebarRowProps, WorkspaceService } from "../ui/contracts.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import type { Slot, SlotItem, SlotsService } from "../ui/slots.ts";
import { defineUiPlugin } from "../ui/define.ts";
import {
  ArchiveIcon,
  ChatIcon,
  CheckIcon,
  CommandIcon,
  Contained,
  CopyIcon,
  Each,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreIcon,
  PenSquareIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  Popover,
  SearchIcon,
  SidebarRow,
  TrashIcon,
  XIcon,
} from "../ui/parts.tsx";
import styles from "./sidebar.css?inline";

interface Deps {
  readonly client: ClientService;
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly workspace: WorkspaceService;
  readonly now: () => number;
  readonly newChatIn: (cwd?: string) => void;
  /** The project the list is narrowed to, or all when undefined; the head's projects button sets it. */
  readonly scope: () => string | undefined;
}

/**
 * A menu's items for one subject, grouped by `section`. An item with a
 * `confirm` text arms on the first pick, showing the text, and runs on the second.
 */
function ActionMenu<Subject, Control>(props: {
  subject: Subject;
  control: Control;
  /** The slot the actions are items of, so one whose icon throws is named. */
  slot: Slot<any>;
  actions: readonly MenuAction<Subject, Control>[];
  close: () => void;
}) {
  const [armed, setArmed] = createSignal<MenuAction<Subject, Control> | undefined>();
  return (
    <For each={props.actions}>
      {(action, index) => {
        const confirm = () => action.confirm?.(props.subject);
        return (
          <>
            <Show when={action.section && index() > 0}>
              <div class="menu-sep" role="separator" />
            </Show>
            <button
              class="menu-item"
              classList={{ "menu-danger": action.danger === true }}
              role="menuitem"
              onClick={() => {
                if (confirm() !== undefined && armed() !== action) {
                  setArmed(() => action);
                  return;
                }
                props.close();
                action.run(props.subject, props.control);
              }}
            >
              <Show when={action.icon}>{(icon) => <Contained slot={props.slot} item={action as unknown as SlotItem<unknown>} component={icon()} />}</Show>
              <span class="menu-label">{armed() === action ? confirm() : action.label(props.subject)}</span>
            </button>
          </>
        );
      }}
    </For>
  );
}

/** The default `sidebar.row` part: title, running dot, and time, which gives way to a ⋯ menu on hover; double-click renames. */
function SessionRow(props: SidebarRowProps) {
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
            onDblClick={() => setEditing(true)}
          >
            <Show when={props.running}>
              <span class="running-dot" data-tip="Running" />
            </Show>
            <span class="session-title" classList={{ untitled: props.session.title === undefined }}>
              {sessionTitle(props.session)}
            </span>
            <span class="session-time">{relativeTime(props.session.updatedAt, props.now)}</span>
          </a>
          <Show when={props.actions.length > 0}>
            <Popover
              label="Thread actions"
              tip="More"
              trigger={<MoreIcon />}
              triggerClass="icon-button session-more"
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

const COLLAPSED_KEY = "lemma.sidebar.collapsed";
/** The pinned section's key among the folded ones, which are otherwise project directories. */
const PINNED = ":pinned";

function Sidebar(props: { deps: Deps; onPick: () => void }) {
  const { client, threads, slots, workspace } = props.deps;
  const [query, setQuery] = createSignal("");
  // Sections folded shut, by project directory (or PINNED); kept across reloads. A search shows every match regardless.
  const [collapsed, setCollapsed] = createSignal(new Set(loadJson<string[]>(COLLAPSED_KEY, [])));
  const isOpen = (key: string) => query().trim() !== "" || !collapsed().has(key);
  const toggle = (key: string) => {
    const next = new Set(collapsed());
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    save(COLLAPSED_KEY, next.size === 0 ? undefined : JSON.stringify([...next]));
  };
  const filed = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const matches = (session: SessionInfo) => needle === "" || sessionTitle(session).toLowerCase().includes(needle);
    const scope = props.deps.scope();
    const inScope = (session: SessionInfo) => scope === undefined || session.cwd === scope;
    const { pinned, groups } = fileSessions(threads.list());
    return {
      pinned: pinned.filter((session) => inScope(session) && matches(session)),
      groups: groups
        .filter((group) => scope === undefined || group.cwd === scope)
        .map((group) => ({ ...group, sessions: group.sessions.filter(matches) }))
        .filter((group) => group.sessions.length > 0),
    };
  });
  const shown = () => filed().pinned.length + filed().groups.length > 0;
  /** Opens a project's menu from a right-click on its head, by directory. */
  const openProjectMenu = new Map<string, () => void>();
  const home = () => client.info()?.home;
  const standalone = (cwd: string) => workspace.isStandalone(cwd);
  const newChatIn = (cwd?: string) => {
    props.deps.newChatIn(cwd);
    props.onPick();
  };
  const sessionActions = (session: SessionInfo) => slots.list(ThreadActions).filter((action) => action.when?.(session) ?? true);
  const projectActions = (cwd: string) => slots.list(ProjectActions).filter((action) => action.when?.(cwd) ?? true);
  const onKey = (event: KeyboardEvent) => {
    // Arrow keys move between session rows.
    const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-session-row]")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = stepFor(event.key, index, rows.length);
    if (next === undefined || index === -1) return;
    event.preventDefault();
    rows[next]?.focus();
  };
  const rows = (list: readonly SessionInfo[]) => (
    <ul class="session-list">
      <For each={list}>
        {(session) => (
          <li>
            <SidebarRow
              session={session}
              active={threads.activeId() === session.id}
              running={threads.running().includes(session.id)}
              now={props.deps.now()}
              href={threads.href(session.id)}
              select={() => {
                void threads.select(session.id);
                props.onPick();
              }}
              rename={(title) => void threads.rename(session.id, title)}
              actions={sessionActions(session)}
            />
          </li>
        )}
      </For>
    </ul>
  );
  return (
    <nav class="sidebar" aria-label="Threads" onKeyDown={onKey}>
      <div class="sidebar-head">
        <label class="sidebar-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search threads"
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
          <Show when={query() !== ""}>
            <button class="icon-button search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <XIcon />
            </button>
          </Show>
        </label>
        <div class="sidebar-actions">
          <Each slot={SidebarActions} props={{ onPick: props.onPick }} />
        </div>
      </div>
      <div class="session-groups">
        <Show when={threads.loaded() && threads.list().length === 0}>
          <p class="sidebar-empty">No threads yet. Your conversations will appear here.</p>
        </Show>
        <Show when={threads.list().length > 0 && !shown()}>
          <p class="sidebar-empty">{query().trim() === "" ? "Every thread is archived." : "No matching threads."}</p>
        </Show>
        <Show when={filed().pinned.length > 0}>
          <section class="session-group">
            <div class="group-head">
              <button class="group-toggle" aria-expanded={isOpen(PINNED)} onClick={() => toggle(PINNED)}>
                <PinIcon />
                <span class="group-name">Pinned</span>
              </button>
            </div>
            <Show when={isOpen(PINNED)}>{rows(filed().pinned)}</Show>
          </section>
        </Show>
        <For each={filed().groups}>
          {(group) => (
            <section class="session-group">
              <div
                class="group-head"
                onContextMenu={(event) => {
                  const open = openProjectMenu.get(group.cwd);
                  if (open === undefined) return;
                  event.preventDefault();
                  open();
                }}
              >
                <button
                  class="group-toggle"
                  aria-expanded={isOpen(group.cwd)}
                  data-tip={standalone(group.cwd) ? "Threads in no project" : tildePath(group.cwd, home())}
                  onClick={() => toggle(group.cwd)}
                >
                  <Show when={!standalone(group.cwd)} fallback={<ChatIcon />}>
                    <Show when={isOpen(group.cwd)} fallback={<FolderIcon />}>
                      <FolderOpenIcon />
                    </Show>
                  </Show>
                  <span class="group-name">{standalone(group.cwd) ? "No project" : workspace.projectName(group.cwd)}</span>
                </button>
                <Show when={!standalone(group.cwd) && projectActions(group.cwd).length > 0}>
                  <Popover
                    label={`Actions for ${workspace.projectName(group.cwd)}`}
                    tip="More"
                    trigger={<MoreIcon />}
                    triggerClass="icon-button group-button"
                    placement="bottom-start"
                    controller={(handle) => openProjectMenu.set(group.cwd, handle.open)}
                  >
                    {(close) => <ActionMenu subject={group.cwd} control={undefined} slot={ProjectActions} actions={projectActions(group.cwd)} close={close} />}
                  </Popover>
                </Show>
                <button
                  class="icon-button group-button"
                  classList={{ active: threads.activeId() === undefined && threads.pendingCwd() === group.cwd }}
                  aria-label={standalone(group.cwd) ? "New thread in no project" : `New thread in ${group.cwd}`}
                  data-tip={standalone(group.cwd) ? "New thread in no project" : `New thread in ${tildePath(group.cwd, home())}`}
                  onClick={() => {
                    if (standalone(group.cwd)) {
                      void workspace.newStandalone();
                      props.onPick();
                    } else newChatIn(group.cwd);
                  }}
                >
                  <PlusIcon />
                </button>
              </div>
              <Show when={isOpen(group.cwd)}>{rows(group.sessions)}</Show>
            </section>
          )}
        </For>
      </div>
      <div class="sidebar-foot">
        <Each slot={SidebarFooter} props={{ onPick: props.onPick }} />
      </div>
    </nav>
  );
}

/** Threads by project, pinned ones first, with search, new-chat buttons, and a menu for each session and project. Its foot is a slot (settings, connection). */
export default defineUiPlugin({
  id: "sidebar",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, notify: Notify, slots: Slots, uiPlugins: UiPlugins },
  setup: (use) => {
    // Relative times refresh once a minute.
    const now = createNow(60_000);
    const { client, threads, workspace, notify, slots, uiPlugins } = use;
    const newChatIn = (cwd?: string) => threads.newThread(cwd);
    /** Projects with threads, which the list can be narrowed to; a chosen one that loses its last thread lets go. */
    const scopes = createMemo(() => fileSessions(threads.list()).groups.map((group) => group.cwd));
    const [chosenScope, setScope] = createSignal<string | undefined>();
    const scope = () => {
      const chosen = chosenScope();
      return chosen !== undefined && scopes().includes(chosen) ? chosen : undefined;
    };
    const scopeName = (cwd: string) => (workspace.isStandalone(cwd) ? "No project" : workspace.projectName(cwd));
    const deps: Deps = { client, threads, slots, workspace, now, newChatIn, scope };
    slots.add(SidebarRegion, { id: "sidebar", component: (props) => <Sidebar deps={deps} onPick={props.onPick} /> });
    slots.add(SidebarRowPart, { id: "sidebar.row", order: DEFAULT_PART_ORDER, component: SessionRow });

    // Its menus' items go through the slots other plugins add theirs to.
    const sessionAction = (id: string, order: number, action: ThreadAction) => slots.add(ThreadActions, { id, order, ...action });
    sessionAction("sidebar.rename", 10, { label: () => "Rename", icon: PencilIcon, run: (_, row) => row.rename() });
    sessionAction("sidebar.pin", 20, {
      label: (session) => (session.pinned === true ? "Unpin" : "Pin"),
      icon: PinIcon,
      run: (session) => void threads.mark(session.id, { pinned: session.pinned !== true }),
    });
    sessionAction("sidebar.archive", 30, {
      label: (session) => (session.archived === true ? "Unarchive" : "Archive"),
      icon: ArchiveIcon,
      run: (session) => void threads.mark(session.id, { archived: session.archived !== true }),
    });
    sessionAction("sidebar.delete", 40, {
      label: () => "Delete",
      icon: TrashIcon,
      danger: true,
      section: true,
      run: (session) => void threads.remove(session.id),
    });

    // The open thread, from the keyboard and the palette; Settings › Keyboard rebinds these.
    const open = () => threads.active();
    const threadAction = (id: string, order: number, action: Omit<Action, "category" | "when"> & { readonly when?: () => boolean }) =>
      slots.add(Actions, { id, order, category: "Thread", ...action, when: () => open() !== undefined && (action.when?.() ?? true) });
    /** The thread `step` rows away from the open one in the sidebar's order (pinned first, then by project), wrapping. */
    const neighbor = (step: number) => {
      const { pinned, groups } = fileSessions(threads.list());
      const order = [...pinned, ...groups.flatMap((group) => group.sessions)];
      if (order.length === 0) return undefined;
      const at = order.findIndex((session) => session.id === threads.activeId());
      return order[at === -1 ? 0 : (at + step + order.length) % order.length];
    };
    slots.add(Actions, {
      id: "sidebar.next-thread",
      order: 20,
      category: "Thread",
      title: "Next thread",
      keys: "mod+alt+arrowdown",
      whileTyping: true,
      run: () => {
        const next = neighbor(1);
        if (next !== undefined) void threads.select(next.id);
      },
    });
    slots.add(Actions, {
      id: "sidebar.previous-thread",
      order: 21,
      category: "Thread",
      title: "Previous thread",
      keys: "mod+alt+arrowup",
      whileTyping: true,
      run: () => {
        const previous = neighbor(-1);
        if (previous !== undefined) void threads.select(previous.id);
      },
    });
    threadAction("sidebar.pin-thread", 23, {
      title: "Pin or unpin thread",
      icon: PinIcon,
      keys: "mod+alt+p",
      run: () => {
        const session = open();
        if (session !== undefined) void threads.mark(session.id, { pinned: session.pinned !== true });
      },
    });
    threadAction("sidebar.archive-thread", 24, {
      title: "Archive thread",
      icon: ArchiveIcon,
      keys: "mod+alt+a",
      when: () => open()?.archived !== true,
      run: () => {
        const session = open();
        if (session !== undefined) void threads.mark(session.id, { archived: true });
      },
    });
    threadAction("sidebar.delete-thread", 25, {
      title: "Delete thread",
      icon: TrashIcon,
      run: () => {
        const session = open();
        if (session !== undefined) void threads.remove(session.id);
      },
    });

    slots.add(ProjectActions, { id: "sidebar.new-chat", order: 10, label: () => "New thread", icon: PenSquareIcon, run: (cwd) => newChatIn(cwd) });
    slots.add(ProjectActions, {
      id: "sidebar.copy-path",
      order: 20,
      label: () => "Copy path",
      icon: CopyIcon,
      run: (cwd) => void copyAndTell(notify, cwd),
    });
    // Its head's buttons go through the slot other plugins add theirs to.
    type ActionProps = { readonly onPick: () => void };
    const action = (id: string, order: number, component: (props: ActionProps) => JSX.Element) => slots.add(SidebarActions, { id, order, component });
    /** Another plugin's action, when one is running: the sidebar offers it without knowing who provides it. */
    const runAction = (id: string, props: ActionProps) => {
      slots.get(Actions, id)?.run();
      props.onPick();
    };
    action("sidebar.palette", 0, (props) => (
      <Show when={slots.get(Actions, ActionIds.palette)}>
        {(palette) => (
          <button
            class="icon-button"
            aria-label="Command palette"
            data-tip={withKeys("Commands, threads, projects", shownKeys(palette(), uiPlugins.list()))}
            onClick={() => runAction(ActionIds.palette, props)}
          >
            <CommandIcon />
          </button>
        )}
      </Show>
    ));
    action("sidebar.projects", 10, () => {
      const choose = (cwd: string | undefined, close: () => void) => {
        setScope(cwd);
        close();
      };
      return (
        <Popover
          label={scope() === undefined ? "Projects" : `Project: ${scopeName(scope()!)}`}
          trigger={<FolderIcon />}
          triggerClass={scope() === undefined ? "icon-button" : "icon-button active"}
        >
          {(close) => (
            <>
              <button class="menu-item" role="menuitemradio" aria-checked={scope() === undefined} onClick={() => choose(undefined, close)}>
                <span class="menu-check">
                  <Show when={scope() === undefined}>
                    <CheckIcon />
                  </Show>
                </span>
                All projects
              </button>
              <For each={scopes()}>
                {(cwd) => (
                  <button
                    class="menu-item"
                    role="menuitemradio"
                    aria-checked={scope() === cwd}
                    data-tip={workspace.isStandalone(cwd) ? undefined : tildePath(cwd, client.info()?.home)}
                    onClick={() => choose(cwd, close)}
                  >
                    <span class="menu-check">
                      <Show when={scope() === cwd}>
                        <CheckIcon />
                      </Show>
                    </span>
                    <span class="menu-label">{scopeName(cwd)}</span>
                  </button>
                )}
              </For>
            </>
          )}
        </Popover>
      );
    });
    action("sidebar.add-project", 20, (props) => (
      <Show when={slots.get(Actions, ActionIds.addProject)}>
        <button class="icon-button" aria-label="Add project" data-tip="Add project" onClick={() => runAction(ActionIds.addProject, props)}>
          <FolderPlusIcon />
        </button>
      </Show>
    ));
    action("sidebar.new-chat", 30, (props) => (
      <button
        class="icon-button"
        classList={{ active: threads.activeId() === undefined }}
        data-tip="New thread"
        aria-label="New thread"
        onClick={() => {
          newChatIn();
          props.onPick();
        }}
      >
        <PenSquareIcon />
      </button>
    ));
  },
});
