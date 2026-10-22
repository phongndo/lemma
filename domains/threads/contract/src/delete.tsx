import { Show } from "solid-js";
import type { SessionInfo } from "@lemma/sessions";
import { Dialog } from "@lemma/look";
import { usePlugin } from "@lemma/web";
import { sessionTitle } from "./list.ts";
import type { ThreadsService } from "./threads.ts";

/** How many threads, as words: `1 thread`, `3 threads`. */
export const threadCount = (count: number): string => `${count} ${count === 1 ? "thread" : "threads"}`;

/**
 * Asks before deleting threads for good, saying what goes and what stays: everything said and done in them goes, a
 * worktree Lemma made for one may go with it unless it holds uncommitted work, and branches stay. A thread whose turn
 * runs is kept. It asks for many at once (a selection), and for one with no row to ask on (the palette's Delete
 * thread); one row's Delete asks in place instead (`ConfirmDelete` in `@lemma/look`). Draw it as a `Layers` item.
 */
export function DeleteThreadsDialog(props: {
  readonly threads: ThreadsService;
  /** What to delete, as it is now: a thread deleted meanwhile is left out by the caller. */
  readonly sessions: readonly SessionInfo[];
  /** How many of them are out of sight (a search hides them), said before they go. */
  readonly hidden?: number;
  readonly close: () => void;
}) {
  const running = () => props.sessions.filter((session) => props.threads.running().includes(session.id));
  const deletable = () => props.sessions.filter((session) => !props.threads.running().includes(session.id));
  const one = () => (props.sessions.length === 1 ? props.sessions[0] : undefined);
  const remove = usePlugin().action("delete threads", () => {
    const ids = deletable().map((session) => session.id);
    props.close();
    return Promise.all(ids.map((id) => props.threads.remove(id)));
  });
  return (
    <Dialog
      title={one() === undefined ? `Delete ${threadCount(props.sessions.length)}?` : `Delete “${sessionTitle(one())}”?`}
      onClose={props.close}
      class="delete-threads-dialog"
      footer={
        <>
          <button class="button" data-autofocus on:click={props.close}>
            Cancel
          </button>
          <button class="button button-danger" disabled={deletable().length === 0} on:click={() => remove()}>
            {one() === undefined ? `Delete ${threadCount(deletable().length)}` : "Delete thread"}
          </button>
        </>
      }
    >
      <Show when={(props.hidden ?? 0) > 0}>
        <p>{one() !== undefined ? "It is hidden by the search." : `${props.hidden} of them ${props.hidden === 1 ? "is" : "are"} hidden by the search.`}</p>
      </Show>
      <p>
        {one() === undefined ? "This permanently deletes them" : "This permanently deletes it"}, with everything said and done in{" "}
        {one() === undefined ? "them" : "it"}. It cannot be undone.
      </p>
      <p class="muted">
        {one() === undefined
          ? "Worktrees Lemma made for them may go with them, unless they hold uncommitted work; their branches stay."
          : "A worktree Lemma made for it may go with it, unless it holds uncommitted work; its branch stays."}
      </p>
      <Show when={running().length > 0}>
        <p class="tw:text-warn">
          {threadCount(running().length)} still running {running().length === 1 ? "is" : "are"} kept; stop {running().length === 1 ? "it" : "them"} to delete{" "}
          {running().length === 1 ? "it" : "them"}.
        </p>
      </Show>
    </Dialog>
  );
}
