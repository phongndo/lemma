import { Deferred, Effect } from "effect";
import type { Scope } from "effect";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";
import { AgentError } from "../../agent.ts";
import { failedAs } from "../errors.ts";
import type { SessionState, Suspended } from "../queue.ts";
import { planResume } from "../resume.ts";
import { gone, holdFor, queueChanged, resolveModel } from "./context.ts";
import type { AgentContext, Running } from "./context.ts";
import { start } from "./turns.ts";
import type { Resumption } from "./turns.ts";

/*
 * Sessions the last instance left (their journals, restored), taken up: each checked against its log, which is the
 * truth, then its suspended turn resumed, or its queue run on. And a session deleted, which takes its state with it.
 */

/** What taking up a restored session needs from the store and the models, read once (`prepare`). */
export interface Prepared {
  readonly info: SessionInfo;
  /** Its suspended turn, as it was when read, and how that resumes. */
  readonly turn?: { readonly suspended: Suspended; readonly resumption: Resumption };
}

/**
 * A deleted session's queue, suspended turn and journal go with it. No turn runs in it: each held it (see
 * `holdFor`). It takes no lock but the journal's writes, whose holders wait on the disk alone, and calls nothing
 * outside the agent.
 */
export const removed = (agent: AgentContext, sessionId: string) =>
  Effect.gen(function* () {
    const state = agent.queues.drop(sessionId);
    agent.requests.drop(sessionId);
    agent.branches.drop(sessionId);
    for (const item of state?.queue ?? []) {
      yield* Deferred.fail(item.done, new AgentError({ sessionId, reason: "Session", message: `Session ${sessionId} was deleted` }));
    }
    yield* agent.queues.removeFiles(sessionId);
  });

/**
 * Checks a restored session's queue against its log (under `admit`), which is all it needs: queued prompts the
 * log has were placed before the last instance stopped, whatever the journal said, so they leave the queue.
 */
const reconcile = (agent: AgentContext, sessionId: string, log: readonly SessionEvent[]) =>
  Effect.gen(function* () {
    const state = agent.queues.get(sessionId);
    if (state === undefined || !state.unchecked) return;
    agent.requests.index(sessionId, log);
    const placed = agent.requests.of(sessionId);
    const queue = state.queue.filter((item) => !placed.has(item.prompt.requestId));
    state.unchecked = false;
    if (queue.length === state.queue.length) return;
    yield* agent.queues.setQueue(state, queue);
    // Placed, as the log says: a journal that still has them is checked against it again on the next start.
    yield* agent.queues.persistOrWarn(sessionId);
    yield* queueChanged(agent, sessionId);
  });

/**
 * What reading or changing a session's queue needs first: a restored one's checked against its log (`reconcile`),
 * reading the log if that was not done yet. Fails as the reading does, as the queue cannot be told without it; a
 * session found gone takes its state with it.
 */
export const checked = (agent: AgentContext, sessionId: string): Effect.Effect<void, AgentError> =>
  Effect.suspend(() =>
    agent.queues.get(sessionId)?.unchecked !== true
      ? Effect.void
      : agent.sessions.events(sessionId).pipe(
          Effect.mapError(failedAs(sessionId, "Session")),
          Effect.flatMap((log) => agent.admit.withPermits(1)(reconcile(agent, sessionId, log))),
          Effect.catchIf(gone, () => removed(agent, sessionId)),
        ),
  );

/** How a suspended turn the log says is open resumes, and on what model, unless it only closes. */
const resumptionOf = (agent: AgentContext, sessionId: string, suspended: Suspended, log: readonly SessionEvent[]) =>
  Effect.gen(function* () {
    const resume = planResume(log, suspended.turnId, suspended.marked);
    if (resume.kind === "ended") return resume;
    // Being cancelled, or closed as it ended, it only closes, so no model need resolve.
    if (suspended.cancelling || suspended.closing !== undefined) return { ...resume, model: undefined };
    const resumption: Resumption =
      resume.kind === "not-started"
        ? { kind: "not-started", model: yield* resolveModel(agent, sessionId, suspended.prompts.at(-1)?.prompt.options) }
        : {
            kind: "open",
            plan: resume.plan,
            // The model it ran on, if it still exists; else the default, as a new turn would get.
            model:
              resume.plan.model === undefined
                ? yield* resolveModel(agent, sessionId)
                : yield* agent.llm.model(resume.plan.model).pipe(Effect.catch(() => resolveModel(agent, sessionId))),
          };
    return resumption;
  });

/**
 * Reads what taking up a restored session needs, once: its log, checking its queue against it (`reconcile`) at
 * once, as that needs nothing more; then its info and, for its suspended turn, how that resumes and the model it
 * continues on. Outside `admit`, as it waits on the store, the session held (`ready`). It changes nothing else,
 * so a failure leaves the session as it was, its queue checked if the log was read, to be taken up later.
 */
const prepare = (agent: AgentContext, sessionId: string, suspended: Suspended | undefined): Effect.Effect<Prepared, AgentError> =>
  Effect.gen(function* () {
    const log = yield* agent.sessions.events(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
    yield* agent.admit.withPermits(1)(reconcile(agent, sessionId, log));
    const info = yield* agent.sessions.get(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
    // A damaged log takes no writes: its turn cannot close, nor its queue run, until it is forked.
    if (info.damaged !== undefined) {
      return yield* new AgentError({
        sessionId,
        reason: "Session",
        message: `Session ${sessionId} is damaged at line ${info.damaged.line} (${info.damaged.reason}), so it takes no turns; fork it to go on`,
      });
    }
    if (suspended === undefined) return { info };
    return { info, turn: { suspended, resumption: yield* resumptionOf(agent, sessionId, suspended, log) } };
  });

/**
 * Holds the session until the scope closes, before admission, so a wait for its deletion to end holds up no
 * other session and can be interrupted, and the hold a turn takes under `admit` does not wait (see `holdFor`); and
 * reads it if it is restored (`prepare`). A session found gone takes its state with it.
 */
export const ready = (agent: AgentContext, sessionId: string): Effect.Effect<Prepared | undefined, AgentError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* agent.sessions.hold(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
    const state = agent.queues.get(sessionId);
    return state?.restored === true ? yield* prepare(agent, sessionId, state.suspended) : undefined;
  }).pipe(Effect.tapError((error) => (gone(error) ? removed(agent, sessionId) : Effect.void)));

/**
 * Takes a restored session up as `prepared` read it (under `admit`, the session held already, its queue checked):
 * its suspended turn resumes, or else its queue runs on, unless held. Nothing changes before the turn's hold is
 * taken, which can fail.
 */
export const reopen = (agent: AgentContext, sessionId: string, prepared: Prepared) =>
  Effect.gen(function* () {
    const state = agent.queues.get(sessionId);
    // Taken up meanwhile, or gone.
    if (state === undefined || !state.restored || state.unchecked || state.suspended !== prepared.turn?.suspended) return;
    const { turn } = prepared;
    const next = turn === undefined && !state.held ? state.queue[0] : undefined;
    const lease = turn !== undefined || next !== undefined ? yield* holdFor(agent, sessionId) : undefined;
    const takenUp = (taken: SessionState<Running>) =>
      Effect.sync(() => {
        taken.restored = false;
        taken.suspended = undefined;
      });
    if (lease !== undefined && turn !== undefined) {
      const { suspended, resumption } = turn;
      yield* start(agent, sessionId, suspended.turnId, suspended.prompts, lease, {
        resume: { info: prepared.info, resumption },
        cancelling: suspended.cancelling,
        marked: suspended.marked,
        ...(suspended.closing === undefined ? {} : { closing: suspended.closing }),
        taking: takenUp,
      });
    } else if (lease !== undefined && next !== undefined) {
      // Not recorded, so not started: the session stays to be taken up later.
      yield* start(agent, sessionId, agent.newId(), [next], lease, {
        taking: (taken) => Effect.andThen(takenUp(taken), agent.queues.setQueue(taken, taken.queue.slice(1))),
      });
      yield* queueChanged(agent, sessionId);
    } else yield* takenUp(state);
  });

/** A restored session `resume` could not take up stays as it was, to be taken up when next prompted, or at the next start. */
export const notTakenUp = (sessionId: string) => (error: AgentError) =>
  gone(error)
    ? Effect.void
    : Effect.logWarning(`agent: could not take up session ${sessionId}: ${error.message}; it is taken up when next prompted, or at the next start`);

/** Takes a restored session up now (`ready`, then `reopen`); fails as `ready` does, the session left as it was. */
export const resume = (agent: AgentContext, sessionId: string): Effect.Effect<void, AgentError> =>
  Effect.scoped(
    Effect.flatMap(ready(agent, sessionId), (prepared) =>
      prepared === undefined ? Effect.void : agent.admit.withPermits(1)(Effect.uninterruptible(reopen(agent, sessionId, prepared))),
    ),
  );
