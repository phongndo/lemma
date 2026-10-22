import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { useDroppable } from "@dnd-kit/solid";
import type { SessionInfo } from "@lemma/sessions";
import { withKeys } from "@lemma/web/keys";
import { shownKeysOf } from "@lemma/actions";
import { sessionTitle, ThreadActions, ThreadWaits, waitingOn } from "@lemma/threads";
import { ActionMenu, SidebarActions, SidebarFooter } from "@lemma/frame";
import { Each, usePlugin } from "@lemma/web";
import { AgentIcon, ArchiveIcon, Avatar, PenSquareIcon, PinIcon, PinOffIcon, PlusIcon, Popover, QuestionIcon, RedoIcon, Spinner, XIcon } from "@lemma/look";
import { Heads, runTime, shortAge } from "./list.ts";
import { SortableItem, SortableThreads, createArrangement, verbs } from "./sortable.tsx";
import type { Arrangement } from "./sortable.tsx";
import { ThreadDetails, createDetails } from "./details.tsx";
import type { Deps } from "./deps.ts";

/** Nothing to pick in a bar: the sidebar's slots close their drawer with it. */
const stay = () => {};

/** A plain click opens it here; with a modifier, the browser opens the link elsewhere. */
const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Moves focus between tabs with ← and →. */
const tabKeys = (event: KeyboardEvent): void => {
  const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  if (step === 0) return;
  const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-session-row]")];
  const index = tabs.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  tabs[Math.max(0, Math.min(tabs.length - 1, index + step))]?.focus();
};

/** A thread's state in words, the most pressing first, as a sidebar card says it; else how long ago `since`. */
const stateOf = (deps: Deps, session: SessionInfo, since = session.updatedAt): string => {
  const waiting = waitingOn(deps.slots.list(ThreadWaits), session.id);
  if (waiting !== undefined) return waiting;
  if (deps.threads.running().includes(session.id)) {
    const started = deps.runningSince(session.id);
    return started === undefined ? "Working" : `Working ${runTime(started, deps.now())}`;
  }
  if (deps.unread().has(session.id)) return "Done";
  return shortAge(since, deps.now());
};

/**
 * The agents a thread started, as the sidebar lists them under its card: a count on its tab (a spinner while one works
 * or waits on the person), which opens them, each its picture, its title, and its state.
 */
function AgentsChip(props: { deps: Deps; parent: SessionInfo }) {
  const { threads, slots } = props.deps;
  const plugin = usePlugin();
  const openAgent = plugin.action("open an agent's thread", (id: string) => threads.select(id));
  const rows = () => props.deps.agents().get(props.parent.id) ?? [];
  const working = () =>
    rows().filter(({ session }) => threads.running().includes(session.id) || waitingOn(slots.list(ThreadWaits), session.id) !== undefined).length;
  const label = () => `${rows().length} ${rows().length === 1 ? "agent" : "agents"}${working() > 0 ? `, ${working()} working` : ""}`;
  return (
    <Show when={rows().length > 0}>
      <Popover
        label={label()}
        triggerClass="tab-agents"
        placement="bottom-start"
        menuClass="tab-menu"
        trigger={
          <>
            <Show when={working() > 0} fallback={<AgentIcon />}>
              <Spinner />
            </Show>
            {rows().length}
          </>
        }
      >
        {(close) => (
          <>
            <div class="menu-section">{label()}</div>
            <For each={rows()}>
              {({ session: agent, level }) => (
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item tab-menu-agent"
                  style={{ "--agent-level": level - 1 }}
                  aria-current={threads.activeId() === agent.id ? "page" : undefined}
                  onPointerEnter={() => threads.preload(agent.id)}
                  onClick={() => {
                    openAgent(agent.id);
                    close();
                  }}
                >
                  <Avatar seed={agent.id} size={16} />
                  <span class="menu-label">{sessionTitle(agent)}</span>
                  <span class="menu-hint">{stateOf(props.deps, agent)}</span>
                </button>
              )}
            </For>
          </>
        )}
      </Popover>
    </Show>
  );
}

/**
 * A thread as a tab: what it waits on, its turn running, a finished one unseen, an unsent prompt, or its pin, then its
 * title and the agents it started. Under the pointer it offers to pin (or unpin) it, and × archives it (one archived,
 * open while listed nowhere else, offers to unarchive it); after a moment its details show under it. While `mod` is
 * held alone, its keys show where those go. A right-click opens its menu, a double-click renames it. One `transient`
 * is the thread shown while listed nowhere else (new, archived, an agent's), and is a tab only while it shows.
 */
function ThreadTab(props: { deps: Deps; session: SessionInfo; transient?: boolean }) {
  const { threads, slots, webPlugins } = props.deps;
  const plugin = usePlugin();
  const open = plugin.action("open a thread", (id: string) => threads.select(id));
  const rename = plugin.action("rename a thread", (id: string, title: string) => threads.rename(id, title));
  const [editing, setEditing] = createSignal(false);
  const { at: details, point, leave } = createDetails();
  let tab!: HTMLDivElement;
  let openMenu: (() => void) | undefined;
  const keysOf = (action: string) => shownKeysOf(slots, webPlugins.list(), action);
  const id = () => props.session.id;
  const active = () => threads.activeId() === id();
  const archived = () => props.session.archived === true;
  const waiting = () => waitingOn(slots.list(ThreadWaits), id());
  const running = () => threads.running().includes(id());
  const unread = () => props.deps.unread().has(id());
  const drafted = () => !active() && threads.drafts().has(id());
  const pinned = () => props.session.pinned === true && !archived();
  const blank = () => active() && threads.blank();
  const title = () => (blank() ? "New thread" : sessionTitle(props.session));
  const place = () => props.deps.place(props.session.cwd);
  /** What its age counts from: its archiving once archived, else its last use. */
  const since = () => (archived() ? (props.deps.archivedAt(id()) ?? props.session.updatedAt) : props.session.updatedAt);
  const actions = () => slots.list(ThreadActions).filter((action) => action.when?.(props.session) ?? true);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) rename(id(), value);
  };
  return (
    <Show
      when={editing()}
      fallback={
        <div
          ref={tab}
          class="tab"
          classList={{ active: active(), drafted: drafted(), pinned: pinned(), transient: props.transient === true }}
          onPointerEnter={() => !blank() && point(tab)}
          onPointerLeave={leave}
          onPointerDown={leave}
          onContextMenu={(event) => {
            leave();
            if (actions().length === 0) return;
            event.preventDefault();
            openMenu?.();
          }}
        >
          <a
            class="tab-open"
            href={threads.href(id())}
            draggable={false}
            data-session-row
            aria-current={active() ? "page" : undefined}
            onClick={(event) => {
              if (!plainClick(event)) return;
              event.preventDefault();
              open(id());
            }}
            onDblClick={() => !blank() && setEditing(true)}
          >
            <Switch>
              <Match when={waiting()}>
                <span class="tab-mark" data-mark="waiting" role="status" aria-label={waiting()}>
                  <QuestionIcon />
                </span>
              </Match>
              <Match when={running()}>
                <span class="tab-mark" data-mark="working" role="status" aria-label="Working">
                  <Spinner />
                </span>
              </Match>
              <Match when={unread()}>
                <span class="tab-mark" data-mark="done" role="status" aria-label="Done" />
              </Match>
              <Match when={drafted()}>
                <span class="tab-mark" data-mark="drafted" role="img" aria-label="Unsent prompt">
                  <PenSquareIcon />
                </span>
              </Match>
              <Match when={pinned()}>
                <span class="tab-mark" data-mark="pinned" role="img" aria-label="Pinned">
                  <PinIcon />
                </span>
              </Match>
              <Match when={archived()}>
                <span class="tab-mark" data-mark="archived" role="img" aria-label="Archived">
                  <ArchiveIcon />
                </span>
              </Match>
            </Switch>
            <span class="tab-title" classList={{ untitled: props.session.title === undefined }}>
              {title()}
            </span>
          </a>
          <AgentsChip deps={props.deps} parent={props.session} />
          <Show
            when={props.deps.shortcut(id())}
            fallback={
              <span class="tab-buttons">
                <Show when={!archived() && !blank() && props.transient !== true}>
                  <button
                    class="tab-button tab-pin"
                    aria-label={pinned() ? `Unpin ${title()}` : `Pin ${title()}`}
                    data-tip={withKeys(pinned() ? "Unpin" : "Pin", active() ? keysOf("thread.pin") : undefined)}
                    onClick={() => props.deps.pin(props.session, !pinned())}
                  >
                    <Show when={pinned()} fallback={<PinIcon />}>
                      <PinOffIcon />
                    </Show>
                  </button>
                </Show>
                <Switch>
                  <Match when={archived()}>
                    <button
                      class="tab-button tab-close"
                      aria-label={`Unarchive ${title()}`}
                      data-tip={withKeys("Unarchive", active() ? keysOf("sidebar.archive-thread") : undefined)}
                      onClick={() => props.deps.unarchive(props.session)}
                    >
                      <RedoIcon />
                    </button>
                  </Match>
                  <Match when={props.transient !== true}>
                    <button
                      class="tab-button tab-close"
                      aria-label={`Archive ${title()}`}
                      data-tip={withKeys("Archive", active() ? keysOf("sidebar.archive-thread") : undefined)}
                      onClick={() => {
                        leave();
                        props.deps.archive(props.session);
                      }}
                    >
                      <XIcon />
                    </button>
                  </Match>
                </Switch>
              </span>
            }
          >
            {(keys) => <kbd class="tab-keys">{keys()}</kbd>}
          </Show>
          <Show when={details()}>
            {(at) => (
              <ThreadDetails
                at={at()}
                side="below"
                title={title()}
                project={place().project}
                branch={place().branch}
                worktree={place().worktree}
                waiting={waiting()}
                running={running()}
                runningSince={props.deps.runningSince(id())}
                unread={unread()}
                archived={archived()}
                since={since()}
                now={props.deps.now()}
              />
            )}
          </Show>
          {/* Opened by a right-click; the trigger itself stays out of sight. */}
          <Show when={actions().length > 0}>
            <Popover
              label="Thread actions"
              trigger={<span />}
              triggerClass="thread-menu-anchor"
              placement="bottom-start"
              controller={(handle) => (openMenu = handle.open)}
            >
              {(close) => (
                <ActionMenu subject={props.session} control={{ rename: () => setEditing(true) }} slot={ThreadActions} actions={actions()} close={close} />
              )}
            </Popover>
          </Show>
        </div>
      }
    >
      <input
        class="tab-rename"
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

/** A new thread left mid-prompt: the prompt's first line, tinted; × discards it. */
function DraftTab(props: { deps: Deps; session: SessionInfo }) {
  const { threads } = props.deps;
  const plugin = usePlugin();
  const open = plugin.action("open a thread", (id: string) => threads.select(id));
  const discard = plugin.action("discard an unsent prompt", (id: string) => {
    threads.setDraft(id, undefined);
    return threads.remove(id);
  });
  const preview = () => {
    const draft = threads.drafts().get(props.session.id);
    const line = draft?.text.trim().split("\n", 1)[0] ?? "";
    const images = draft?.images.length ?? 0;
    return line !== "" ? line : images > 0 ? `${images} image${images === 1 ? "" : "s"}` : "New thread";
  };
  const active = () => threads.activeId() === props.session.id;
  return (
    <div class="tab draft" classList={{ active: active() }}>
      <a
        class="tab-open"
        href={threads.href(props.session.id)}
        draggable={false}
        data-session-row
        data-tip={`Unsent prompt · ${props.deps.place(props.session.cwd).project}`}
        aria-current={active() ? "page" : undefined}
        aria-label={`Unsent prompt: ${preview()}`}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          open(props.session.id);
        }}
      >
        <span class="tab-mark" data-mark="drafted">
          <PenSquareIcon />
        </span>
        <span class="tab-title">{preview()}</span>
      </a>
      <span class="tab-buttons">
        <button class="tab-button tab-close" aria-label={`Discard ${preview()}`} data-tip="Discard" onClick={() => discard(props.session.id)}>
          <XIcon />
        </button>
      </span>
    </div>
  );
}

/**
 * The archived, as the sidebar's fold at its foot keeps them: a button at the bar's end with their count, which opens
 * them, the latest archived first, each opening its thread or unarchiving it. A tab dragged onto it is archived: while
 * one is dragged it says so, and lights while the tab is over it.
 */
function ArchivedTabs(props: { deps: Deps; arrangement: Arrangement }) {
  const { threads } = props.deps;
  const plugin = usePlugin();
  const open = plugin.action("open an archived thread", (id: string) => threads.select(id));
  const zone = useDroppable({ id: Heads.archived });
  const archived = () => props.deps.lists().archived;
  return (
    <div ref={zone.ref} class="tab-archived" classList={{ dropping: props.arrangement.heads(), target: props.arrangement.toArchive() }}>
      <Popover
        label="Archived threads"
        triggerClass="tab-archived-trigger"
        placement="bottom-end"
        menuClass="tab-menu"
        trigger={
          <>
            <ArchiveIcon />
            <Show when={props.arrangement.heads()} fallback={<Show when={archived().length > 0}>{archived().length}</Show>}>
              Archive
            </Show>
          </>
        }
      >
        {(close) => (
          <>
            <div class="menu-section">{archived().length === 0 ? "Archived" : `Archived (${archived().length})`}</div>
            <Show when={archived().length > 0} fallback={<p class="tab-menu-empty">No archived threads</p>}>
              <For each={archived()}>
                {(session) => (
                  <div class="tab-menu-row">
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      aria-current={threads.activeId() === session.id ? "page" : undefined}
                      onPointerEnter={() => threads.preload(session.id)}
                      onClick={() => {
                        open(session.id);
                        close();
                      }}
                    >
                      <span class="menu-label">{sessionTitle(session)}</span>
                      <span class="menu-hint">{stateOf(props.deps, session, props.deps.archivedAt(session.id) ?? session.updatedAt)}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="tab-menu-unarchive"
                      aria-label={`Unarchive ${sessionTitle(session)}`}
                      data-tip="Unarchive"
                      onClick={() => props.deps.unarchive(session)}
                    >
                      <RedoIcon />
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </>
        )}
      </Popover>
    </div>
  );
}

/**
 * Every thread as a tab across the window's top, as a browser or Rex shows them, in the sidebar's sections and order:
 * new threads left mid-prompt, the pinned, then the active, each group apart, and the one shown at the end when it is
 * listed nowhere else. Tabs drag as the sidebar's cards do: across the divider to pin or unpin, onto Archived at the
 * bar's end to archive; while one drags, the sections are named and it says what dropping it does. The track scrolls
 * sideways (a wheel's turn scrolls it too) and keeps the one shown in sight; + starts a new thread after the last. The
 * sidebar's actions and foot sit at the bar's end. In a desktop window the bar is the title bar.
 */
export function TabStrip(props: { deps: Deps }) {
  const { threads, slots, webPlugins } = props.deps;
  const plugin = usePlugin();
  const newThread = plugin.action("start a new thread", () => threads.newThread());
  const arrangement = createArrangement(props.deps);
  const byId = createMemo(() => new Map(threads.list().map((session) => [session.id, session])));
  // By id, so a tab stays the same element while its thread changes.
  const drafts = createMemo(() => props.deps.drafts().map((session) => session.id));
  const listed = createMemo(() => new Set(arrangement.items()));
  const transient = createMemo(() => {
    const shown = threads.activeId();
    return shown === undefined || listed().has(shown) || drafts().includes(shown) ? undefined : shown;
  });
  /** Pinned tabs and others after them: a divider between. */
  const divided = () => {
    const items = arrangement.items();
    const at = items.indexOf(Heads.active);
    return at > 1 && (items.length - 2 > at || transient() !== undefined);
  };

  let strip!: HTMLElement;
  let track!: HTMLDivElement;
  // The tab shown scrolls into sight, once it is drawn.
  createEffect(
    on(threads.activeId, () =>
      onCleanup(plugin.after(0, () => track.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" }))),
    ),
  );
  return (
    <nav ref={strip} class="tab-strip" classList={{ dragging: arrangement.dragging() !== undefined }} aria-label="Threads">
      <SortableThreads axis="x" list={() => strip} arrangement={arrangement}>
        <div
          class="tab-track"
          ref={track}
          onWheel={(event) => {
            // A wheel that only turns up and down scrolls the tabs sideways.
            if (track.scrollWidth <= track.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
            event.preventDefault();
            track.scrollLeft += event.deltaY;
          }}
        >
          <ul class="tab-list" onKeyDown={tabKeys}>
            <For each={drafts()}>
              {(id) => (
                <Show when={byId().get(id)}>
                  {(session) => (
                    <li class="tab-item">
                      <DraftTab deps={props.deps} session={session()} />
                    </li>
                  )}
                </Show>
              )}
            </For>
            <Show when={drafts().length > 0}>
              <li class="tab-rule" aria-hidden="true" />
            </Show>
            <For each={arrangement.items().filter((id) => id !== Heads.archived)}>
              {(id, index) => (
                <Show
                  when={id === Heads.pinned || id === Heads.active}
                  fallback={
                    <Show when={arrangement.sessionOf(id)}>
                      {(session) => (
                        <SortableItem id={id} index={index()} section={arrangement.sectionOf(id)} class="tab-item">
                          <ThreadTab deps={props.deps} session={session()} />
                          <Show when={arrangement.dragging() === id ? arrangement.verb() : undefined}>
                            {(word) => <span class="tab-verb">{verbs[word()]()}</span>}
                          </Show>
                        </SortableItem>
                      )}
                    </Show>
                  }
                >
                  <SortableItem id={id} index={index()} section={arrangement.sectionOf(id)} head class={`tab-head ${id.slice("head:".length)}`}>
                    <Show
                      when={arrangement.heads()}
                      fallback={
                        <Show when={id === Heads.active && divided()}>
                          <span class="tab-rule" aria-hidden="true" />
                        </Show>
                      }
                    >
                      <span class="tab-head-label" classList={{ target: arrangement.target() === arrangement.sectionOf(id) }}>
                        {id === Heads.pinned ? "Pinned" : "Active"}
                      </span>
                    </Show>
                  </SortableItem>
                </Show>
              )}
            </For>
            <Show when={transient()}>
              {(id) => (
                <Show when={byId().get(id())}>
                  {(session) => (
                    <li class="tab-item">
                      <ThreadTab deps={props.deps} session={session()} transient />
                    </li>
                  )}
                </Show>
              )}
            </Show>
          </ul>
        </div>
        <button
          class="icon-button tab-new"
          aria-label="New thread"
          data-tip={withKeys("New thread", shownKeysOf(slots, webPlugins.list(), "thread.new-chat"))}
          onClick={() => newThread()}
        >
          <PlusIcon />
        </button>
        <span class="tab-spacer" />
        <ArchivedTabs deps={props.deps} arrangement={arrangement} />
        <div class="tab-actions">
          <Each slot={SidebarActions} props={{ onPick: stay }} />
          <Each slot={SidebarFooter} props={{ onPick: stay }} />
        </div>
      </SortableThreads>
    </nav>
  );
}
