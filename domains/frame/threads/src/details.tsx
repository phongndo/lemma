import { Show, createSignal, onCleanup } from "solid-js";
import { usePlugin } from "@lemma/web";
import { GitBranchIcon, WorktreeIcon } from "@lemma/look";
import { runTime, shortAge } from "./list.ts";

/** How long the pointer rests on a thread before its details show, and how soon after one closes the next opens at once. */
const CARD_DELAY = 150;
const CARD_CHAIN = 400;
/** The card's widest, and its distance from what it details. */
const CARD_WIDTH = 300;
const CARD_GAP = 6;

/** When a thread's details last closed, so pointing at the next one shows its own at once. */
let cardClosedAt = 0;

/**
 * A thread's details after a moment's pointing at it, a row's or a tab's: `point` as the pointer enters, `leave` as it
 * goes (or anything else takes over: its menu, a click). Pointing at the next one soon after shows its own at once.
 */
export function createDetails() {
  const plugin = usePlugin();
  const [at, setAt] = createSignal<DOMRect>();
  let waiting: (() => void) | undefined;
  const point = (element: HTMLElement) => {
    waiting?.();
    const show = () => setAt(element.getBoundingClientRect());
    if (Date.now() - cardClosedAt < CARD_CHAIN) show();
    else waiting = plugin.after(CARD_DELAY, show);
  };
  const leave = () => {
    waiting?.();
    waiting = undefined;
    if (at() !== undefined) cardClosedAt = Date.now();
    setAt(undefined);
  };
  onCleanup(leave);
  return { at, point, leave };
}

export interface DetailsProps {
  readonly at: DOMRect;
  /** Beside a row in the sidebar, or under a tab across the top. */
  readonly side: "beside" | "below";
  readonly title: string;
  readonly project: string;
  readonly branch?: string | undefined;
  readonly worktree?: boolean | undefined;
  readonly waiting?: string | undefined;
  readonly running: boolean;
  readonly runningSince?: number | undefined;
  readonly unread: boolean;
  readonly archived: boolean;
  /** What its age counts from. */
  readonly since: number;
  readonly now: number;
}

/** Where the card goes: level with a row (near the window's foot, growing up from its bottom), or under a tab, kept in the window. */
const placed = (props: DetailsProps) => {
  const at = props.at;
  if (props.side === "below") return { left: `${Math.max(8, Math.min(at.left, window.innerWidth - CARD_WIDTH - 8))}px`, top: `${at.bottom + CARD_GAP}px` };
  return at.top + 200 > window.innerHeight
    ? { left: `${at.right + CARD_GAP}px`, bottom: `${window.innerHeight - at.bottom}px` }
    : { left: `${at.right + CARD_GAP}px`, top: `${at.top}px` };
};

/** A thread's title, project, branch, and state, as the card that floats by it shows them. */
export function ThreadDetails(props: DetailsProps) {
  const age = () => shortAge(props.since, props.now);
  return (
    <div class="thread-details" style={placed(props)} aria-hidden="true">
      <div class="thread-details-title">{props.title}</div>
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
        {props.running ? "Working" : props.archived ? "Archived" : props.unread ? "Finished, not yet seen" : "Last used"}
        {props.running && props.runningSince !== undefined ? ` for ${runTime(props.runningSince, props.now)}` : ""}
        {props.running ? "" : ` ${age() === "now" ? "just now" : `${age()} ago`}`}
      </div>
    </div>
  );
}
