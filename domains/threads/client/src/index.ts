import { batch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { PromptRefused, startPrompt } from "@lemma/agent/prompt";
import { HostError } from "@lemma/contracts";
import { AgentChannels } from "@lemma/agent";
import { branchOf, SessionChannels, NewThreadRoute, ThreadRoute } from "@lemma/sessions";
import { isRoute } from "@lemma/router";
import type { AgentActivity, AgentView, PromptContent, QueuedPrompt, TurnOptions } from "@lemma/agent";
import type { SessionEvent, SessionInfo, SessionMarks, SessionsChange } from "@lemma/sessions";
import {
  appendLog,
  appendOutput,
  applyDelta,
  applySessionsChange,
  beginJoin,
  emptyLive,
  endTurn,
  isBlank,
  joinLive,
  LEAVING_MS,
  logFailure,
  newerQueue,
  recentRequests,
  reconcileLive,
  resolveLeaf,
  ThreadHolds,
  Threads,
  THREADS_CONTRACT,
  trackTurn,
  upsertSession,
  waitingPrompts,
  written,
} from "@lemma/threads";
import type { LiveState, KnownQueue, LogState, PromptAnswer, ThreadDraft } from "@lemma/threads";
import { PluginsFacts } from "@lemma/settings";
import { Client, Notify, Router, Slots, defineWebPlugin } from "@lemma/web";
import { loadJson, recordOf, save } from "@lemma/web/storage";

/** How long a preloaded log stays fresh enough to open with (ms). */
const PRELOAD_MS = 15_000;
/** The blank threads this tab made (`made` below), in the tab's own storage. */
const MADE_KEY = "lemma.threads.client.made";
/** The unsent prompts' text, by thread (`Threads.drafts`). */
const DRAFTS_KEY = "lemma.threads.client.drafts";
/** How long after a draft's last change it is written to storage (ms). */
const SAVE_MS = 400;
const isTexts = recordOf((text): text is string => typeof text === "string");

/** What this tab keeps across its reloads (`sessionStorage`): no other tab reads it. */
const tabLoad = (key: string): string[] => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};
const tabSave = (key: string, value: readonly string[]) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage off: kept for this page only.
  }
};

/** A thread's id in an address from before threads had paths (`/#<id>`), if any; a malformed one reads as none. */
const hashThread = (): string | undefined => {
  try {
    const id = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
};

/**
 * Threads and the active one's log: the list, which is open, its events and
 * streaming drafts, which threads are running, and sending prompts. The
 * address names the open thread (`/threads/<id>`): the active thread follows
 * it, so a link, back and forward, and a reload all open the thread they name.
 * It follows the host through `sessions.changes`, `agent.activity`, and the
 * open thread's `sessions.log`.
 */
export default defineWebPlugin({
  id: "threads.client",
  implements: [THREADS_CONTRACT],
  requires: { client: Client, notify: Notify, router: Router, slots: Slots },
  provides: { threads: Threads },
  setup: ({ client, notify, router, slots }, plugin) => {
    const [list, setList] = createSignal<readonly SessionInfo[]>([]);
    const [loaded, setLoaded] = createSignal(false);
    const [running, setRunning] = createSignal<readonly string[]>([]);
    /** The last prompt a plugin answered instead of placing it, in whichever thread. */
    const [answered, setAnswered] = createSignal<PromptAnswer>();
    const [pendingCwd, setPendingCwd] = createSignal<string>();
    /**
     * The unsent prompts (`Threads.drafts`): their text kept in this browser, their images while the page lasts. `held`
     * is the truth, at once; the signal is told at once when a thread gains or loses one, and a moment after the last
     * change otherwise, so typing does not redraw every list that reads it at each key.
     */
    const held = new Map<string, ThreadDraft>(Object.entries(loadJson(DRAFTS_KEY, {}, isTexts)).map(([id, text]) => [id, { text, images: [] }] as const));
    const [drafts, setDrafts] = createSignal<ReadonlyMap<string, ThreadDraft>>(new Map(held));
    let telling: (() => void) | undefined;
    const tell = () => {
      telling?.();
      telling = undefined;
      setDrafts(new Map(held));
    };
    /**
     * Drafts' texts not yet written to storage, by thread (undefined: none). They are written a moment after the last
     * change, and as the page goes, merged into what storage holds then: another tab's drafts stay.
     */
    const unsaved = new Map<string, string | undefined>();
    let saving: (() => void) | undefined;
    const saveDrafts = () => {
      saving?.();
      saving = undefined;
      if (unsaved.size === 0) return;
      const kept: Record<string, string> = { ...loadJson(DRAFTS_KEY, {}, isTexts) };
      for (const [id, text] of unsaved) {
        if (text === undefined) delete kept[id];
        else kept[id] = text;
      }
      unsaved.clear();
      save(DRAFTS_KEY, JSON.stringify(kept));
    };
    plugin.listen(window, "pagehide", saveDrafts);
    plugin.onCleanup(saveDrafts);
    const setDraft = (sessionId: string, draft: ThreadDraft | undefined) => {
      const was = held.get(sessionId);
      const now = written(draft) ? draft : undefined;
      if (now === undefined ? was === undefined : was?.text === now.text && was.images === now.images) return;
      if (now === undefined) held.delete(sessionId);
      else held.set(sessionId, { text: now.text, images: now.images });
      if ((was === undefined) !== (now === undefined)) tell();
      else telling ??= plugin.after(SAVE_MS, tell);
      unsaved.set(sessionId, now !== undefined && now.text.trim() !== "" ? now.text : undefined);
      saving ??= plugin.after(SAVE_MS, saveDrafts);
    };
    // Another tab's drafts, as it saves them: its text for each thread this tab has not changed since its last save.
    plugin.listen(window, "storage", (event) => {
      if (event.key !== DRAFTS_KEY) return;
      const stored = loadJson(DRAFTS_KEY, {}, isTexts);
      let changed = false;
      for (const [id, text] of Object.entries(stored)) {
        if (unsaved.has(id) || held.get(id)?.text === text) continue;
        held.set(id, { text, images: held.get(id)?.images ?? [] });
        changed = true;
      }
      for (const [id, draft] of held) {
        if (unsaved.has(id) || id in stored || draft.images.length > 0) continue;
        held.delete(id);
        changed = true;
      }
      if (changed) tell();
    });
    // Event arrays and streaming drafts change often and are replaced wholesale.
    const [events, setEvents] = createSignal<readonly SessionEvent[]>([], { equals: false });
    const [log, setLog] = createSignal<LogState>({ loaded: true });
    /** The open thread's drafts and running tools' output: only the thread shown keeps them, and opening one asks the agent for its own. */
    const [live, setLive] = createSignal<LiveState>(emptyLive);
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

    /** The last ended turn per session, so a late `turn-started` cannot mark it running again (see `trackTurn`). */
    let endedTurns: Readonly<Record<string, string>> = {};
    /** The thread the address names; another page (settings) keeps the one it was opened over. */
    const routed = createMemo<string | undefined>((previous) => {
      const match = router.match();
      if (isRoute(match, ThreadRoute)) return match.params.id;
      return isRoute(match, NewThreadRoute) ? undefined : previous;
    }, undefined);
    /** An id no thread has (yet: the list may still be loading) opens nothing; the thread view says so. */
    const activeId = createMemo(() => {
      const id = routed();
      return id !== undefined && list().some((session) => session.id === id) ? id : undefined;
    });

    const active = createMemo(() => list().find((session) => session.id === activeId()));
    /** Nothing sent to it: no prompt in its log, and none on its way. */
    const unsent = (session: SessionInfo) => isBlank(session) && !running().includes(session.id);
    const blank = createMemo(() => {
      const session = active();
      return session === undefined || unsent(session);
    });
    const leaf = createMemo(() => resolveLeaf(events(), active()?.leaf, active()?.lastSeq));
    const branch = createMemo(() => branchOf(events(), leaf()));
    const busy = createMemo(() => {
      const id = activeId();
      return id !== undefined && running().includes(id);
    });
    const activeQueue = createMemo<readonly QueuedPrompt[]>((previous) => waitingPrompts(queue()?.queue ?? [], leaving(), branch(), previous), []);
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
    const upsert = (info: SessionInfo) => setList((threads) => upsertSession(threads, info));
    /** Sessions deleted while the page is open. */
    const [removed, setRemoved] = createSignal<ReadonlySet<string>>(new Set());
    // A deleted session's address leaves for a new thread whenever the page shows it: at once, or on coming back to it
    // (closing settings opened over it, back and forward).
    createEffect(() => {
      const id = router.matchOf(ThreadRoute)?.params.id;
      if (id !== undefined && removed().has(id)) router.navigate(NewThreadRoute, {}, { replace: true });
    });
    const forget = (sessionId: string) => {
      setRemoved((ids) => new Set(ids).add(sessionId));
      setList((threads) => threads.filter((session) => session.id !== sessionId));
    };

    /**
     * The list, from `sessions.changes`: on each `subscribed`, listed afresh,
     * and the changes heard while that listing was on its way (which may be
     * older than they are) replayed over it.
     */
    let heard: Exclude<SessionsChange, { type: "subscribed" }>[] | undefined;
    const relist = () => {
      const since: typeof heard = [];
      heard = since;
      client.channel.call(SessionChannels.list, {}).then(
        (threads) => {
          if (heard !== since) return;
          heard = undefined;
          const shown = threads.filter((session) => !removed().has(session.id));
          batch(() => {
            setList(since.reduce(applySessionsChange, shown));
            setLoaded(true);
          });
        },
        (error) => {
          if (heard === since) heard = undefined;
          notify.report(error, "Sync failed");
        },
      );
    };
    plugin.onCleanup(
      client.follow(SessionChannels.changes, undefined, (change) => {
        if (change.type === "subscribed") return relist();
        heard?.push(change);
        if (change.type === "session-removed") forget(change.sessionId);
        else upsert(change.info);
      }),
    );

    /** Logs fetched before their thread opened (a link to it hovered): opening one follows on from it. */
    const preloaded = new Map<string, { readonly at: number; readonly events: Promise<readonly SessionEvent[]> }>();
    const fresh = (found: { readonly at: number } | undefined) => found !== undefined && Date.now() - found.at < PRELOAD_MS;
    const preload = (sessionId: string) => {
      if (sessionId === activeId() || fresh(preloaded.get(sessionId))) return;
      for (const [id, found] of preloaded) if (!fresh(found)) preloaded.delete(id);
      const events = client.channel.call(SessionChannels.events, { sessionId });
      // A failed preload is only a missed head start: opening reads the whole log.
      events.catch(() => preloaded.delete(sessionId));
      preloaded.set(sessionId, { at: Date.now(), events });
    };

    // Deltas and tool output arrive many times a frame; they are applied together, once per frame, in order. A hidden
    // tab gets no frames, so a long queue is applied at once instead.
    const QUEUE_LIMIT = 256;
    let deltas: Extract<AgentActivity, { type: "delta" | "tool-output" }>[] = [];
    let frame: number | undefined;
    function flushDeltas() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (deltas.length === 0) return;
      const pending = deltas;
      deltas = [];
      updateLive((state) =>
        pending.reduce(
          (next, event) =>
            event.type === "delta"
              ? applyDelta(next, event.turnId, event.stepId, event.event, event.seq)
              : appendOutput(next, event.toolCallId, event.chunk, event.offset),
          state,
        ),
      );
    }
    plugin.onCleanup(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    });

    /**
     * What the agent has of the open thread beyond its log (a turn running
     * since before this page saw it: its output so far; and the queue), so a
     * thread opened or reconnected midway shows it all. The numbered deltas
     * that follow continue from it: they are held while it is on its way and
     * replayed over it. Fetched beside the log, it may be older than the log
     * that arrived first, so it is checked against the log as it stands. Only
     * the latest view asked for is applied.
     */
    let joins = 0;
    const joinTurn = (sessionId: string) => {
      const join = ++joins;
      // What arrived before asking is older than the view: it applies as usual. What arrives from now is held.
      flushDeltas();
      updateLive(beginJoin);
      const done = (view: AgentView | undefined) =>
        batch(() => {
          if (joins !== join) return;
          flushDeltas();
          updateLive((state) => joinLive(state, view, untrack(events)));
          if (view !== undefined) reportQueue({ queue: view.queue, revision: view.queueRevision });
        });
      return client.channel.call(AgentChannels.view, { sessionId }).then(done, () => done(undefined));
    };

    plugin.onCleanup(
      client.follow(AgentChannels.activity, undefined, (activity) => {
        if (activity.type === "delta" || activity.type === "tool-output") {
          if (activity.sessionId !== activeId()) return;
          deltas.push(activity);
          if (deltas.length >= QUEUE_LIMIT) flushDeltas();
          else frame ??= requestAnimationFrame(flushDeltas);
          return;
        }
        // Everything else sees the deltas that came before it.
        flushDeltas();
        switch (activity.type) {
          case "subscribed": {
            // Heard from now on; what came before is the turns running now, and what the agent has of the open thread.
            setRunning(activity.running);
            const id = activeId();
            if (id !== undefined) void joinTurn(id);
            return;
          }
          case "turn-started":
            setRunning(trackTurn({ running: running(), ended: endedTurns }, activity).running);
            return;
          case "queue-changed":
            if (activity.sessionId === activeId()) reportQueue({ queue: activity.queue, revision: activity.revision });
            return;
          case "turn-ended": {
            const next = trackTurn({ running: running(), ended: endedTurns }, activity);
            endedTurns = next.ended;
            setRunning(next.running);
            if (activity.sessionId === activeId()) updateLive((state) => endTurn(state, activity.turnId));
            return;
          }
        }
      }),
    );

    /** The open thread's `sessions.log`. */
    let stopLog: (() => void) | undefined;
    plugin.onCleanup(() => stopLog?.());
    /** Settles once the active thread's log has first loaded. */
    let opened: Promise<void> = Promise.resolve();
    /** Follows the log of the thread the address names, and what the agent has of it, in place of the last one's. */
    const open = (sessionId: string | undefined) => {
      stopLog?.();
      stopLog = undefined;
      // What streamed, and what the agent was asked for, belong to the thread left.
      deltas = [];
      joins++;
      batch(() => {
        setEvents([]);
        setLog({ loaded: sessionId === undefined });
        setLive(emptyLive);
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
        const next = appendLog(untrack(events), incoming);
        if (next === untrack(events)) return;
        setEvents(next);
        updateLive((state) => reconcileLive(state, next));
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
      void joinTurn(sessionId);
    };
    createEffect(on(activeId, open));

    const href = (sessionId: string, view?: string) => router.href(ThreadRoute, { id: sessionId, ...(view === undefined ? {} : { view }) });
    const select = async (sessionId: string | undefined): Promise<void> => {
      // The thread as it was left: what beside its chat shows is its own (`Pane`), not the address's.
      router.navigate(sessionId === undefined ? router.href(NewThreadRoute, {}) : href(sessionId));
      await opened;
    };
    /** Goes to a new thread, in its first view; `replace`, in place of the address shown. */
    const go = async (sessionId: string, replace = false): Promise<void> => {
      router.navigate(href(sessionId), { replace });
      await opened;
    };

    /** A new, empty session in `cwd` (the host's directory when absent), listed; undefined, and reported, when it fails. */
    const create = async (cwd: string | undefined): Promise<SessionInfo | undefined> => {
      try {
        const info = await client.channel.call(SessionChannels.create, cwd === undefined ? {} : { cwd });
        upsert(info);
        return info;
      } catch (error) {
        notify.report(error, "Could not create a session");
        return undefined;
      }
    };
    const remove = async (sessionId: string) => {
      try {
        await client.channel.call(SessionChannels.delete, { sessionId });
        forget(sessionId);
      } catch (error) {
        notify.report(error, "Could not delete the session");
      }
    };
    /**
     * Moves a blank thread to `cwd` (`sessions.relocate`), another project picked for it or its first prompt's
     * worktree: it keeps its id, so its address, draft, and pane stay its own. False, and reported, when it failed.
     */
    const relocate = async (sessionId: string, cwd: string): Promise<boolean> => {
      try {
        upsert(await client.channel.call(SessionChannels.relocate, { sessionId, cwd }));
        return true;
      } catch (error) {
        notify.report(error, "Could not move the thread");
        return false;
      }
    };
    /**
     * The blank threads this tab made, kept across its reloads and seen by no other tab: the new-thread page lands on
     * one of these, and only these are moved or deleted here, never one another tab or window or a script (`lemma
     * sessions new`) made. One a closed tab left goes on the host once it has been empty a while (`SessionMarks.kept`).
     */
    const made = new Set(tabLoad(MADE_KEY));
    /** Told each change to `made`, for what follows which blank threads are this tab's. */
    const [madeChanged, setMadeChanged] = createSignal(0);
    const keepMade = () => {
      tabSave(MADE_KEY, [...made]);
      setMadeChanged((count) => count + 1);
    };
    /** The new threads being made, by directory: asked for again meanwhile, the one under way is the answer. */
    const making = new Map<string, Promise<SessionInfo | undefined>>();
    const tab = (cwd: string | undefined): Promise<SessionInfo | undefined> => {
      const key = cwd ?? "";
      const pending = making.get(key);
      if (pending !== undefined) return pending;
      const made_ = create(cwd)
        .then((info) => {
          if (info !== undefined) {
            made.add(info.id);
            keepMade();
          }
          return info;
        })
        .finally(() => making.delete(key));
      making.set(key, made_);
      return made_;
    };
    // One no longer blank (or gone) is no longer a tab to land on.
    createEffect(() => {
      if (!loaded()) return;
      const blanks = new Set(
        list()
          .filter(isBlank)
          .map((session) => session.id),
      );
      const before = made.size;
      for (const id of made) if (!blanks.has(id)) made.delete(id);
      if (made.size !== before) keepMade();
    });
    // A deleted thread's draft goes with it.
    createEffect(() => {
      if (!loaded()) return;
      const known = new Set(list().map((session) => session.id));
      // Deleting while iterating a Map is safe: the iteration goes on past each deleted key.
      for (const id of held.keys()) if (!known.has(id)) setDraft(id, undefined);
    });
    /** Something is kept for a thread: a draft, or what a plugin holds for it (`ThreadHolds`: a page in its pane). */
    const keeps = (sessionId: string) => drafts().has(sessionId) || slots.list(ThreadHolds).some((hold) => hold.holds(sessionId));
    // The host keeps a blank thread made here while something is kept for it, and lets one go once nothing is
    // (`SessionMarks.kept`): left in a tab that closed, it goes there once it has been empty a while.
    const marking = new Set<string>();
    createEffect(() => {
      if (!loaded()) return;
      madeChanged();
      for (const session of list()) {
        if (!made.has(session.id) || !isBlank(session) || marking.has(session.id)) continue;
        const kept = keeps(session.id);
        if ((session.kept === true) === kept) continue;
        marking.add(session.id);
        client.channel
          .call(SessionChannels.mark, { sessionId: session.id, kept })
          .then(upsert, () => {
            // Gone meanwhile, or the host away: tried again on the next change.
          })
          .finally(() => marking.delete(session.id));
      }
    });
    // A blank thread made here, left with nothing kept for it, goes, as a tab closed does: new threads do not pile up
    // on the host. Not for the new-thread page, which lands on it again.
    createEffect(
      on(activeId, (id, left) => {
        if (left === undefined || id === undefined || left === id) return;
        const session = untrack(list).find((candidate) => candidate.id === left);
        if (session === undefined || !made.has(left) || !unsent(session) || untrack(() => keeps(left))) return;
        // Quietly: one in use meanwhile (Busy) stays.
        client.channel.call(SessionChannels.delete, { sessionId: left }).then(
          () => forget(left),
          () => {},
        );
      }),
    );
    /** The blank threads being moved, so asking again while one is under way waits for it rather than racing it. */
    const moving = new Map<string, Promise<void>>();
    const newThread = async (cwd?: string, options: { readonly inPlace?: boolean } = {}): Promise<void> => {
      const shown = active();
      const dir = cwd ?? pendingCwd() ?? shown?.cwd;
      const over = options.inPlace === true && shown !== undefined && unsent(shown) && made.has(shown.id) ? shown : undefined;
      // Nowhere said yet (the workspace not yet known): the new-thread page, which makes one once there is somewhere.
      if (over === undefined && dir === undefined) return select(undefined);
      if (over === undefined) {
        // One new thread per directory: an empty one made here is gone to rather than another made beside it. One with a
        // prompt written in it is held as a draft, not empty.
        const empty = [...(shown === undefined ? [] : [shown]), ...list()].find(
          (session) => made.has(session.id) && unsent(session) && !drafts().has(session.id) && session.archived !== true && session.cwd === dir,
        );
        if (empty !== undefined) {
          if (router.matchOf(ThreadRoute)?.params.id !== empty.id) await go(empty.id);
          return;
        }
        const info = await tab(dir);
        if (info !== undefined) await go(info.id);
        return;
      }
      // Already there: it is the new thread, gone to from wherever is shown (settings, say).
      if (over.cwd === dir || dir === undefined) {
        if (router.matchOf(ThreadRoute)?.params.id !== over.id) await go(over.id);
        return;
      }
      const pending = moving.get(over.id);
      if (pending !== undefined) return pending;
      const done = relocate(over.id, dir)
        .then(() => {})
        .finally(() => moving.delete(over.id));
      moving.set(over.id, done);
      return done;
    };

    // The new-thread page shows a blank thread: the newest made here with nothing written in it, else one made once there
    // is somewhere to start it (`pendingCwd`), which the list then holds. Until then, or with nothing to say where, its
    // first prompt creates it. A place it could not be made in is not tried again until there is another.
    let landing = false;
    let failedIn: string | undefined;
    createEffect(() => {
      if (router.matchOf(NewThreadRoute) === undefined || !loaded()) return;
      const newest = list()
        .filter((session) => made.has(session.id) && isBlank(session) && !drafts().has(session.id) && session.archived !== true)
        .reduce<SessionInfo | undefined>((best, session) => (best === undefined || session.createdAt > best.createdAt ? session : best), undefined);
      if (newest !== undefined) return void router.navigate(href(newest.id), { replace: true });
      const cwd = pendingCwd();
      if (cwd === undefined || landing || cwd === failedIn) return;
      landing = true;
      void tab(cwd)
        .then((info) => {
          failedIn = info === undefined ? cwd : undefined;
          // Made, it is gone to: the list held it before it was known to be made here.
          if (info !== undefined && router.matchOf(NewThreadRoute) !== undefined) router.navigate(href(info.id), { replace: true });
        })
        .finally(() => (landing = false));
    });

    // An address from before threads had paths (`/#<id>`) becomes the thread's own.
    const fromHash = router.location().pathname === "/" ? hashThread() : undefined;
    if (fromHash !== undefined) router.navigate(href(fromHash), { replace: true });

    // The turns running, on the Plugins page: its reload restarts host plugins mid-turn.
    slots.add(PluginsFacts, {
      id: "threads.running",
      label: "Running",
      value: () => {
        const count = running().length;
        return count === 0 ? "no turns" : `${count} turn${count === 1 ? "" : "s"}`;
      },
    });

    const send = async (
      content: PromptContent,
      options: {
        readonly turn?: TurnOptions | undefined;
        readonly cwd?: string | undefined;
        readonly requestId?: string | undefined;
        readonly whenBusy?: "steer" | "follow-up" | undefined;
        readonly background?: boolean | undefined;
      } = {},
    ): Promise<boolean> => {
      const shown = active();
      let id: string;
      if (options.background === true) {
        const info = await create(options.cwd ?? shown?.cwd ?? pendingCwd());
        if (info === undefined) return false;
        id = info.id;
      } else if (shown === undefined) {
        const info = await create(options.cwd ?? pendingCwd());
        if (info === undefined) return false;
        await go(info.id);
        id = info.id;
      } else if (options.cwd !== undefined && options.cwd !== shown.cwd && unsent(shown)) {
        // A first prompt for elsewhere (its own worktree): the blank thread moves there. One another window or a script
        // made is not this one's to move: a new thread there takes the prompt, and is gone to.
        if (made.has(shown.id)) {
          if (!(await relocate(shown.id, options.cwd))) return false;
          id = shown.id;
        } else {
          const info = await create(options.cwd);
          if (info === undefined) return false;
          await go(info.id);
          id = info.id;
        }
      } else id = shown.id;
      setAnswered(undefined);
      if (!running().includes(id)) setRunning((current) => [...current, id]);
      const prompt = startPrompt(client, id, content, options.turn, {
        whenBusy: options.whenBusy ?? "steer",
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      });
      void prompt.done
        .catch(() => {})
        .finally(() => {
          // turn-ended and turn-started normally keep this; the prompt settling is the fallback when they were lost (a
          // page that falls behind loses the oldest activity). A queued prompt may already have started the next turn,
          // so ask rather than assume.
          void client.channel
            .call(AgentChannels.running, undefined)
            .then(setRunning)
            .catch(() => {});
        });
      // A refused prompt returns false so the composer keeps the text; failures after that are only reported.
      const accepted = await prompt.accepted.then(
        () => true,
        (error: unknown) => {
          // A plugin's refusal is its answer, shown by the composer; the agent's is a failure. One sent in the background
          // is answered where it was written, and the thread made for it goes again.
          // With no thread shown, the new-thread page's (`""`).
          const where = options.background === true ? (shown?.id ?? "") : id;
          if (error instanceof PromptRefused) setAnswered({ sessionId: where, kind: "refused", by: error.by, message: error.reason });
          else notify.report(error, "Prompt was not sent");
          if (options.background === true) void remove(id);
          return false;
        },
      );
      // A plugin's answer that came after the prompt was taken (handled, as a refusal comes first) is shown as it is.
      if (accepted)
        void prompt.done.then(
          (outcome) =>
            outcome.kind === "handled"
              ? setAnswered({ sessionId: id, kind: "handled", by: outcome.by, message: outcome.message ?? "" })
              : outcome.kind === "refused"
                ? setAnswered({ sessionId: id, kind: "refused", by: outcome.by, message: outcome.reason })
                : undefined,
          () => {},
        );
      // Accepted, the turn is the host's. A dropped connection holds this wait until the page is back, where the host
      // `channel.call` makes `agent.prompt` again (it is repeatable) and the page catches up. What the host reports is
      // shown.
      if (accepted) void prompt.done.catch((error) => (error instanceof HostError ? notify.report(error) : undefined));
      return accepted;
    };

    return {
      threads: {
        list,
        loaded,
        activeId,
        active,
        branch,
        log,
        live,
        running,
        busy,
        blank,
        pendingCwd,
        drafts,
        setDraft,
        select,
        href,
        preload,
        newThread,
        startIn: setPendingCwd,
        rename: async (sessionId: string, title: string) => {
          const trimmed = title.trim();
          if (trimmed === "") return;
          try {
            upsert(await client.channel.call(SessionChannels.setTitle, { sessionId, title: trimmed }));
          } catch (error) {
            notify.report(error, "Rename failed");
          }
        },
        mark: async (sessionId: string, marks: SessionMarks) => {
          try {
            upsert(await client.channel.call(SessionChannels.mark, { sessionId, ...marks }));
          } catch (error) {
            notify.report(error, "Could not update the session");
          }
        },
        fork: async (eventId?: string) => {
          const from = active();
          const at = eventId ?? from?.leaf;
          if (from === undefined || at === undefined) return;
          try {
            const forked = await client.channel.call(SessionChannels.fork, { sessionId: from.id, eventId: at });
            upsert(forked);
            await select(forked.id);
          } catch (error) {
            notify.report(error, "Could not fork the thread");
          }
        },
        remove,
        send,
        queue: activeQueue,
        answer: () => {
          const last = answered();
          return last !== undefined && last.sessionId === (activeId() ?? "") ? last : undefined;
        },
        dismissAnswer: () => setAnswered(undefined),
        withdraw: async (requestId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          // Gone once the agent has it out, not kept waiting for a log that will never have it.
          withdrawn.add(requestId);
          setLeaving((all) => all.filter((prompt) => prompt.requestId !== requestId));
          try {
            await client.channel.call(AgentChannels.withdraw, { sessionId, requestId });
          } catch (error) {
            notify.report(error, "Could not withdraw the prompt");
          }
        },
        promote: async (requestId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          try {
            await client.channel.call(AgentChannels.promote, { sessionId, requestId });
          } catch (error) {
            notify.report(error, "Could not steer with the prompt");
          }
        },
        cancel: () => {
          const sessionId = activeId();
          if (sessionId !== undefined) client.channel.call(AgentChannels.cancel, { sessionId }).catch((error) => notify.report(error, "Cancel failed"));
        },
        checkout: async (eventId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return false;
          try {
            upsert(await client.channel.call(SessionChannels.checkout, { sessionId, eventId }));
            return true;
          } catch (error) {
            notify.report(error, "Could not branch the session");
            return false;
          }
        },
      },
    };
  },
});
