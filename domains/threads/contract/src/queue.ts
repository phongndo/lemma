import type { QueuedPrompt } from "@lemma/agent";
import type { SessionEvent } from "@lemma/sessions";
import type { ThreadsService } from "./threads.ts";

/**
 * How long a prompt that left the agent's queue still shows as waiting while the log has yet to show it placed (ms):
 * the log and the queue reach the page on channels of their own, in either order. One withdrawn elsewhere goes then.
 */
export const LEAVING_MS = 3000;

/**
 * The request ids of the prompts logged in the branch's last two turns, read from its end: where a prompt that just
 * left the queue is placed (a steer in the turn running, a follow-up or what a stopped turn left at the start of the
 * next), so reading the whole log for them is not needed.
 */
export const recentRequests = (branch: readonly SessionEvent[]): ReadonlySet<string> => {
  const ids = new Set<string>();
  let starts = 0;
  for (let index = branch.length - 1; index >= 0 && starts < 2; index--) {
    const data = branch[index]!.data;
    if (data.type === "turn-start") starts++;
    else if (data.type === "message" && data.requestId !== undefined) ids.add(data.requestId);
  }
  return ids;
};

/**
 * The prompts waiting to be placed, as a client shows them: before the agent's queue, the prompts that just left it
 * (`leaving`, ahead of it in the queue) and that the log has yet to show placed; less every one the log has placed.
 * A prompt keeps the object it had in `previous` while its mode stays, so a view keyed by it keeps its row.
 */
export const waitingPrompts = (
  queue: readonly QueuedPrompt[],
  leaving: readonly QueuedPrompt[],
  branch: readonly SessionEvent[],
  previous: readonly QueuedPrompt[] = [],
): readonly QueuedPrompt[] => {
  const all = [...leaving.filter((left) => !queue.some((queued) => queued.requestId === left.requestId)), ...queue];
  if (all.length === 0) return previous.length === 0 ? previous : [];
  const placed = recentRequests(branch);
  const kept = new Map(previous.map((prompt) => [prompt.requestId, prompt]));
  const waiting = all
    .filter((prompt) => !placed.has(prompt.requestId))
    .map((prompt) => {
      const before = kept.get(prompt.requestId);
      return before !== undefined && before.mode === prompt.mode ? before : prompt;
    });
  return waiting.length === previous.length && waiting.every((prompt, index) => prompt === previous[index]) ? previous : waiting;
};

/**
 * The branch's last turn, if it has started and not ended (with the session busy, the turn it is running): when it
 * started, and whether it has begun its steps (`step-start`), which it does once it has placed the prompts it opened
 * with.
 */
export const openTurn = (branch: readonly SessionEvent[]): { readonly startedAt: number; readonly stepping: boolean } | undefined => {
  let stepping = false;
  for (let index = branch.length - 1; index >= 0; index--) {
    const event = branch[index]!;
    if (event.data.type === "turn-end") return undefined;
    if (event.data.type === "step-start") stepping = true;
    if (event.data.type === "turn-start") return { startedAt: event.at, stepping };
  }
  return undefined;
};

/** Where the active thread's waiting prompts show (`queuePlaces`). */
export interface QueuePlaces {
  /** A turn runs, its start in the log: a queued follow-up can steer it after all. */
  readonly running: boolean;
  /** Steers the running turn places after its current step: a view of the conversation draws them where they will join. */
  readonly joining: readonly QueuedPrompt[];
  /**
   * What waits for a turn of its own: the follow-ups, and with no turn running every prompt, steers too (what a
   * stopped or failed turn left goes with the next prompt). The composer draws these.
   */
  readonly next: readonly QueuedPrompt[];
}

/**
 * Splits the active thread's waiting prompts (`Threads.queue`) between the views that draw them, so each is drawn
 * once. A steer joins the running turn once the log shows that turn started and not ended, and the steer was sent
 * during it or the turn has begun its steps: a steer a stopped turn left opens the next turn with the prompt that
 * starts it, placed before that turn's first step, and waits with the queue until then. A session marked busy before
 * its turn has started (a prompt just sent) has no turn to join yet.
 */
export const queuePlaces = (threads: Pick<ThreadsService, "queue" | "busy" | "branch">): QueuePlaces => {
  const turn = threads.busy() ? openTurn(threads.branch()) : undefined;
  const queue = threads.queue();
  if (turn === undefined) return { running: false, joining: [], next: queue };
  const joins = (prompt: QueuedPrompt) => prompt.mode === "steer" && (turn.stepping || prompt.at >= turn.startedAt);
  return { running: true, joining: queue.filter(joins), next: queue.filter((prompt) => !joins(prompt)) };
};
