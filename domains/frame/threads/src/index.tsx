import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { useDroppable } from "@dnd-kit/solid";
import type { SessionInfo, SessionMarks } from "@lemma/sessions";
import { formatKeys, withKeys } from "@lemma/web/keys";
import { loadJson, recordOf, save } from "@lemma/web/storage";
import { dragEdge } from "@lemma/web/drag";
import { ActionIds, Actions, shownKeysOf } from "@lemma/actions";
import { sessionTitle, ThreadActions, Threads, ThreadWaits, SidebarRowPart, SidebarRow, waitingOn } from "@lemma/threads";
import { ActionMenu, Layout, SidebarActions, SidebarFooter, SidebarRegion } from "@lemma/frame";
import { Workspace } from "@lemma/workspace/web";
import { Interactions, Slots, WebPlugins, defineWebPlugin, Each, usePlugin } from "@lemma/web";
import type { Action } from "@lemma/actions";
import type { SidebarRowProps, ThreadDraft } from "@lemma/threads";
import {
  ArchiveIcon,
  Avatar,
  CheckIcon,
  ChevronDownIcon,
  CommandIcon,
  GitBranchIcon,
  PenSquareIcon,
  PinIcon,
  PinOffIcon,
  Popover,
  QuestionIcon,
  RedoIcon,
  SearchIcon,
  SidebarIcon,
  Spinner,
  WorktreeIcon,
  XIcon,
} from "@lemma/look";
import { Heads, afterArchiving, draftRows, flagsOf, nestedAgents, nextNeeding, runTime, sections, shortAge, stepFrom, transitioned } from "./list.ts";
import type { Flags, Marks } from "./list.ts";
import type { Deps } from "./deps.ts";
import { SortableItem, SortableThreads, createArrangement, verbs } from "./sortable.tsx";
import { ThreadDetails, createDetails } from "./details.tsx";
import styles from "./sidebar.css?inline";

// Under the plugin's former id (`frame.sidebar`), so what a browser kept carries over.
const MARKS_KEY = "lemma.frame.sidebar.marks";
const ARCHIVED_OPEN_KEY = "lemma.frame.sidebar.archived-open";
/** The archived panel's height (px), as dragged and kept: at first, at least, and by a key's step; the list above keeps at least `LIST_MIN`. */
const ARCHIVED_HEIGHT_KEY = "lemma.frame.sidebar.archived-height";
const ARCHIVED_HEIGHT = 220;
const ARCHIVED_MIN = 96;
const ARCHIVED_STEP = 24;
const LIST_MIN = 120;
/**
 * Its state where the time goes, as T3 Code shows it, the most pressing first: what it waits on the person for, a
 * running turn and its time, a finished one not yet seen; else how long ago it was used.
 */
const Status = (props: SidebarRowProps & { readonly since?: number }) => (
  <Switch fallback={<span class="thread-when">{shortAge(props.since ?? props.session.updatedAt, props.now)}</span>}>
    <Match when={props.waiting}>
      {(label) => (
        <span class="thread-when thread-state" data-state="waiting" role="status">
          <QuestionIcon />
          {label()}
        </span>
      )}
    </Match>
    <Match when={props.running}>
      <span class="thread-when thread-state" data-state="working">
        <Spinner />
        <span role="status">Working</span>
        <Show when={props.runningSince}>{(since) => <span aria-hidden="true">{runTime(since(), props.now)}</span>}</Show>
      </span>
    </Match>
    <Match when={props.unread}>
      <span class="thread-when thread-state" data-state="done" role="status">
        <CheckIcon />
        Done
      </span>
    </Match>
  </Switch>
);

/** The room the buttons under the pointer take at a line's end (a card's second, a slim row's one), which it stops short of then. */
const ARCHIVE_ROOM = 80;
const UNARCHIVE_ROOM = 92;
const PIN_ROOM = 24;
const DISCARD_ROOM = 76;

/**
 * The default `sidebar.row` part: a card of two lines, its title alone, so nothing cuts it short, then its project and
 * branch with its age or state at the end; a slim row once archived. Under the pointer a card offers to pin (or unpin) it and to archive it (an archived row,
 * to unarchive it), and after a moment shows its details beside it. A pen marks a prompt written in it and not sent. A
 * right-click opens its menu; a double-click renames it.
 */
function ThreadRow(props: SidebarRowProps) {
  const [editing, setEditing] = createSignal(false);
  const { at: details, point: pointAt, leave } = createDetails();
  let row!: HTMLDivElement;
  let openMenu: (() => void) | undefined;
  const archived = () => props.session.archived === true;
  /** What its age counts from: its archiving once archived, else its last use. */
  const since = () => (archived() ? (props.archivedAt ?? props.session.updatedAt) : props.session.updatedAt);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) props.rename(value);
  };
  const point = () => pointAt(row);
  const title = () => sessionTitle(props.session);
  const pinned = () => props.session.pinned === true && !archived();
  /** What the buttons under the pointer take: pinning or unpinning, then archiving or unarchiving. */
  const room = () => (props.pin === undefined ? 0 : PIN_ROOM) + (props.archive === undefined ? 0 : archived() ? UNARCHIVE_ROOM : ARCHIVE_ROOM);
  return (
    <Show
      when={editing()}
      fallback={
        <div
          ref={row}
          class="thread-row"
          classList={{ active: props.active, slim: archived(), running: props.running, unread: props.unread, drafted: props.drafted }}
          style={{ "--hover-room": `${room()}px` }}
          onPointerEnter={point}
          onPointerLeave={leave}
          onContextMenu={(event) => {
            leave();
            if (props.actions.length === 0) return;
            event.preventDefault();
            openMenu?.();
          }}
        >
          <a
            class="thread-open"
            href={props.href}
            draggable={false}
            data-session-row
            aria-current={props.active ? "page" : undefined}
            onClick={(event) => {
              // A plain click opens it here; with a modifier, the browser opens the link elsewhere.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              leave();
              props.select();
            }}
            onDblClick={() => setEditing(true)}
          >
            <Show
              when={!archived()}
              fallback={
                <span class="thread-line">
                  <span class="thread-title" classList={{ untitled: props.session.title === undefined }}>
                    {title()}
                  </span>
                  <Status {...props} since={since()} />
                </span>
              }
            >
              <span class="thread-line">
                <span class="thread-title" classList={{ untitled: props.session.title === undefined }}>
                  {title()}
                </span>
                <Show when={pinned()}>
                  <span class="thread-pin" data-tip="Pinned">
                    <PinIcon />
                  </span>
                </Show>
                <Show when={props.drafted}>
                  <span class="thread-drafted" role="img" aria-label="Unsent prompt" data-tip="Unsent prompt">
                    <PenSquareIcon />
                  </span>
                </Show>
              </span>
              <span class="thread-meta">
                <span class="thread-place">
                  <span class="thread-project">{props.project}</span>
                  <Show when={props.branch}>
                    {(branch) => (
                      <>
                        <Show when={props.worktree} fallback={<GitBranchIcon />}>
                          <WorktreeIcon />
                        </Show>
                        <span class="thread-branch">{branch()}</span>
                      </>
                    )}
                  </Show>
                </span>
                <Show when={props.shortcut} fallback={<Status {...props} />}>
                  {(keys) => <span class="thread-when thread-shortcut">{keys()}</span>}
                </Show>
              </span>
            </Show>
          </a>
          {/* Under the pointer, in place of the time: pin or unpin it, and archive it (or bring an archived one back). */}
          <span class="thread-hover">
            <Show when={props.pin}>
              {(pin) => (
                <button
                  class="thread-hover-button"
                  aria-label={pinned() ? `Unpin ${title()}` : `Pin ${title()}`}
                  data-tip={pinned() ? "Unpin" : "Pin"}
                  onClick={() => pin()()}
                >
                  <Show when={pinned()} fallback={<PinIcon />}>
                    <PinOffIcon />
                  </Show>
                </button>
              )}
            </Show>
            <Show when={props.archive}>
              {(archive) => (
                <button
                  class="thread-hover-button thread-archive"
                  aria-label={archived() ? `Unarchive ${title()}` : `Archive ${title()}`}
                  onClick={() => {
                    leave();
                    archive()();
                  }}
                >
                  <Show when={archived()} fallback={<ArchiveIcon />}>
                    <RedoIcon />
                  </Show>
                  {archived() ? "Unarchive" : "Archive"}
                </button>
              )}
            </Show>
          </span>
          <Show when={details()}>
            {(at) => (
              <ThreadDetails
                at={at()}
                side="beside"
                title={title()}
                project={props.project}
                branch={props.branch}
                worktree={props.worktree}
                waiting={props.waiting}
                running={props.running}
                runningSince={props.runningSince}
                unread={props.unread}
                archived={archived()}
                since={since()}
                now={props.now}
              />
            )}
          </Show>
          {/* Opened by a right-click; the trigger itself stays out of sight. */}
          <Show when={props.actions.length > 0}>
            <Popover
              label="Thread actions"
              trigger={<span />}
              triggerClass="thread-menu-anchor"
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
        class="thread-rename"
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

/** A thread's row, as the `sidebar.row` part draws it: it follows the thread as it changes. */
const rowOf = (deps: Deps, onPick: () => void) => {
  const { threads, slots } = deps;
  const actionsFor = (session: SessionInfo) => slots.list(ThreadActions).filter((action) => action.when?.(session) ?? true);
  return (session: () => SessionInfo) => {
    const id = () => session().id;
    const running = () => threads.running().includes(id());
    const place = () => deps.place(session().cwd);
    return (
      <SidebarRow
        session={session()}
        active={threads.activeId() === id()}
        running={running()}
        runningSince={deps.runningSince(id())}
        unread={deps.unread().has(id())}
        waiting={waitingOn(slots.list(ThreadWaits), id())}
        drafted={threads.activeId() !== id() && threads.drafts().has(id())}
        now={deps.now()}
        href={threads.href(id())}
        select={() => {
          void threads.select(id());
          onPick();
        }}
        rename={(title) => void threads.rename(id(), title)}
        actions={actionsFor(session())}
        project={place().project}
        branch={place().branch}
        worktree={place().worktree}
        archive={() => (session().archived === true ? deps.unarchive(session()) : deps.archive(session()))}
        pin={session().archived === true ? undefined : () => deps.pin(session(), session().pinned !== true)}
        archivedAt={deps.archivedAt(id())}
        shortcut={deps.shortcut(id())}
      />
    );
  };
};

/**
 * The agents a thread started, under its card (`nestedAgents`): a line of how many, open while one works or waits on the
 * person, or it or one of them is shown, unless the person folded it; each a slim row of its picture, its title (its
 * name), and its state, which opens the agent's thread.
 */
function NestedAgents(props: { deps: Deps; parent: SessionInfo; onPick: () => void }) {
  const { threads, slots } = props.deps;
  const plugin = usePlugin();
  const openAgent = plugin.action("open an agent's thread", (id: string) => threads.select(id));
  const rows = () => props.deps.agents().get(props.parent.id) ?? [];
  const agents = () => rows().map((row) => row.session);
  const [chosen, setChosen] = createSignal<boolean>();
  const waiting = (id: string) => waitingOn(slots.list(ThreadWaits), id);
  const working = () => agents().filter((agent) => threads.running().includes(agent.id) || waiting(agent.id) !== undefined).length;
  const near = () => threads.activeId() === props.parent.id || agents().some((agent) => agent.id === threads.activeId());
  const open = () => chosen() ?? (working() > 0 || near());
  return (
    <Show when={agents().length > 0}>
      <div class="thread-agents">
        <button type="button" class="thread-agents-toggle" aria-expanded={open()} onClick={() => setChosen(!open())}>
          <span class="thread-agents-chevron" aria-hidden="true">
            <ChevronDownIcon />
          </span>
          <span>
            {agents().length} {agents().length === 1 ? "agent" : "agents"}
          </span>
          <Show when={working() > 0}>
            <span class="thread-agents-working">· {working()} working</span>
          </Show>
        </button>
        <Show when={open()}>
          <ul class="thread-agents-rows">
            <For each={rows()}>
              {({ session: agent, level }) => (
                <li style={{ "--agent-level": level - 1 }}>
                  <button
                    type="button"
                    class="thread-agent"
                    classList={{ active: threads.activeId() === agent.id }}
                    aria-current={threads.activeId() === agent.id ? "page" : undefined}
                    data-session-row
                    data-tip={sessionTitle(agent)}
                    onPointerEnter={() => threads.preload(agent.id)}
                    onClick={() => {
                      openAgent(agent.id);
                      props.onPick();
                    }}
                  >
                    <Avatar seed={agent.id} size={16} />
                    <span class="thread-agent-title">{sessionTitle(agent)}</span>
                    <Status
                      session={agent}
                      active={threads.activeId() === agent.id}
                      running={threads.running().includes(agent.id)}
                      runningSince={props.deps.runningSince(agent.id)}
                      unread={props.deps.unread().has(agent.id)}
                      waiting={waiting(agent.id)}
                      drafted={false}
                      now={props.deps.now()}
                      href={threads.href(agent.id)}
                      select={() => void threads.select(agent.id)}
                      rename={() => {}}
                      actions={[]}
                      project=""
                    />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}

/** A new thread left mid-prompt: the prompt's first line and its project; under the pointer, Discard deletes it. */
function DraftRow(props: {
  session: SessionInfo;
  draft: ThreadDraft | undefined;
  project: string;
  active: boolean;
  href: string;
  select: () => void;
  discard: () => void;
}) {
  const preview = () => {
    const line = props.draft?.text.trim().split("\n", 1)[0] ?? "";
    const images = props.draft?.images.length ?? 0;
    return line !== "" ? line : images > 0 ? `${images} image${images === 1 ? "" : "s"}` : "New thread";
  };
  return (
    <div class="thread-row draft" classList={{ active: props.active }} style={{ "--hover-room": `${DISCARD_ROOM}px` }}>
      <a
        class="thread-open"
        href={props.href}
        draggable={false}
        data-session-row
        aria-current={props.active ? "page" : undefined}
        aria-label={`Unsent prompt: ${preview()}`}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          props.select();
        }}
      >
        <span class="thread-line">
          <span class="thread-drafted">
            <PenSquareIcon />
          </span>
          <span class="thread-title">{preview()}</span>
        </span>
        <span class="thread-meta">
          <span class="thread-place">
            <span class="thread-project">{props.project}</span>
          </span>
          <span class="thread-when">Draft</span>
        </span>
      </a>
      <span class="thread-hover">
        <button class="thread-hover-button thread-archive" aria-label={`Discard ${preview()}`} onClick={() => props.discard()}>
          <XIcon />
          Discard
        </button>
      </span>
    </div>
  );
}

/** Moves focus between rows with ↑ and ↓. */
const rowKeys = (event: KeyboardEvent): void => {
  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (step === 0) return;
  const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-session-row]")];
  const index = rows.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, index + step))]?.focus();
};

function Sidebar(props: { deps: Deps; onPick: () => void }) {
  const { threads, slots, webPlugins, layout } = props.deps;
  const keysOf = (id: string) => shownKeysOf(slots, webPlugins.list(), id);
  const row = rowOf(props.deps, props.onPick);
  const [archivedOpen, setArchivedOpen] = createSignal(loadJson(ARCHIVED_OPEN_KEY, false, (value): value is boolean => typeof value === "boolean"));
  const toggleArchived = () => {
    setArchivedOpen(!archivedOpen());
    save(ARCHIVED_OPEN_KEY, JSON.stringify(archivedOpen()));
  };
  /** The archived rows shown: all of them while open, scrolling in the panel; the open thread among them always. */
  const archivedRows = createMemo(() => {
    const all = props.deps.lists().archived;
    return archivedOpen() ? all : all.filter((session) => session.id === threads.activeId());
  });

  // Dragging: the arrangement holds the list as dragged until the drop lands.
  const arrangement = createArrangement(props.deps);

  // The archived panel's height, as its top edge was dragged to, kept; within what leaves the list above room.
  const [archivedHeight, setArchivedHeight] = createSignal(
    loadJson(ARCHIVED_HEIGHT_KEY, ARCHIVED_HEIGHT, (value): value is number => typeof value === "number"),
  );
  let area: HTMLDivElement | undefined;
  const fitHeight = (height: number) => Math.round(Math.max(ARCHIVED_MIN, Math.min(height, (area?.clientHeight ?? 600) - LIST_MIN)));
  const keepHeight = (height: number) => {
    setArchivedHeight(fitHeight(height));
    save(ARCHIVED_HEIGHT_KEY, JSON.stringify(archivedHeight()));
  };
  const resizeArchived = (event: PointerEvent) => {
    const startY = event.clientY;
    const startHeight = fitHeight(archivedHeight());
    dragEdge(event, {
      move: (moved) => setArchivedHeight(fitHeight(startHeight - (moved.clientY - startY))),
      end: () => keepHeight(archivedHeight()),
    });
  };

  /**
   * The archived, in a panel of their own at the foot: it scrolls, its top edge resizes it, and a thread dropped on it is
   * archived. It is there with none archived too, so its fold stays as it was left rather than reappearing open.
   */
  const ArchivedPanel = () => {
    const zone = useDroppable({ id: Heads.archived });
    const count = () => props.deps.lists().archived.length;
    return (
      <section
        ref={zone.ref}
        class="archived-panel"
        classList={{ open: archivedOpen(), target: arrangement.toArchive() }}
        aria-label="Archived threads"
        // As kept: the stylesheet caps it, so the list above keeps room in a shorter window.
        style={archivedOpen() ? { height: `${Math.max(ARCHIVED_MIN, archivedHeight())}px` } : undefined}
      >
        <Show when={archivedOpen()}>
          <div
            class="archived-edge"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize archived threads"
            aria-valuenow={archivedHeight()}
            tabIndex={0}
            onPointerDown={resizeArchived}
            onDblClick={() => keepHeight(ARCHIVED_HEIGHT)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowUp" ? ARCHIVED_STEP : event.key === "ArrowDown" ? -ARCHIVED_STEP : 0;
              if (step === 0) return;
              event.preventDefault();
              keepHeight(archivedHeight() + step);
            }}
          />
        </Show>
        <button class="archived-head" aria-expanded={archivedOpen()} onClick={toggleArchived}>
          <span>{archivedOpen() || arrangement.heads() || count() === 0 ? "Archived" : `Archived (${count()})`}</span>
          <span class="archived-rule" />
          <ChevronDownIcon />
        </button>
        <Show when={arrangement.heads() && (!archivedOpen() || count() === 0)}>
          <span class="thread-head-slot">Drop here to archive</span>
        </Show>
        <Show when={archivedOpen() && count() === 0 && !arrangement.heads()}>
          <p class="archived-panel-empty">No archived threads</p>
        </Show>
        <ul class="thread-section archived-rows">
          <For each={archivedRows().map((session) => session.id)}>
            {(id) => <Show when={arrangement.sessionOf(id)}>{(session) => <li data-section="archived">{row(session)}</li>}</Show>}
          </For>
        </ul>
      </section>
    );
  };
  return (
    <nav class="sidebar" aria-label="Threads">
      <div class="sidebar-head">
        <button
          class="icon-button"
          aria-label="Toggle sidebar"
          data-tip={withKeys("Toggle sidebar", keysOf("shell.toggle-sidebar"))}
          onClick={() => layout.toggleSidebar()}
        >
          <SidebarIcon />
        </button>
        <span class="spacer" />
        <div class="sidebar-actions">
          <Each slot={SidebarActions} props={{ onPick: props.onPick }} />
        </div>
      </div>
      <div class="thread-list" classList={{ dragging: arrangement.dragging() !== undefined }} onKeyDown={rowKeys} ref={area}>
        <SortableThreads axis="y" list={() => area} arrangement={arrangement}>
          <div class="thread-main">
            <Show when={props.deps.drafts().length > 0}>
              <ul class="thread-section drafts" aria-label="Unsent prompts">
                <For each={props.deps.drafts()}>
                  {(session) => (
                    <li>
                      <DraftRow
                        session={session}
                        draft={threads.drafts().get(session.id)}
                        project={props.deps.place(session.cwd).project}
                        active={threads.activeId() === session.id}
                        href={threads.href(session.id)}
                        select={() => {
                          void threads.select(session.id);
                          props.onPick();
                        }}
                        discard={() => {
                          threads.setDraft(session.id, undefined);
                          void threads.remove(session.id);
                        }}
                      />
                    </li>
                  )}
                </For>
              </ul>
              <div class="drafts-rule" aria-hidden="true" />
            </Show>
            <ul class="thread-section sorted">
              <For each={arrangement.items().filter((id) => id !== Heads.archived)}>
                {(id, index) => (
                  <Show
                    when={id === Heads.pinned || id === Heads.active}
                    fallback={
                      <Show when={arrangement.sessionOf(id)}>
                        {(session) => (
                          <SortableItem id={id} index={index()} section={arrangement.sectionOf(id)}>
                            {row(session)}
                            <NestedAgents deps={props.deps} parent={session()} onPick={props.onPick} />
                            <Show when={arrangement.dragging() === id ? arrangement.verb() : undefined}>
                              {(word) => <span class="drop-verb">{verbs[word()]()}</span>}
                            </Show>
                          </SortableItem>
                        )}
                      </Show>
                    }
                  >
                    <SortableItem id={id} index={index()} section={arrangement.sectionOf(id)} head class={`thread-head ${id.slice("head:".length)}`}>
                      <Show when={arrangement.heads()}>
                        <span class="thread-head-label" classList={{ target: arrangement.target() === arrangement.sectionOf(id) }}>
                          {id === Heads.pinned ? "Pinned" : "Active"}
                        </span>
                      </Show>
                    </SortableItem>
                  </Show>
                )}
              </For>
            </ul>
          </div>
          <ArchivedPanel />
        </SortableThreads>
      </div>
      <div class="sidebar-foot">
        <Each slot={SidebarFooter} props={{ onPick: props.onPick }} />
      </div>
    </nav>
  );
}

const isTimes = recordOf((item): item is number => typeof item === "number");
const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The marks kept, as far as they read: kept before threads had an order, they have none. */
const loadMarks = (): Marks => {
  const kept = loadJson<Record<string, unknown>>(
    MARKS_KEY,
    {},
    recordOf((_): _ is unknown => true),
  );
  return {
    archivedAt: isTimes(kept.archivedAt) ? kept.archivedAt : {},
    unarchivedAt: isTimes(kept.unarchivedAt) ? kept.unarchivedAt : {},
    pinnedOrder: isIds(kept.pinnedOrder) ? kept.pinnedOrder : [],
    activeOrder: isIds(kept.activeOrder) ? kept.activeOrder : [],
  };
};

/**
 * Every thread down the sidebar, as T3 Code lists them, in two kinds: the active ones (pinned first, then the newest
 * made or unarchived on top, a running one staying put), each a card with its project, state, title, and branch; and
 * the archived ones, folded away below. A card under the pointer archives it in a click (an archived one unarchives).
 * Search narrows the list by title and project.
 */
export default defineWebPlugin({
  id: "frame.threads",
  formerly: ["frame.sidebar"],
  styles,
  requires: {
    threads: Threads,
    slots: Slots,
    webPlugins: WebPlugins,
    layout: Layout,
    workspace: Workspace,
    interactions: Interactions,
  },
  setup: ({ threads, slots, webPlugins, layout, workspace, interactions }, plugin) => {
    // Times tick once a second while a turn runs (its time shows), else once a minute.
    const [now, setNow] = createSignal(Date.now());
    createEffect(() => {
      const ms = threads.running().length > 0 ? 1000 : 60_000;
      onCleanup(plugin.every(ms, () => setNow(Date.now())));
    });

    const [marks, setMarksRaw] = createSignal<Marks>(loadMarks());
    const setMarks = (next: Marks) => {
      if (next === untrack(marks)) return;
      setMarksRaw(next);
      save(MARKS_KEY, JSON.stringify(next));
    };
    // Threads pinned, archived, and back again, here or anywhere (their menu, another window), take their places in the
    // order; gone ones' marks go with them.
    let flags: ReadonlyMap<string, Flags> | undefined;
    createEffect(() => {
      if (!threads.loaded()) return;
      const now = flagsOf(threads.list());
      const was = flags ?? now;
      flags = now;
      setMarks(transitioned(untrack(marks), was, now, Date.now()));
    });
    const lists = createMemo(() => sections(threads.list(), marks()));
    const agents = createMemo(() => nestedAgents(threads.list()));
    /** The threads ⌘1 … ⌘9 and stepping go through: as listed, pinned first, the archived not among them. */
    const order = () => [...lists().pinned, ...lists().active];
    // While ⌘ is held alone (`onHold`), the first nine show the keys that go to them.
    const [holding, setHolding] = createSignal<Readonly<Record<number, string>>>({});
    const shortcuts = createMemo((): ReadonlyMap<string, string> => {
      const keys = holding();
      if (Object.keys(keys).length === 0) return new Map();
      return new Map(
        order()
          .slice(0, 9)
          .flatMap((session, index) => {
            const binding = keys[index + 1];
            return binding === undefined ? [] : [[session.id, formatKeys(binding)] as const];
          }),
      );
    });
    /** The new thread shown, when it was a draft as it was opened: it stays among the drafts while it shows. */
    const held = createMemo(
      on(threads.activeId, (id) =>
        id !== undefined && threads.drafts().has(id) && threads.list().find((session) => session.id === id)?.lastSeq === 0 ? id : undefined,
      ),
    );
    const drafts = createMemo(() => draftRows(threads.list(), (id) => threads.drafts().has(id), threads.activeId(), held()));

    // A turn that ends while another thread is open leaves its thread unread until it is opened; a turn's start is
    // kept for its time.
    const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set());
    const [since, setSince] = createSignal<Readonly<Record<string, number>>>({});
    createEffect(
      on(threads.running, (running, before) => {
        const ended = (before ?? []).filter((id) => !running.includes(id));
        const started = running.filter((id) => !(before ?? []).includes(id));
        if (ended.length > 0) setUnread(new Set([...unread(), ...ended.filter((id) => id !== threads.activeId())]));
        if (ended.length > 0 || started.length > 0)
          setSince(Object.fromEntries([...Object.entries(since()).filter(([id]) => running.includes(id)), ...started.map((id) => [id, Date.now()] as const)]));
      }),
    );
    createEffect(() => {
      const id = threads.activeId();
      if (id === undefined || !untrack(unread).has(id)) return;
      const next = new Set(untrack(unread));
      next.delete(id);
      setUnread(next);
    });

    // Where each thread works: its project (a worktree's is its repository's), and the branch its folder has checked out.
    const place = (cwd: string) => {
      const known = workspace.place(cwd);
      return {
        project: workspace.isStandalone(cwd) ? "No project" : workspace.projectName(cwd),
        ...(known?.branch === undefined || known.branch === null ? {} : { branch: known.branch }),
        worktree: known?.worktree === true,
      };
    };

    // Archiving the thread shown goes on to the next one; one unarchived goes to the top (`transitioned`).
    const archive = async (session: SessionInfo): Promise<void> => {
      if (session.archived === true) return;
      const shown = threads.activeId() === session.id;
      const next = shown ? afterArchiving(order(), session.id) : undefined;
      const marking = threads.mark(session.id, { archived: true });
      if (shown) void (next !== undefined ? threads.select(next) : threads.newThread(workspace.projectOf(session.cwd)));
      await marking;
    };
    const unarchive = (session: SessionInfo) => void threads.mark(session.id, { archived: false });
    const pin = (session: SessionInfo, pinned: boolean) => void threads.mark(session.id, { pinned });
    const drop = async (session: SessionInfo, next: Marks, change: SessionMarks | undefined): Promise<void> => {
      setMarks(next);
      if (change === undefined) return;
      if (change.archived === true) return archive(session);
      await threads.mark(session.id, change);
    };

    const deps: Deps = {
      threads,
      slots,
      webPlugins,
      layout,
      workspace,
      now,
      lists,
      agents,
      unread,
      runningSince: (id) => since()[id],
      place,
      archive: (session) => void archive(session),
      unarchive,
      pin,
      archivedAt: (id) => marks().archivedAt[id],
      drafts,
      drop,
      marks,
      shortcut: (id) => shortcuts().get(id),
    };
    slots.add(SidebarRegion, { id: "sidebar", phase: "default", component: (props) => <Sidebar deps={deps} onPick={props.onPick} /> });
    slots.add(SidebarRowPart, { id: "sidebar.row", phase: "default", component: ThreadRow });

    // A question a turn asked the host to put (an approval, a choice, a value) waits on the person in its thread.
    slots.add(ThreadWaits, {
      id: "sidebar.questions",
      order: 100,
      waiting: (sessionId) => {
        const request = interactions.open().find((open) => open.origin === `session:${sessionId}`);
        return request === undefined ? undefined : request.type === "ask" ? "Needs input" : "Needs approval";
      },
    });

    // Its head's buttons, across from the toggle: the palette, search in the palette's thread search, and a new thread.
    const keysOf = (id: string) => shownKeysOf(slots, webPlugins.list(), id);
    const newThread = plugin.action("start a new thread", () => threads.newThread());
    slots.add(SidebarActions, {
      id: "sidebar.palette",
      order: 5,
      component: (props) => (
        <Show when={slots.get(Actions, ActionIds.palette)}>
          {(palette) => (
            <button
              class="icon-button"
              aria-label="Command palette"
              data-tip={withKeys("Command palette", keysOf(ActionIds.palette))}
              onClick={() => {
                palette().run();
                props.onPick();
              }}
            >
              <CommandIcon />
            </button>
          )}
        </Show>
      ),
    });
    slots.add(SidebarActions, {
      id: "sidebar.search",
      order: 10,
      component: (props) => (
        <Show when={slots.get(Actions, ActionIds.searchThreads)}>
          {(search) => (
            <button
              class="icon-button"
              aria-label="Search threads"
              data-tip={withKeys("Search threads", keysOf(ActionIds.searchThreads))}
              onClick={() => {
                search().run();
                props.onPick();
              }}
            >
              <SearchIcon />
            </button>
          )}
        </Show>
      ),
    });
    slots.add(SidebarActions, {
      id: "sidebar.new-thread",
      order: 20,
      component: (props) => (
        <button
          class="icon-button"
          aria-label="New thread"
          data-tip={withKeys("New thread", keysOf("thread.new-chat"))}
          onClick={() => {
            newThread();
            props.onPick();
          }}
        >
          <PenSquareIcon />
        </button>
      ),
    });

    // Moving through the threads and archiving them, from the keyboard and the palette; Settings › Keyboard rebinds these.
    const add = (id: string, order: number, action: Omit<Action, "category">) => slots.add(Actions, { id, order, category: "Thread", ...action });
    const step = (by: number) => () => {
      const next = stepFrom(order(), threads.activeId(), by);
      if (next !== undefined) void threads.select(next);
    };
    // The keys a browser keeps for its tabs work in a web page too (`inPages`).
    add("sidebar.next-thread", 20, { title: "Next thread", keys: "mod+shift+]", whileTyping: true, inPages: true, run: step(1) });
    add("sidebar.previous-thread", 21, { title: "Previous thread", keys: "mod+shift+[", whileTyping: true, inPages: true, run: step(-1) });
    // mod+1 … mod+9: the thread at that place in the list, pinned ones first.
    for (let at = 1; at <= 9; at++)
      add(`sidebar.thread-${at}`, 30 + at, {
        title: `Go to thread ${at}`,
        keys: `mod+${at}`,
        whileTyping: true,
        inPages: true,
        hidden: true,
        when: () => order().length >= at,
        run: () => void threads.select(order()[at - 1]!.id),
        onHold: (binding) => {
          const { [at]: _, ...rest } = holding();
          setHolding(binding === undefined ? rest : { ...rest, [at]: binding });
        },
      });
    add("sidebar.archive-thread", 22, {
      title: "Archive or unarchive thread",
      detail: "Archived, it goes below and the next thread shows; unarchived, it goes back on top",
      icon: ArchiveIcon,
      keys: "mod+alt+a",
      whileTyping: true,
      when: () => {
        const session = threads.active();
        return session !== undefined && session.lastSeq > 0;
      },
      run: () => {
        const session = threads.active();
        if (session === undefined) return;
        if (session.archived === true) unarchive(session);
        else void archive(session);
      },
    });
    /**
     * The thread that needs the person `by` places on, going round: one listed that waits on them (`ThreadWaits`) or
     * finished unseen, or an agent under one that waits on them (a finished agent does not: its thread goes on with what it did).
     */
    const needing = (by: 1 | -1) => {
      const nested = new Set<string>();
      const listed = order().flatMap((session) => {
        const under = (agents().get(session.id) ?? []).map((row) => row.session);
        for (const agent of under) nested.add(agent.id);
        return [session, ...under];
      });
      const waits = slots.list(ThreadWaits);
      return nextNeeding(
        listed,
        threads.activeId(),
        by,
        (session) =>
          waitingOn(waits, session.id) !== undefined || (!nested.has(session.id) && unread().has(session.id) && !threads.running().includes(session.id)),
      );
    };
    const goNeeding = (by: 1 | -1) => () => {
      const next = needing(by);
      if (next !== undefined) void threads.select(next);
    };
    // Alt+Shift+↓ and ↑, as Slack and Discord step through what is unread; with none, the keys stay the field's.
    add("sidebar.next-needing", 23, {
      title: "Next thread that needs you",
      keywords: ["waiting", "unread", "done", "input", "approval", "attention"],
      keys: "alt+shift+arrowdown",
      whileTyping: true,
      when: () => needing(1) !== undefined,
      run: goNeeding(1),
    });
    add("sidebar.previous-needing", 24, {
      title: "Previous thread that needs you",
      keywords: ["waiting", "unread", "done", "input", "approval", "attention"],
      keys: "alt+shift+arrowup",
      whileTyping: true,
      when: () => needing(-1) !== undefined,
      run: goNeeding(-1),
    });
  },
});
