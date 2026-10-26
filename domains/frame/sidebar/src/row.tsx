import { Match, Show, Switch, createEffect, createSignal, onCleanup } from "solid-js";
import { ThreadActions, sessionTitle } from "@lemma/threads";
import type { SidebarRowProps, ThreadDraft } from "@lemma/threads";
import type { SessionInfo } from "@lemma/sessions";
import { ActionMenu } from "@lemma/frame";
import { usePlugin } from "@lemma/web";
import {
  AlertIcon,
  ArchiveIcon,
  CheckIcon,
  GitBranchIcon,
  PenSquareIcon,
  PinIcon,
  PinOffIcon,
  Popover,
  QuestionIcon,
  RedoIcon,
  Spinner,
  WorktreeIcon,
  XIcon,
} from "@lemma/look";
import { runTime, shortAge } from "./list.ts";

/** How long the pointer rests on a row before its details show, and how soon after one closes the next opens at once. */
const CARD_DELAY = 150;
const CARD_CHAIN = 400;

/** When a row's details last closed, so pointing at the next one shows its own at once. */
let cardClosedAt = 0;
/** Where the pointer last moved over a row: one moved under a still pointer (a thread made or archived above it) shows no details. */
let pointerAt = { x: Number.NaN, y: Number.NaN };

/**
 * Its state where the time goes, as T3 Code shows it, the most pressing first: what it waits on the person for, a
 * running turn and its time, a turn that failed or finished and is not yet seen; else how long ago it was used.
 */
export const Status = (props: SidebarRowProps & { readonly since?: number }) => (
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
const PIN_ROOM = 26;
const DISCARD_ROOM = 76;

/** A row's details, beside it while the pointer rests on it: its title, project, branch, and what it is doing or did last, since when. */
function Details(props: SidebarRowProps & { readonly at: DOMRect; readonly archived: boolean; readonly since: number }) {
  return (
    <div
      class="thread-details"
      // Level with the row; near the window's foot it grows upward from the row's bottom instead.
      style={
        props.at.top + 200 > window.innerHeight
          ? { left: `${props.at.right + 6}px`, bottom: `${window.innerHeight - props.at.bottom}px` }
          : { left: `${props.at.right + 6}px`, top: `${props.at.top}px` }
      }
      aria-hidden="true"
    >
      <div class="thread-details-title">{sessionTitle(props.session)}</div>
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
        {stateWords(props, props.archived)}
        {props.running && props.runningSince !== undefined ? ` for ${runTime(props.runningSince, props.now)}` : ""}
        {props.running ? "" : ` ${shortAge(props.since, props.now) === "now" ? "just now" : `${shortAge(props.since, props.now)} ago`}`}
      </div>
    </div>
  );
}

/**
 * The default `sidebar.row` part: a card of two lines, its title alone, so nothing cuts it short, then its project and
 * branch with its age or state at the end; a slim row once archived. Under the pointer a card offers to pin (or unpin) it and to archive it (an archived row,
 * to unarchive it), and after a moment shows its details beside it. A pen marks a prompt written in it and not sent. A
 * right-click opens its menu; a double-click renames it.
 */
export function ThreadRow(props: SidebarRowProps) {
  const plugin = usePlugin();
  const [editing, setEditing] = createSignal(false);
  const [details, setDetails] = createSignal<DOMRect>();
  let row!: HTMLDivElement;
  let link: HTMLAnchorElement | undefined;
  let openMenu: (() => void) | undefined;
  let waiting: (() => void) | undefined;
  const archived = () => props.session.archived === true;
  /** What its age counts from: its archiving once archived, else its last use. */
  const since = () => (archived() ? (props.archivedAt ?? props.session.updatedAt) : props.session.updatedAt);
  /** Renaming ended from the keyboard: the field's going blurs it, which then neither saves nor saves again. */
  let ended = false;
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) props.rename(value);
  };
  /** Renaming ended from the keyboard (Enter, Escape): focus goes back to the row, drawn again, not to the page. */
  const backToRow = () => queueMicrotask(() => link?.focus({ preventScroll: true }));
  /** The pointer moving over it, not a row moving under the pointer, shows its details after a moment. */
  const point = (event: PointerEvent) => {
    const moved = event.clientX !== pointerAt.x || event.clientY !== pointerAt.y;
    pointerAt = { x: event.clientX, y: event.clientY };
    if (!moved || event.pointerType === "touch" || details() !== undefined || waiting !== undefined) return;
    const show = () => {
      waiting = undefined;
      setDetails(row.getBoundingClientRect());
    };
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
  // Typing anywhere puts the details away (what is typed, `input`: the page's keys are the keymap's), as do keys in the row.
  createEffect(() => {
    if (details() !== undefined) onCleanup(plugin.listen(document, "input", leave, { capture: true }));
  });
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
          onPointerMove={point}
          onPointerLeave={leave}
          onKeyDown={leave}
          onContextMenu={(event) => {
            leave();
            if (props.actions.length === 0) return;
            event.preventDefault();
            openMenu?.();
          }}
        >
          <a
            ref={link}
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
          <Show when={details()}>{(at) => <Details {...props} at={at()} archived={archived()} since={since()} />}</Show>
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
        ref={(el) => {
          ended = false;
          queueMicrotask(() => {
            el.focus();
            el.select();
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            ended = true;
            commit(event.currentTarget.value);
            backToRow();
          } else if (event.key === "Escape") {
            // Cancelled: the title stays as it was.
            event.preventDefault();
            event.stopPropagation();
            ended = true;
            setEditing(false);
            backToRow();
          }
        }}
        onBlur={(event) => {
          if (!ended) commit(event.currentTarget.value);
        }}
      />
    </Show>
  );
}

/** A new thread left mid-prompt: the prompt's first line and its project; under the pointer, Discard deletes it. */
export function DraftRow(props: {
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
