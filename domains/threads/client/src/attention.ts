import { createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import type { SessionInfo, TurnEndReason } from "@lemma/sessions";
import { attentionOf, isUnseenEnd, tells, ThreadWaits, waitingOn } from "@lemma/threads";
import type { ThreadAttention, ThreadsService, UnseenEnd } from "@lemma/threads";
import type { SlotsService } from "@lemma/web";
import { recordOf } from "@lemma/web/storage";
import { sharedRecord } from "./shared.ts";
import type { Handle } from "./shared.ts";

/** The turns' ends not looked at yet, by thread (`Threads.attention`), shared by the browser's tabs. */
export const UNSEEN_KEY = "lemma.threads.client.unseen";
const isUnseen = recordOf(isUnseenEnd);
/** At most this many unseen ends are kept in storage, the newest. */
const UNSEEN_KEPT = 200;

/** What a thread asks of the person (`Threads.attention`), and what tells it a turn began, ended, or was sent. */
export interface AttentionStore extends Pick<ThreadsService, "attention" | "markSeen"> {
  /** A turn began: the last one's end is left behind. Only the agent's word for it: `running` is also guessed. */
  readonly turnStarted: (sessionId: string) => void;
  /** A turn ended: one to tell of is there to see, unless its thread shows to the person now. */
  readonly turnEnded: (sessionId: string, reason: TurnEndReason) => void;
  /** A prompt was sent: it starts a turn, whose end is the one to hear. */
  readonly sent: (sessionId: string) => void;
}

/**
 * Each thread's attention: what it waits on the person for (`ThreadWaits`), a turn running, or a turn's end not yet
 * seen. Ends are kept in the browser for the threads `threads` lists, written as each changes into what storage holds
 * (another tab's stay), and another tab's changes arrive the same way.
 */
export const createAttention = (
  plugin: Handle,
  slots: SlotsService,
  threads: {
    readonly list: Accessor<readonly SessionInfo[]>;
    readonly loaded: Accessor<boolean>;
    readonly running: Accessor<readonly string[]>;
    readonly activeId: Accessor<string | undefined>;
  },
): AttentionStore => {
  /** The person is looking at this window: the page shows, and its window has focus. */
  const looking = () => document.visibilityState === "visible" && document.hasFocus();
  const [attending, setAttending] = createSignal(looking());
  const lookAgain = () => setAttending(looking());
  plugin.listen(document, "visibilitychange", lookAgain);
  plugin.listen(window, "focus", lookAgain);
  plugin.listen(window, "blur", lookAgain);

  const [unseen, setUnseen] = createSignal<Readonly<Record<string, UnseenEnd>>>({});
  const listed = () => new Set(untrack(threads.list).map((session) => session.id));
  const stored = sharedRecord(plugin, UNSEEN_KEY, isUnseen, (after, before) => {
    const mine = listed();
    const next = { ...untrack(unseen) };
    let changed = false;
    for (const [id, end] of Object.entries(after))
      if (mine.has(id) && (before[id]?.at !== end.at || before[id]?.reason !== end.reason)) {
        next[id] = end;
        changed = true;
      }
    for (const id of Object.keys(before))
      if (!(id in after) && id in next) {
        delete next[id];
        changed = true;
      }
    if (changed) setUnseen(next);
  });
  // The newest only, so ends of threads no tab lists any more do not pile up.
  const writeEnds = (change: (ends: Record<string, UnseenEnd>) => void) =>
    stored.write((ends) => {
      change(ends);
      return Object.fromEntries(
        Object.entries(ends)
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, UNSEEN_KEPT),
      );
    });
  // Once the list is in, the ends kept for its threads are this page's.
  createEffect(
    on(threads.loaded, (ready) => {
      if (!ready) return;
      const mine = listed();
      const kept = Object.entries(stored.read()).filter(([id]) => mine.has(id));
      if (kept.length > 0) setUnseen({ ...Object.fromEntries(kept), ...untrack(unseen) });
    }),
  );
  const markSeen = (sessionId?: string) => {
    const now = untrack(unseen);
    const ids = sessionId === undefined ? Object.keys(now) : sessionId in now ? [sessionId] : [];
    if (ids.length === 0) return;
    const next = { ...now };
    for (const id of ids) delete next[id];
    setUnseen(next);
    writeEnds((ends) => {
      for (const id of ids) delete ends[id];
    });
  };
  /** The threads whose turn's end this page heard since their turn began: one that stops running unheard ended unseen. */
  const heardEnd = new Set<string>();
  const turnEnded = (sessionId: string, reason: TurnEndReason) => {
    heardEnd.add(sessionId);
    if (!tells(reason)) return markSeen(sessionId);
    if (sessionId === untrack(threads.activeId) && untrack(attending)) return markSeen(sessionId);
    const end = { reason, at: Date.now() };
    setUnseen({ ...untrack(unseen), [sessionId]: end });
    writeEnds((ends) => {
      ends[sessionId] = end;
    });
  };
  const turnStarted = (sessionId: string) => {
    heardEnd.delete(sessionId);
    markSeen(sessionId);
  };
  // The thread shown, to a person looking, is seen (an end kept from before a reload, or another tab's, too); one that
  // is gone has nothing to see.
  createEffect(() => {
    const id = threads.activeId();
    if (id !== undefined && attending() && id in unseen()) markSeen(id);
  });
  createEffect(() => {
    if (!threads.loaded()) return;
    const known = new Set(threads.list().map((session) => session.id));
    const gone = Object.keys(untrack(unseen)).filter((id) => !known.has(id));
    for (const id of gone) markSeen(id);
  });
  /** When this page saw each turn start, and each thread begin waiting: what attention counts from. */
  const [startedAt, setStartedAt] = createSignal<Readonly<Record<string, number>>>({});
  createEffect(
    on(threads.running, (now, before) => {
      const started = now.filter((id) => !(before ?? []).includes(id));
      // A turn that stopped with no end heard (the agent's activity fell behind): it ended, unseen.
      for (const id of before ?? []) if (!now.includes(id) && !heardEnd.has(id)) turnEnded(id, "done");
      const at = untrack(startedAt);
      setStartedAt(Object.fromEntries([...Object.entries(at).filter(([id]) => now.includes(id)), ...started.map((id) => [id, at[id] ?? Date.now()] as const)]));
    }),
  );
  const waits = createMemo(() => {
    const items = slots.list(ThreadWaits);
    const waiting = new Map<string, string>();
    for (const session of threads.list()) {
      const label = waitingOn(items, session.id);
      if (label !== undefined) waiting.set(session.id, label);
    }
    return waiting;
  });
  // Derived with the waits rather than after them, so a thread begins waiting once, at one time: an effect would set
  // it a moment later, and a reader in between would see a wait begin twice.
  const waitingSince = createMemo<Readonly<Record<string, number>>>((at) => {
    const now = Date.now();
    return Object.fromEntries([...waits().keys()].map((id) => [id, at[id] ?? now] as const));
  }, {});
  const attention = createMemo((): ReadonlyMap<string, ThreadAttention> => {
    const ends = unseen();
    const turns = threads.running();
    const ids = new Set([...turns, ...waits().keys(), ...Object.keys(ends)]);
    const now = Date.now();
    const all = new Map<string, ThreadAttention>();
    for (const id of ids) {
      const found = attentionOf(
        {
          waiting: waits().get(id),
          waitingSince: waitingSince()[id],
          running: turns.includes(id),
          runningSince: startedAt()[id],
          unseen: ends[id],
        },
        now,
      );
      if (found !== undefined) all.set(id, found);
    }
    return all;
  });
  return { attention, markSeen, turnStarted, turnEnded, sent: (sessionId) => void heardEnd.delete(sessionId) };
};
