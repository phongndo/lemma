import { batch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import { HostError } from "@lemma/contracts";
import { AgentChannels } from "@lemma/agent";
import type { AgentActivity, QueuedPrompt } from "@lemma/agent";
import { branchOf, SessionChannels } from "@lemma/sessions";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";
import {
  appendLog,
  appendOutput,
  applyDelta,
  createFinished,
  emptyLive,
  endTurn,
  growBranch,
  joinLive,
  LEAVING_MS,
  logFailure,
  newerQueue,
  noteEnded,
  noteLogged,
  recentRequests,
  reconcileLive,
  resolveLeaf,
  waitingPrompts,
} from "@lemma/threads";
import type { Finished, KnownQueue, LiveState, LogState, ThreadsService, WalkedBranch } from "@lemma/threads";
import type { ClientService } from "@lemma/web";
import type { Handle } from "./shared.ts";

/** How long a preloaded log stays fresh enough to open with (ms). */
export const PRELOAD_MS = 15_000;
/** Deltas and tool output waiting for a frame past this many are applied at once: a hidden tab gets no frames. */
export const QUEUE_LIMIT = 256;

/** The open thread as it is followed (`followOpen`): what `Threads` shows of it, and what the agent's activity tells it. */
export interface OpenThread extends Pick<ThreadsService, "branch" | "log" | "live" | "queue" | "preload"> {
  /** Settles once the open thread's log has first loaded, or it was left. */
  readonly opened: () => Promise<void>;
  /** Applies the deltas and output waiting for a frame: what streamed before an activity comes first. */
  readonly flush: () => void;
  /** The open thread's queue, as the agent reported it: an older report never replaces a newer. */
  readonly reportQueue: (report: KnownQueue) => void;
  /** The open thread's turn ended, as the agent said. */
  readonly turnEnded: (turnId: string) => void;
  /** A prompt is being taken out of the open thread's queue here: it is gone, not waiting for the log to place it. */
  readonly withdrawing: (requestId: string) => void;
}

/**
 * Follows the thread `threads.activeId` names: its `sessions.log` and its `agent.output`, in place of the last one's.
 * The output opens, and opens again after a reconnect, with what the agent has of the thread beyond its log (a turn
 * running since before this page saw it: its output so far; and the queue), so a thread opened or reconnected midway
 * shows it all; that may be older than the log that arrived first, so it is checked against the log as it stands.
 */
export const followOpen = (
  plugin: Handle,
  client: ClientService,
  threads: { readonly activeId: Accessor<string | undefined>; readonly active: Accessor<SessionInfo | undefined> },
): OpenThread => {
  // Event arrays and streaming drafts change often and are replaced wholesale.
  const [events, setEvents] = createSignal<readonly SessionEvent[]>([], { equals: false });
  const [log, setLog] = createSignal<LogState>({ loaded: true });
  /** The open thread's drafts and running tools' output: only the thread shown keeps them, and opening one asks the agent for its own. */
  const [live, setLive] = createSignal<LiveState>(emptyLive);
  /** What is over of the open thread's live output: its log's events noted as they are appended, and the turns the agent ended. */
  let finished: Finished = createFinished();
  /** The open thread's queue as the agent last reported it, with its revision: an older report never replaces a newer. */
  const [queue, setQueue] = createSignal<KnownQueue>();
  /**
   * Prompts that left the open thread's queue and may not be in its log yet, which reaches the page on a channel of
   * its own: they still wait (`waitingPrompts`) until the log has them, or for `LEAVING_MS`. Not the ones withdrawn
   * here (`withdrawn`), which are gone.
   */
  const [leaving, setLeaving] = createSignal<readonly QueuedPrompt[]>([]);
  let withdrawn = new Set<string>();
  const reportQueue = (report: KnownQueue) => {
    const known = queue();
    const next = newerQueue(known, report);
    if (next === known) return;
    const left = (known?.queue ?? []).filter(
      (prompt) => !withdrawn.has(prompt.requestId) && !next.queue.some((queued) => queued.requestId === prompt.requestId),
    );
    batch(() => {
      setQueue(next);
      if (left.length === 0) return;
      setLeaving((all) => [...all, ...left]);
      plugin.after(LEAVING_MS, () => setLeaving((all) => all.filter((prompt) => !left.includes(prompt))));
    });
  };

  const leaf = createMemo(() => resolveLeaf(events(), threads.active()?.leaf, threads.active()?.lastSeq));
  /** The log and leaf the branch was last read from, to go on from as the log grows. */
  let walked: WalkedBranch | undefined;
  /**
   * The branch shown, root to leaf. A log grown at its end along the branch (a turn appending) extends the last one
   * (`growBranch`): `branchOf` maps the whole log, and this runs on every event appended.
   */
  const branch = createMemo(() => {
    const all = events();
    const at = leaf();
    const last = walked;
    const next = (last === undefined ? undefined : growBranch(last, all, at)) ?? branchOf(all, at);
    walked = { events: all, leaf: at, branch: next };
    return next;
  });
  const waiting = createMemo<readonly QueuedPrompt[]>((previous) => waitingPrompts(queue()?.queue ?? [], leaving(), branch(), previous), []);
  // One the log has placed leaves for good, as it arrives: `waitingPrompts` reads only the log's last turns, which
  // move on past it.
  createEffect(() => {
    const left = leaving();
    if (left.length === 0) return;
    const placed = recentRequests(branch());
    if (left.some((prompt) => placed.has(prompt.requestId))) setLeaving(left.filter((prompt) => !placed.has(prompt.requestId)));
  });

  const updateLive = (update: (state: LiveState) => LiveState): void => {
    const current = live();
    const next = update(current);
    if (next !== current) setLive(next);
  };

  /** Logs fetched before their thread opened (a link to it hovered): opening one follows on from it. */
  const preloaded = new Map<string, { readonly at: number; readonly events: Promise<readonly SessionEvent[]> }>();
  const fresh = (found: { readonly at: number } | undefined) => found !== undefined && Date.now() - found.at < PRELOAD_MS;
  const preload = (sessionId: string) => {
    if (sessionId === threads.activeId() || fresh(preloaded.get(sessionId))) return;
    for (const [id, found] of preloaded) if (!fresh(found)) preloaded.delete(id);
    const fetched = client.channel.call(SessionChannels.events, { sessionId });
    // A failed preload is only a missed head start: opening reads the whole log.
    fetched.catch(() => preloaded.delete(sessionId));
    preloaded.set(sessionId, { at: Date.now(), events: fetched });
  };

  // Deltas and tool output arrive many times a frame; they are applied together, once per frame, in order.
  let deltas: Extract<AgentActivity, { type: "delta" | "tool-output" }>[] = [];
  let frame: number | undefined;
  const flush = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (deltas.length === 0) return;
    const pending = deltas;
    deltas = [];
    // Output comes on a stream of its own, so it can come after the log, or the agent, said its step or turn is over.
    updateLive((state) =>
      reconcileLive(
        pending.reduce(
          (next, event) =>
            event.type === "delta"
              ? applyDelta(next, event.turnId, event.stepId, event.event, event.seq)
              : appendOutput(next, event.toolCallId, event.chunk, event.offset),
          state,
        ),
        finished,
      ),
    );
  };
  plugin.onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  /** The open thread's model and tool output (`agent.output`). */
  const followOutput = (sessionId: string) =>
    client.follow(AgentChannels.output, { sessionId }, (element) => {
      if (element.type !== "subscribed") {
        deltas.push(element);
        if (deltas.length >= QUEUE_LIMIT) flush();
        else frame ??= requestAnimationFrame(flush);
        return;
      }
      const { view } = element;
      batch(() => {
        // What streamed before it is older: it applies first.
        flush();
        updateLive((state) => joinLive(state, view, finished));
        if (view !== undefined) reportQueue({ queue: view.queue, revision: view.queueRevision });
      });
    });

  /** The open thread's `sessions.log`, and its `agent.output`. */
  let stopLog: (() => void) | undefined;
  let stopOutput: (() => void) | undefined;
  plugin.onCleanup(() => {
    stopLog?.();
    stopOutput?.();
  });
  let opened: Promise<void> = Promise.resolve();
  const open = (sessionId: string | undefined) => {
    stopLog?.();
    stopOutput?.();
    stopLog = stopOutput = undefined;
    // What streamed belongs to the thread left.
    deltas = [];
    batch(() => {
      setEvents([]);
      setLog({ loaded: sessionId === undefined });
      setLive(emptyLive);
      finished = createFinished();
      setQueue(undefined);
      setLeaving([]);
      withdrawn = new Set();
    });
    if (sessionId === undefined) {
      opened = Promise.resolve();
      return;
    }
    let first!: () => void;
    opened = new Promise((resolve) => (first = resolve));
    const append = (incoming: readonly SessionEvent[]) => {
      const before = untrack(events);
      const next = appendLog(before, incoming);
      if (next === before) return;
      setEvents(next);
      // Only what was appended is read: what is over of the rest was noted as it came.
      noteLogged(finished, next, before.length);
      updateLive((state) => reconcileLive(state, finished));
    };
    // Leaving the thread settles `opened` too, so a `select` of it never waits on a log no longer read.
    let left = false;
    stopLog = () => {
      left = true;
      first();
    };
    const follow = (head: readonly SessionEvent[]) => {
      if (left) return;
      if (head.length > 0) {
        batch(() => {
          append(head);
          setLog({ loaded: true });
        });
        first();
      }
      // The log after the last event this page has, then each one appended: again after a reconnect or a reload.
      const unfollow = client.follow(
        SessionChannels.log,
        () => ({ sessionId, after: untrack(events).at(-1)?.seq ?? 0 }),
        (update) => {
          batch(() => {
            append(update.type === "subscribed" ? update.events : [update.event]);
            if (update.type === "subscribed") setLog({ loaded: true });
          });
          first();
        },
        (error) => {
          // A reload opens it again at once, a dropped connection once it is back, and the channel not served
          // (`sessions` being replaced) once it is listed, each from the last event this page has; what else ends it
          // is said (`logFailure`).
          if (error instanceof HostError && error.code === "Withdrawn") return;
          const failure = logFailure(error);
          if (failure !== undefined) setLog({ loaded: true, error: failure });
          first();
        },
      );
      stopLog = () => {
        unfollow();
        first();
      };
    };
    const warm = preloaded.get(sessionId);
    preloaded.delete(sessionId);
    if (fresh(warm)) warm!.events.then(follow, () => follow([]));
    else follow([]);
    stopOutput = followOutput(sessionId);
  };
  createEffect(on(threads.activeId, open));

  return {
    branch,
    log,
    live,
    queue: waiting,
    preload,
    opened: () => opened,
    flush,
    reportQueue,
    turnEnded: (turnId) => {
      noteEnded(finished, turnId);
      updateLive((state) => endTurn(state, turnId));
    },
    withdrawing: (requestId) => {
      // Gone once the agent has it out, not kept waiting for a log that will never have it.
      withdrawn.add(requestId);
      setLeaving((all) => all.filter((prompt) => prompt.requestId !== requestId));
    },
  };
};
