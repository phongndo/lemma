import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { PromptRefused, startPrompt } from "@lemma/agent/prompt";
import { HostError } from "@lemma/contracts";
import { AgentChannels } from "@lemma/agent";
import { SessionChannels, NewThreadRoute, ThreadRoute } from "@lemma/sessions";
import { isRoute } from "@lemma/router";
import type { PromptContent, TurnOptions } from "@lemma/agent";
import type { SessionInfo, SessionMarks, SessionsChange } from "@lemma/sessions";
import { applySessionsChange, isBlank, Threads, THREADS_CONTRACT, trackTurn, upsertSession } from "@lemma/threads";
import type { PromptAnswer } from "@lemma/threads";
import { PluginsFacts } from "@lemma/settings";
import { Client, Notify, Router, Slots, defineWebPlugin } from "@lemma/web";
import { createAttention } from "./attention.ts";
import { manageBlankThreads } from "./blank.ts";
import { createDrafts } from "./drafts.ts";
import { followOpen } from "./follow.ts";

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
 * open thread's `sessions.log`. Its parts are modules of their own: the drafts
 * (`drafts.ts`), each thread's attention (`attention.ts`), the open thread
 * (`follow.ts`), and this tab's blank threads (`blank.ts`).
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
    const drafts = createDrafts(plugin, { list, loaded });

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
    const busy = createMemo(() => {
      const id = activeId();
      return id !== undefined && running().includes(id);
    });
    const attention = createAttention(plugin, slots, { list, loaded, running, activeId });

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
    const open = followOpen(plugin, client, { activeId, active });

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
          const listed = threads.filter((session) => !removed().has(session.id));
          batch(() => {
            setList(since.reduce(applySessionsChange, listed));
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

    /** The last ended turn per session, so a late `turn-started` cannot mark it running again (see `trackTurn`). */
    let endedTurns: Readonly<Record<string, string>> = {};
    // Every thread's turns and queue; only the open thread's output, on a stream of its own (`followOpen`).
    plugin.onCleanup(
      client.follow(AgentChannels.activity, { output: false }, (activity) => {
        // What the open thread streamed before it comes first.
        open.flush();
        switch (activity.type) {
          case "subscribed":
            // Heard from now on; what came before is the turns running now.
            setRunning(activity.running);
            return;
          case "turn-started":
            // A late start of a turn already over is not a new turn.
            if (endedTurns[activity.sessionId] !== activity.turnId) attention.turnStarted(activity.sessionId);
            setRunning(trackTurn({ running: running(), ended: endedTurns }, activity).running);
            return;
          case "queue-changed":
            if (activity.sessionId === activeId()) open.reportQueue({ queue: activity.queue, revision: activity.revision });
            return;
          case "turn-ended": {
            const next = trackTurn({ running: running(), ended: endedTurns }, activity);
            endedTurns = next.ended;
            batch(() => {
              setRunning(next.running);
              attention.turnEnded(activity.sessionId, activity.reason);
            });
            if (activity.sessionId === activeId()) open.turnEnded(activity.turnId);
            return;
          }
        }
      }),
    );

    const href = (sessionId: string, view?: string) => router.href(ThreadRoute, { id: sessionId, ...(view === undefined ? {} : { view }) });
    const select = async (sessionId: string | undefined): Promise<void> => {
      // The thread as it was left: what beside its chat shows is its own (`Pane`), not the address's.
      router.navigate(sessionId === undefined ? router.href(NewThreadRoute, {}) : href(sessionId));
      await open.opened();
    };
    /** Goes to a thread, in its first view; `replace`, in place of the address shown. */
    const go = async (sessionId: string, replace = false): Promise<void> => {
      router.navigate(href(sessionId), { replace });
      await open.opened();
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
    const blanks = manageBlankThreads({
      client,
      slots,
      list,
      loaded,
      activeId,
      active,
      pendingCwd,
      drafted: (sessionId) => drafts.drafts().has(sessionId),
      unsent,
      addressed: () => router.matchOf(ThreadRoute)?.params.id,
      onNewThreadPage: () => router.matchOf(NewThreadRoute) !== undefined,
      go,
      select,
      create,
      relocate,
      forget,
      upsert,
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
        if (blanks.madeHere(shown.id)) {
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
      attention.sent(id);
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
        branch: open.branch,
        log: open.log,
        live: open.live,
        running,
        busy,
        attention: attention.attention,
        markSeen: attention.markSeen,
        blank,
        pendingCwd,
        ...drafts,
        select,
        href,
        preload: open.preload,
        newThread: blanks.newThread,
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
        queue: open.queue,
        answer: () => {
          const last = answered();
          return last !== undefined && last.sessionId === (activeId() ?? "") ? last : undefined;
        },
        dismissAnswer: () => setAnswered(undefined),
        withdraw: async (requestId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          open.withdrawing(requestId);
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
