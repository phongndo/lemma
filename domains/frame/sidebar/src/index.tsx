import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { DragDropProvider, PointerSensor, useDroppable } from "@dnd-kit/solid";
import { useSortable } from "@dnd-kit/solid/sortable";
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import type { SessionInfo, SessionMarks } from "@lemma/sessions";
import { formatKeys, withKeys } from "@lemma/web/keys";
import { loadJson, recordOf, save } from "@lemma/web/storage";
import { dragEdge } from "@lemma/web/drag";
import { ActionIds, Actions, shownKeysOf } from "@lemma/actions";
import { sessionTitle, ThreadActions, Threads, SidebarRowPart, SidebarRow } from "@lemma/threads";
import { ActionMenu, inDesktop, Layout, SidebarActions, SidebarFooter, SidebarRegion } from "@lemma/frame";
import type { LayoutService } from "@lemma/frame";
import { Workspace } from "@lemma/workspace/web";
import { Slots, WebPlugins, defineWebPlugin, Each, usePlugin } from "@lemma/web";
import type { Action } from "@lemma/actions";
import type { SidebarRowProps, ThreadAttention, ThreadDraft, ThreadsService } from "@lemma/threads";
import type { SlotsService } from "@lemma/web";
import {
  AlertIcon,
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
import {
  Heads,
  afterArchiving,
  dragItems,
  dragTo,
  draftRows,
  dropVerb,
  dropped,
  flagsOf,
  nestedAgents,
  nextNeeding,
  runTime,
  sectionIn,
  sections,
  shortAge,
  stepFrom,
  transitioned,
} from "./list.ts";
import type { DropVerb, Flags, Marks, NestedAgent, Section } from "./list.ts";
import styles from "./sidebar.css?inline";

const MARKS_KEY = "lemma.frame.sidebar.marks";
const ARCHIVED_OPEN_KEY = "lemma.frame.sidebar.archived-open";
/** The archived panel's height (px), as dragged and kept: at first, at least, and by a key's step; the list above keeps at least `LIST_MIN`. */
const ARCHIVED_HEIGHT_KEY = "lemma.frame.sidebar.archived-height";
const ARCHIVED_HEIGHT = 220;
const ARCHIVED_MIN = 96;
const ARCHIVED_STEP = 24;
const LIST_MIN = 120;
/** How long the pointer rests on a row before its details show, and how soon after one closes the next opens at once. */
const CARD_DELAY = 150;
const CARD_CHAIN = 400;

/** When a row's details last closed, so pointing at the next one shows its own at once. */
let cardClosedAt = 0;

/**
 * Its state where the time goes, as T3 Code shows it, the most pressing first: what it waits on the person for, a
 * running turn and its time, a turn that failed or finished and is not yet seen; else how long ago it was used.
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
    <Match when={props.attention?.state === "failed" ? props.attention.label : undefined}>
      {(label) => (
        <span class="thread-when thread-state" data-state="failed" role="status">
          <AlertIcon />
          {label()}
        </span>
      )}
    </Match>
    <Match when={props.unread}>
      <span class="thread-when thread-state" data-state="done" role="status">
        <CheckIcon />
        Done
      </span>
    </Match>
  </Switch>
);

/** What a row says of its state in its details: at work, archived, a turn's end not yet seen, or its last use. */
const stateWords = (props: SidebarRowProps, archived: boolean): string =>
  props.running
    ? "Working"
    : archived
      ? "Archived"
      : props.attention?.state === "failed"
        ? `${props.attention.label}, not yet seen`
        : props.unread
          ? "Finished, not yet seen"
          : "Last used";

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
  const plugin = usePlugin();
  const [editing, setEditing] = createSignal(false);
  const [details, setDetails] = createSignal<DOMRect>();
  let row!: HTMLDivElement;
  let openMenu: (() => void) | undefined;
  let waiting: (() => void) | undefined;
  const archived = () => props.session.archived === true;
  /** What its age counts from: its archiving once archived, else its last use. */
  const since = () => (archived() ? (props.archivedAt ?? props.session.updatedAt) : props.session.updatedAt);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) props.rename(value);
  };
  const point = () => {
    waiting?.();
    const show = () => setDetails(row.getBoundingClientRect());
    if (Date.now() - cardClosedAt < CARD_CHAIN) show();
    else waiting = plugin.after(CARD_DELAY, show);
  };
  const leave = () => {
    waiting?.();
    waiting = undefined;
    if (details() !== undefined) cardClosedAt = Date.now();
    setDetails(undefined);
  };
  onCleanup(leave);
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
              <div
                class="thread-details"
                // Level with the row; near the window's foot it grows upward from the row's bottom instead.
                style={
                  at().top + 200 > window.innerHeight
                    ? { left: `${at().right + 6}px`, bottom: `${window.innerHeight - at().bottom}px` }
                    : { left: `${at().right + 6}px`, top: `${at().top}px` }
                }
                aria-hidden="true"
              >
                <div class="thread-details-title">{title()}</div>
                <div class="thread-details-line">{props.project}</div>
                <Show when={props.branch}>
                  {(branch) => (
                    <div class="thread-details-line">
                      <Show when={props.worktree} fallback={<GitBranchIcon />}>
                        <WorktreeIcon />
                      </Show>
                      {branch()}
                    </div>
                  )}
                </Show>
                <Show when={props.waiting}>{(label) => <div class="thread-details-line waiting">{label()}</div>}</Show>
                <div class="thread-details-line muted">
                  {stateWords(props, archived())}
                  {props.running && props.runningSince !== undefined ? ` for ${runTime(props.runningSince, props.now)}` : ""}
                  {props.running ? "" : ` ${shortAge(since(), props.now) === "now" ? "just now" : `${shortAge(since(), props.now)} ago`}`}
                </div>
              </div>
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

interface Deps {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly layout: LayoutService;
  readonly now: () => number;
  readonly lists: () => ReturnType<typeof sections>;
  /** Each thread's agents, and theirs, listed under it (`nestedAgents`). */
  readonly agents: () => ReadonlyMap<string, readonly NestedAgent[]>;
  /** What each thread asks of the person (`Threads.attention`). */
  readonly attention: (id: string) => ThreadAttention | undefined;
  /** What the folder `cwd` has checked out, once asked. */
  readonly place: (cwd: string) => { readonly branch?: string | undefined; readonly project: string; readonly worktree: boolean };
  readonly archive: (session: SessionInfo) => void;
  readonly unarchive: (session: SessionInfo) => void;
  readonly pin: (session: SessionInfo, pinned: boolean) => void;
  readonly archivedAt: (id: string) => number | undefined;
  /** The new threads left mid-prompt, shown above the rest. */
  readonly drafts: () => readonly SessionInfo[];
  /** A drop's new order, and the change to the thread dropped (`dropped`). */
  readonly drop: (session: SessionInfo, marks: Marks, change: SessionMarks | undefined) => Promise<void>;
  readonly marks: () => Marks;
  /** The keys that go to a thread, while all but their last are held down (`Action.onHold`). */
  readonly shortcut: (id: string) => string | undefined;
  /** The key the action `id` runs on, for a button's tip (`shownKeysOf`). */
  readonly keysOf: (id: string) => string | undefined;
}

/** A thread's row, as the `sidebar.row` part draws it: it follows the thread as it changes. */
const rowOf = (deps: Deps, onPick: () => void) => {
  const { threads, slots } = deps;
  const actionsFor = (session: SessionInfo) => slots.list(ThreadActions).filter((action) => action.when?.(session) ?? true);
  return (session: () => SessionInfo) => {
    const id = () => session().id;
    const running = () => threads.running().includes(id());
    const place = () => deps.place(session().cwd);
    const attention = () => deps.attention(id());
    return (
      <SidebarRow
        session={session()}
        active={threads.activeId() === id()}
        running={running()}
        runningSince={attention()?.state === "working" ? attention()?.since : undefined}
        unread={attention()?.state === "done" || attention()?.state === "failed"}
        attention={attention()}
        waiting={attention()?.state === "waiting" ? attention()?.label : undefined}
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

/** The words a dragged thread shows for what dropping it where it is would do. */
const verbs: Readonly<Record<DropVerb, () => JSX.Element>> = {
  pin: () => (
    <>
      <PinIcon />
      Pin
    </>
  ),
  unpin: () => (
    <>
      <PinOffIcon />
      Unpin
    </>
  ),
  archive: () => (
    <>
      <ArchiveIcon />
      Archive
    </>
  ),
  unarchive: () => (
    <>
      <RedoIcon />
      Unarchive
    </>
  ),
};

/**
 * The agents a thread started, under its card (`nestedAgents`): a line of how many, open while one works or waits on the
 * person, or it or one of them is shown, unless the person folded it; each a slim row of its picture, its title (its
 * name), and its state, which opens the agent's thread.
 */
function NestedAgents(props: { deps: Deps; parent: SessionInfo; onPick: () => void }) {
  const { threads } = props.deps;
  const plugin = usePlugin();
  const openAgent = plugin.action("open an agent's thread", (id: string) => threads.select(id));
  const rows = () => props.deps.agents().get(props.parent.id) ?? [];
  const agents = () => rows().map((row) => row.session);
  const [chosen, setChosen] = createSignal<boolean>();
  const attention = (id: string) => props.deps.attention(id);
  const waiting = (id: string) => (attention(id)?.state === "waiting" ? attention(id)?.label : undefined);
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
                      runningSince={attention(agent.id)?.state === "working" ? attention(agent.id)?.since : undefined}
                      unread={attention(agent.id)?.state === "done" || attention(agent.id)?.state === "failed"}
                      attention={attention(agent.id)}
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

/** An item of the list drag and drop arranges: a thread, which drags, or a section's head, which stays. */
function SortableItem(props: { id: string; index: number; section: Section | undefined; head?: boolean; class?: string; children: JSX.Element }) {
  const sortable = useSortable({
    get id() {
      return props.id;
    },
    get index() {
      return props.index;
    },
    get disabled() {
      return props.head === true ? { draggable: true, droppable: false } : false;
    },
  });
  return (
    <li ref={sortable.ref} class={props.class} classList={{ "drag-source": sortable.isDragSource() }} data-section={props.section}>
      {props.children}
    </li>
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

/**
 * The list's drag and drop: a thread follows the pointer up and down the list, the others make room, and where it is
 * when dropped says what the drop does (`dropped`). `over` hears each item it is dragged onto, and the list moves it
 * (`dragTo`) rather than the sortable moving rows itself. Only the pointer moves it: an item it is over goes past it
 * only while the pointer heads that way (`above` says which way the item is), so rows the sections' names push under a
 * still pointer do not move it.
 */
function SortableThreads(props: {
  list: () => HTMLElement | undefined;
  start: (id: string) => void;
  above: (id: string) => boolean | undefined;
  /** What it is dragged onto: an item, itself again, or nothing (`undefined`). */
  over: (id: string | undefined) => void;
  end: (canceled: boolean) => void;
  children: JSX.Element;
}) {
  let y: number | undefined;
  let up: boolean | undefined;
  /** The item it is over, until the pointer heads its way. */
  let waiting: string | undefined;
  const settle = () => {
    if (waiting === undefined || up === undefined) return;
    const above = props.above(waiting);
    if (above !== undefined && above !== up) return;
    props.over(waiting);
    waiting = undefined;
  };
  return (
    <DragDropProvider
      sensors={[
        PointerSensor.configure({
          activationConstraints: (event) => [new PointerActivationConstraints.Distance({ value: event.pointerType === "touch" ? 10 : 6 })],
          // Its buttons and the title being renamed keep their own pointer.
          preventActivation: (event) => event.target instanceof Element && event.target.closest("button, input") !== null,
        }),
      ]}
      modifiers={[RestrictToVerticalAxis, RestrictToElement.configure({ element: () => props.list() ?? null })]}
      plugins={(defaults) => [
        ...defaults.filter((plugin) => plugin !== Accessibility),
        AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.1 } }),
        Feedback.configure({ dropAnimation: null }),
      ]}
      onDragStart={(event) => {
        y = undefined;
        up = undefined;
        waiting = undefined;
        const source = event.operation.source;
        if (source !== null) props.start(source.id.toString());
      }}
      onDragMove={(event) => {
        const next = event.operation.position.current.y;
        if (y !== undefined && next !== y) up = next < y;
        y = next;
        settle();
      }}
      onDragOver={(event) => {
        // The list moves the thread itself.
        event.preventDefault();
        waiting = event.operation.target?.id.toString();
        if (waiting === undefined) props.over(undefined);
        else settle();
      }}
      onDragEnd={(event) => props.end(event.canceled)}
    >
      {props.children}
    </DragDropProvider>
  );
}

function Sidebar(props: { deps: Deps; onPick: () => void }) {
  const { threads, layout, keysOf } = props.deps;
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

  // Dragging: the list is held as dragged (`arranged`) from the drag's start to its drop's change landing, so it does
  // not move under the pointer, nor jump back while the change is on its way.
  const byId = createMemo(() => new Map(threads.list().map((session) => [session.id, session])));
  // The archived are not among the items dragged: they are in their own panel, which as a whole is a place to drop one.
  const listed = createMemo(() => dragItems(props.deps.lists().pinned, props.deps.lists().active, []));
  const [arranged, setArranged] = createSignal<readonly string[]>();
  const [drag, setDrag] = createSignal<{ readonly id: string; readonly initial: readonly string[] }>();
  /** The dragged thread is over the archived panel: dropping it archives it. */
  const [toArchive, setToArchive] = createSignal(false);
  /**
   * The sections' names show a frame after a drag starts: the dragged row is placed under the pointer first, so the
   * rows they push down move under it rather than taking it with them.
   */
  const [heads, setHeads] = createSignal(false);
  const items = () => arranged() ?? listed();
  /** The section the dragged thread is in now, where dropping it puts it: its name takes the accent. */
  const target = (): Section | undefined => {
    const current = drag();
    if (current === undefined) return undefined;
    return toArchive() ? "archived" : sectionIn(items(), current.id);
  };
  /** What dropping the dragged thread where it is now would do. */
  const verb = () => {
    const current = drag();
    return current === undefined ? undefined : dropVerb(sectionIn(current.initial, current.id), target());
  };
  /** The items with the dragged thread among the archived (after their head, last): what dropping on the panel does. */
  const archivedWith = (id: string) => [...items().filter((item) => item !== id), id];

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
        classList={{ open: archivedOpen(), target: toArchive() }}
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
          <span>{archivedOpen() || heads() || count() === 0 ? "Archived" : `Archived (${count()})`}</span>
          <span class="archived-rule" />
          <ChevronDownIcon />
        </button>
        <Show when={heads() && (!archivedOpen() || count() === 0)}>
          <span class="thread-head-slot">Drop here to archive</span>
        </Show>
        <Show when={archivedOpen() && count() === 0 && !heads()}>
          <p class="archived-panel-empty">No archived threads</p>
        </Show>
        <ul class="thread-section archived-rows">
          <For each={archivedRows().map((session) => session.id)}>
            {(id) => <Show when={sessionOf(id)}>{(session) => <li data-section="archived">{row(session)}</li>}</Show>}
          </For>
        </ul>
      </section>
    );
  };
  const sessionOf = (id: string) => byId().get(id);
  /** Each item's section, where it is now (`data-section` on its row). */
  const sectionsOf = createMemo(() => {
    const of = new Map<string, Section>();
    let section: Section = "pinned";
    for (const id of items()) {
      if (id === Heads.active) section = "active";
      else if (id === Heads.archived) section = "archived";
      of.set(id, section);
    }
    return of;
  });
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
      <div class="thread-list" classList={{ dragging: drag() !== undefined }} onKeyDown={rowKeys} ref={area}>
        <SortableThreads
          list={() => area}
          start={(id) => {
            setToArchive(false);
            setDrag({ id, initial: items() });
            requestAnimationFrame(() => setHeads(drag()?.id === id));
          }}
          above={(over) => {
            const current = drag();
            if (current === undefined || over === current.id) return undefined;
            return items().indexOf(over) < items().indexOf(current.id);
          }}
          over={(over) => {
            const current = drag();
            if (current === undefined) return;
            setToArchive(over === Heads.archived);
            if (over !== undefined && over !== Heads.archived) setArranged(dragTo(items(), current.initial, current.id, over));
          }}
          end={(canceled) => {
            const current = drag();
            const at = toArchive() && current !== undefined ? archivedWith(current.id) : arranged();
            setDrag(undefined);
            setHeads(false);
            setToArchive(false);
            const session = current === undefined ? undefined : sessionOf(current.id);
            if (canceled || current === undefined || at === undefined || session === undefined) return void setArranged(undefined);
            const drop = dropped(props.deps.marks(), current.initial, at, current.id, session.pinned === true);
            void props.deps.drop(session, drop.marks, drop.change).finally(() => setArranged(undefined));
          }}
        >
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
              <For each={items().filter((id) => id !== Heads.archived)}>
                {(id, index) => (
                  <Show
                    when={id === Heads.pinned || id === Heads.active}
                    fallback={
                      <Show when={sessionOf(id)}>
                        {(session) => (
                          <SortableItem id={id} index={index()} section={sectionsOf().get(id)}>
                            {row(session)}
                            <NestedAgents deps={props.deps} parent={session()} onPick={props.onPick} />
                            <Show when={drag()?.id === id ? verb() : undefined}>{(word) => <span class="drop-verb">{verbs[word()]()}</span>}</Show>
                          </SortableItem>
                        )}
                      </Show>
                    }
                  >
                    <SortableItem id={id} index={index()} section={sectionsOf().get(id)} head class={`thread-head ${id.slice("head:".length)}`}>
                      <Show when={heads()}>
                        <span class="thread-head-label" classList={{ target: target() === sectionsOf().get(id) }}>
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
  id: "frame.sidebar",
  styles,
  requires: {
    threads: Threads,
    slots: Slots,
    webPlugins: WebPlugins,
    layout: Layout,
    workspace: Workspace,
  },
  setup: ({ threads, slots, webPlugins, layout, workspace }, plugin) => {
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

    const attention = (id: string) => threads.attention().get(id);

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

    const keysOf = (id: string) => shownKeysOf(slots, webPlugins.list(), id);
    const deps: Deps = {
      threads,
      slots,
      layout,
      now,
      lists,
      agents,
      attention,
      place,
      archive: (session) => void archive(session),
      unarchive,
      pin,
      archivedAt: (id) => marks().archivedAt[id],
      drafts,
      drop,
      marks,
      shortcut: (id) => shortcuts().get(id),
      keysOf,
    };
    slots.add(SidebarRegion, { id: "sidebar", phase: "default", component: (props) => <Sidebar deps={deps} onPick={props.onPick} /> });
    slots.add(SidebarRowPart, { id: "sidebar.row", phase: "default", component: ThreadRow });

    // Its head's buttons, across from the toggle: the palette, search in the palette's thread search, and a new thread.
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
    // The keys a browser keeps for its tabs: in the desktop app only (`inDesktop`), where a web page hands them on too (`inPages`).
    add("sidebar.next-thread", 20, { title: "Next thread", ...(inDesktop ? { keys: "mod+shift+]" } : {}), whileTyping: true, inPages: true, run: step(1) });
    add("sidebar.previous-thread", 21, {
      title: "Previous thread",
      ...(inDesktop ? { keys: "mod+shift+[" } : {}),
      whileTyping: true,
      inPages: true,
      run: step(-1),
    });
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
     * The thread that needs the person `by` places on, going round: one listed that waits on them or failed or finished
     * unseen (`Threads.attention`), or an agent under one that waits on them (a finished agent does not: its thread goes
     * on with what it did).
     */
    const needing = (by: 1 | -1) => {
      const nested = new Set<string>();
      const listed = order().flatMap((session) => {
        const under = (agents().get(session.id) ?? []).map((row) => row.session);
        for (const agent of under) nested.add(agent.id);
        return [session, ...under];
      });
      return nextNeeding(listed, threads.activeId(), by, (session) => {
        const state = attention(session.id)?.state;
        return state === "waiting" || (!nested.has(session.id) && (state === "done" || state === "failed"));
      });
    };
    const goNeeding = (by: 1 | -1) => () => {
      const next = needing(by);
      if (next !== undefined) void threads.select(next);
    };
    // Alt+Shift+↓ and ↑, as Slack and Discord step through what is unread. In a text field they stay its own (on macOS
    // they select to a paragraph's end), whether or not a thread needs you.
    add("sidebar.next-needing", 23, {
      title: "Next thread that needs you",
      keywords: ["waiting", "unread", "done", "input", "approval", "attention"],
      keys: "alt+shift+arrowdown",
      when: () => needing(1) !== undefined,
      run: goNeeding(1),
    });
    add("sidebar.previous-needing", 24, {
      title: "Previous thread that needs you",
      keywords: ["waiting", "unread", "done", "input", "approval", "attention"],
      keys: "alt+shift+arrowup",
      when: () => needing(-1) !== undefined,
      run: goNeeding(-1),
    });
  },
});
