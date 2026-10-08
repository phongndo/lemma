import { batch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { SessionLog, startPrompt } from "@lemma/client";
import { branchOf, HostError } from "@lemma/contracts";
import { isRoute } from "@lemma/router";
import type { AgentView, HostEvent, PromptContent, QueuedPrompt, SessionEvent, SessionInfo, SessionMarks, TurnOptions } from "@lemma/contracts";
import { appendOutput, applyDelta, beginJoin, dropOutput, emptyLive, endTurn, joinLive, reconcileLive, settleStep } from "../model/live.ts";
import type { LiveState } from "../model/live.ts";
import { newerQueue, resolveLeaf, trackTurn, upsertSession } from "../model/threads.ts";
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
 */
export default defineUiPlugin({
  id: "threads",
  requires: { client: Client, notify: Notify, router: Router, slots: Slots },
  provides: { threads: Threads },
  setup: ({ client, notify, router, slots }, plugin) => {
    const host = client.host;
    const [list, setList] = createSignal<readonly SessionInfo[]>([]);
    const [loaded, setLoaded] = createSignal(false);
    const [running, setRunning] = createSignal<readonly string[]>([]);
    const [pendingCwd, setPendingCwd] = createSignal<string>();
    // Event arrays and streaming drafts change often and are replaced wholesale.
    const [events, setEvents] = createSignal<readonly SessionEvent[]>([], { equals: false });
    const [log, setLog] = createSignal<LogState>({ loaded: true, syncing: false });
    const [live, setLive] = createSignal<Readonly<Record<string, LiveState>>>({});
    /** Each session's queue as the agent last reported it, with its revision: an older report never replaces a newer. */
    const [queues, setQueues] = createSignal<Readonly<Record<string, KnownQueue>>>({});
    const setQueue = (sessionId: string, queue: readonly QueuedPrompt[], revision: number) => {
      const known = queues()[sessionId];
      const next = newerQueue(known, { queue, revision });
      if (next !== known) setQueues({ ...queues(), [sessionId]: next });
    };

    let sessionLog: SessionLog | undefined;
    let stopLog: (() => void) | undefined;
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
    const activeLive = createMemo(() => {
      const id = activeId();
      return (id === undefined ? undefined : live()[id]) ?? emptyLive;
    });
    const busy = createMemo(() => {
      const id = activeId();
      return id !== undefined && running().includes(id);
    });
    const activeQueue = createMemo(() => {
      const id = activeId();
      return (id === undefined ? undefined : queues()[id]?.queue) ?? [];
    });

    const updateLive = (sessionId: string, update: (state: LiveState) => LiveState): void => {
      const current = live()[sessionId] ?? emptyLive;
      const next = update(current);
      if (next !== current) setLive({ ...live(), [sessionId]: next });
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

    const closeLog = () => {
      stopLog?.();
      sessionLog?.close();
      sessionLog = undefined;
      stopLog = undefined;
    };
    plugin.onCleanup(closeLog);

    /** Logs fetched before their thread opened (a link to it hovered): opening one takes it instead of fetching. */
    const preloaded = new Map<string, { readonly at: number; readonly events: Promise<readonly SessionEvent[]> }>();
    const fresh = (found: { readonly at: number } | undefined) => found !== undefined && Date.now() - found.at < PRELOAD_MS;
    const preload = (sessionId: string) => {
      if (sessionId === activeId() || fresh(preloaded.get(sessionId))) return;
      for (const [id, found] of preloaded) if (!fresh(found)) preloaded.delete(id);
      const events = host.session.events(sessionId, undefined);
      // A failed preload is only a missed head start: opening fetches again.
      events.catch(() => preloaded.delete(sessionId));
      preloaded.set(sessionId, { at: Date.now(), events });
    };

    /**
     * What the agent has of the thread beyond its log (a turn running since
     * before this page saw it: its output so far; and the queue), so a thread
     * opened or reconnected midway shows it all. The numbered deltas that
     * follow continue from it: they are held while it is on its way and
     * replayed over it. Fetched beside the log, it may be older than the log
     * that arrived first, so it is checked against the log as it stands. Only
     * the latest view asked for is applied.
     */
    const joins = new Map<string, number>();
    const joinTurn = (sessionId: string) => {
      const join = (joins.get(sessionId) ?? 0) + 1;
      joins.set(sessionId, join);
      // What arrived before asking is older than the view: it applies as usual. What arrives from now is held.
      flushDeltas();
      updateLive(sessionId, beginJoin);
      const done = (view: AgentView | undefined) =>
        batch(() => {
          if (joins.get(sessionId) !== join) return;
          flushDeltas();
          const log = sessionLog?.sessionId === sessionId ? untrack(events) : [];
          updateLive(sessionId, (state) => joinLive(state, view, log));
          if (view !== undefined) setQueue(sessionId, view.queue, view.queueRevision);
        });
      return host.agent.view(sessionId).then(done, () => done(undefined));
    };

    /** Settles once the active thread's log has first synced. */
    let opened: Promise<void> = Promise.resolve();
    /** Loads the log of the thread the address names, replacing the last one's. */
    const open = (sessionId: string | undefined) => {
      closeLog();
      batch(() => {
        setEvents([]);
        setLog({ loaded: sessionId === undefined, syncing: false });
      });
      if (sessionId === undefined) {
        opened = Promise.resolve();
        return;
      }
      const warm = preloaded.get(sessionId);
      preloaded.delete(sessionId);
      let head = fresh(warm) ? warm!.events.catch(() => host.session.events(sessionId, undefined)) : undefined;
      const next = new SessionLog({
        sessionId,
        fetch: (after) => {
          const taken = after === undefined ? head : undefined;
          head = undefined;
          return taken ?? host.session.events(sessionId, after);
        },
      });
      sessionLog = next;
      stopLog = next.subscribe((snapshot) =>
        batch(() => {
          setEvents(snapshot.events);
          updateLive(sessionId, (current) => reconcileLive(current, snapshot.events));
          setLog({ loaded: snapshot.loaded, syncing: snapshot.syncing, ...(snapshot.error === undefined ? {} : { error: snapshot.error }) });
        }),
      );
      opened = next
        .sync()
        // A preloaded log may predate the thread's latest events; the list knows its last, and the log catches up to it.
        .then(() => next.noteLastSeq(untrack(list).find((session) => session.id === sessionId)?.lastSeq ?? 0))
        .catch((error) => notify.report(error, "Could not load the session"));
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

    plugin.onCleanup(
      client.onConnect(() => {
        const tasks = [
          host.session.list().then((threads) => batch(() => (setList(threads), setLoaded(true)))),
          host.agent.running().then(setRunning),
          ...(sessionLog === undefined ? [] : [sessionLog.sync(), joinTurn(sessionLog.sessionId)]),
        ];
        void Promise.allSettled(tasks).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed !== undefined) notify.report((failed as PromiseRejectedResult).reason, "Sync failed");
        });
      }),
    );

    // Deltas and tool output arrive many times a frame; they are applied together, once per frame, in order. A hidden
    // tab gets no frames, so a long queue is applied at once instead.
    const QUEUE_LIMIT = 256;
    type Streamed = Extract<HostEvent, { type: "delta" | "tool-output" }>;
    let deltas: Streamed[] = [];
    let frame: number | undefined;
    function flushDeltas() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (deltas.length === 0) return;
      const pending = deltas;
      deltas = [];
      const bySession = new Map<string, typeof pending>();
      for (const event of pending) {
        const list = bySession.get(event.sessionId);
        if (list === undefined) bySession.set(event.sessionId, [event]);
        else list.push(event);
      }
      batch(() => {
        for (const [sessionId, events] of bySession)
          updateLive(sessionId, (state) =>
            events.reduce(
              (next, event) =>
                event.type === "delta"
                  ? applyDelta(next, event.turnId, event.stepId, event.event, event.seq)
                  : appendOutput(next, event.toolCallId, event.chunk, event.offset),
              state,
            ),
          );
      });
    }
    plugin.onCleanup(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    });

    plugin.onCleanup(
      client.onEvent((event) => {
        if (event.type === "delta" || event.type === "tool-output") {
          deltas.push(event);
          if (deltas.length >= QUEUE_LIMIT) flushDeltas();
          else frame ??= requestAnimationFrame(flushDeltas);
          return;
        }
        // Everything else sees the deltas that came before it.
        flushDeltas();
        switch (event.type) {
          case "session-appended": {
            const data = event.event.data;
            // The open session's log settles drafts itself once the event is in its gap-free prefix (`reconcileLive`); settling
            // here as well would drop a draft whose message is held back behind a gap.
            if (sessionLog?.sessionId === event.sessionId) sessionLog.apply(event.event);
            else if (data.type === "message" && data.message.role === "toolResult") {
              const toolCallId = data.message.toolCallId;
              updateLive(event.sessionId, (state) => dropOutput(state, toolCallId));
            } else if ((data.type === "message" && data.message.role === "assistant" && data.stepId !== undefined) || data.type === "attempt") {
              updateLive(event.sessionId, (state) => settleStep(state, data.stepId!));
            }
            return;
          }
          case "session-removed":
            forget(event.sessionId);
            return;
          case "session-changed":
            upsert(event.info);
            if (sessionLog?.sessionId === event.info.id) sessionLog.noteLastSeq(event.info.lastSeq);
            return;
          case "turn-started":
            setRunning(trackTurn({ running: running(), ended: endedTurns }, event).running);
            return;
          case "queue-changed":
            setQueue(event.sessionId, event.queue, event.revision);
            return;
          case "turn-ended": {
            const next = trackTurn({ running: running(), ended: endedTurns }, event);
            endedTurns = next.ended;
            setRunning(next.running);
            updateLive(event.sessionId, (state) => endTurn(state, event.turnId));
            return;
          }
        }
      }),
    );

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
          const info = await host.session.create(options.cwd ?? pendingCwd());
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
      const prompt = startPrompt(host, id, content, options.turn, {
        whenBusy: options.whenBusy ?? "steer",
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      });
      void prompt.done
        .catch(() => {})
        .finally(() => {
          // turn-ended and turn-started normally keep this; the prompt settling is the fallback when they were lost. A
          // queued prompt may already have started the next turn, so ask rather than assume.
          void host.agent
            .running()
            .then(setRunning)
            .catch(() => {});
          void sessionLog?.sync().catch(() => {});
        });
      // A refused prompt returns false so the composer keeps the text; failures after that are only reported.
      const accepted = await prompt.accepted.then(
        () => true,
        (error: unknown) => {
          notify.report(error, "Prompt was not sent");
          return false;
        },
      );
      // Accepted, the turn is the host's: a dropped connection only ends this wait (the page reconnects and catches up),
      // and a withdrawn prompt fails it on purpose. What the host reports otherwise is shown.
      if (accepted) void prompt.done.catch((error) => (error instanceof HostError && error.code !== "Retracted" ? notify.report(error) : undefined));
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
        live: activeLive,
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
            upsert(await host.session.setTitle(sessionId, trimmed));
          } catch (error) {
            notify.report(error, "Rename failed");
          }
        },
        mark: async (sessionId: string, marks: SessionMarks) => {
          try {
            upsert(await host.session.mark(sessionId, marks));
          } catch (error) {
            notify.report(error, "Could not update the session");
          }
        },
        remove: async (sessionId: string) => {
          try {
            await host.session.remove(sessionId);
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
            await host.agent.withdraw(sessionId, requestId);
          } catch (error) {
            notify.report(error, "Could not withdraw the prompt");
          }
        },
        cancel: () => {
          const sessionId = activeId();
          if (sessionId !== undefined) host.agent.cancel(sessionId).catch((error) => notify.report(error, "Cancel failed"));
        },
        checkout: async (eventId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          try {
            upsert(await host.session.checkout(sessionId, eventId));
            notify.toast({ level: "info", message: "The next prompt continues from the chosen event, on a new branch." });
          } catch (error) {
            notify.report(error, "Could not branch the session");
          }
        },
      },
    };
  },
});
