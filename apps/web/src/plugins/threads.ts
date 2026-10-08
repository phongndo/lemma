import { batch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { describeError, startPrompt } from "@lemma/client";
import { AgentChannels, branchOf, HostError, SessionChannels } from "@lemma/contracts";
import { isRoute } from "@lemma/router";
import type { AgentActivity, AgentView, PromptContent, SessionEvent, SessionInfo, SessionMarks, SessionsChange, TurnOptions } from "@lemma/contracts";
import { appendOutput, applyDelta, beginJoin, emptyLive, endTurn, joinLive, reconcileLive } from "../model/live.ts";
import type { LiveState } from "../model/live.ts";
import { appendLog, applySessionsChange, newerQueue, resolveLeaf, trackTurn, upsertSession } from "../model/threads.ts";
import type { KnownQueue } from "../model/threads.ts";
import { Client, NewThreadRoute, Notify, PluginsFacts, Router, Slots, ThreadRoute, Threads } from "../ui/contracts.ts";
import type { LogState } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/** How long a preloaded log stays fresh enough to open with (ms). */
const PRELOAD_MS = 15_000;

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
export default defineUiPlugin({
  id: "threads",
  requires: { client: Client, notify: Notify, router: Router, slots: Slots },
  provides: { threads: Threads },
  setup: ({ client, notify, router, slots }, plugin) => {
    const [list, setList] = createSignal<readonly SessionInfo[]>([]);
    const [loaded, setLoaded] = createSignal(false);
    const [running, setRunning] = createSignal<readonly string[]>([]);
    const [pendingCwd, setPendingCwd] = createSignal<string>();
    // Event arrays and streaming drafts change often and are replaced wholesale.
    const [events, setEvents] = createSignal<readonly SessionEvent[]>([], { equals: false });
    const [log, setLog] = createSignal<LogState>({ loaded: true });
    /** The open thread's drafts and running tools' output: only the thread shown keeps them, and opening one asks the agent for its own. */
    const [live, setLive] = createSignal<LiveState>(emptyLive);
    /** The open thread's queue as the agent last reported it, with its revision: an older report never replaces a newer. */
    const [queue, setQueue] = createSignal<KnownQueue>();
    const reportQueue = (report: KnownQueue) => {
      const known = queue();
      const next = newerQueue(known, report);
      if (next !== known) setQueue(next);
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
    const leaf = createMemo(() => resolveLeaf(events(), active()?.leaf, active()?.lastSeq));
    const branch = createMemo(() => branchOf(events(), leaf()));
    const busy = createMemo(() => {
      const id = activeId();
      return id !== undefined && running().includes(id);
    });
    const activeQueue = createMemo(() => queue()?.queue ?? []);

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
            // A reload opens it again at once, and a dropped connection once it is back, from the last event this page
            // has; what else ends it (the session gone, its log unreadable) is said.
            if (error instanceof HostError && error.code === "Withdrawn") return;
            if (error instanceof HostError) setLog({ loaded: true, error: describeError(error) });
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
      // Switching threads keeps the view shown; a new thread opens in the first.
      const view = router.matchOf(ThreadRoute)?.params.view;
      router.navigate(sessionId === undefined ? router.href(NewThreadRoute, {}) : href(sessionId, view));
      await opened;
    };

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
      } = {},
    ): Promise<boolean> => {
      let sessionId = activeId();
      if (sessionId === undefined) {
        try {
          const cwd = options.cwd ?? pendingCwd();
          const info = await client.channel.call(SessionChannels.create, cwd === undefined ? {} : { cwd });
          setPendingCwd(undefined);
          upsert(info);
          await select(info.id);
          sessionId = info.id;
        } catch (error) {
          notify.report(error, "Could not create a session");
          return false;
        }
      }
      const id = sessionId;
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
          notify.report(error, "Prompt was not sent");
          return false;
        },
      );
      // Accepted, the turn is the host's: a dropped connection only ends this wait (the page reconnects and catches up).
      // What the host reports otherwise is shown.
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
        pendingCwd,
        select,
        href,
        preload,
        newThread: (cwd?: string) => {
          setPendingCwd(cwd);
          void select(undefined);
        },
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
        remove: async (sessionId: string) => {
          try {
            await client.channel.call(SessionChannels.delete, { sessionId });
            forget(sessionId);
          } catch (error) {
            notify.report(error, "Could not delete the session");
          }
        },
        send,
        queue: activeQueue,
        withdraw: async (requestId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          try {
            await client.channel.call(AgentChannels.withdraw, { sessionId, requestId });
          } catch (error) {
            notify.report(error, "Could not withdraw the prompt");
          }
        },
        cancel: () => {
          const sessionId = activeId();
          if (sessionId !== undefined) client.channel.call(AgentChannels.cancel, { sessionId }).catch((error) => notify.report(error, "Cancel failed"));
        },
        checkout: async (eventId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          try {
            upsert(await client.channel.call(SessionChannels.checkout, { sessionId, eventId }));
            notify.toast({ level: "info", message: "The next prompt continues from the chosen event, on a new branch." });
          } catch (error) {
            notify.report(error, "Could not branch the session");
          }
        },
      },
    };
  },
});
