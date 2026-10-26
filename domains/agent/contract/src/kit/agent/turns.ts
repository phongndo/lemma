import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result, Scope } from "effect";
import { assert } from "@lemma/core";
import { InteractionOrigin } from "@lemma/contracts";
import type { ModelInfo } from "@lemma/llm";
import type { SessionInfo, TurnEndReason } from "@lemma/sessions";
import { AgentError } from "../../agent.ts";
import { failedAs } from "../errors.ts";
import { LiveTurn } from "../live.ts";
import { WITHDRAWN_KEPT } from "../queue.ts";
import type { Item, SessionState } from "../queue.ts";
import type { ResumePlan } from "../resume.ts";
import { LIVE_INTERVAL_MS, readLive, removeLive, writeLive } from "../state.ts";
import { runTurn } from "../turn.ts";
import type { Ended, TurnOutcome, TurnResume } from "../turn.ts";
import { forget, holdFor, placedOf, queueChanged, resolveModel } from "./context.ts";
import type { AgentContext, Running } from "./context.ts";

/*
 * A session's turn, from start to end: recorded in the journal before it reaches the log, run in the agent's scope in
 * a slot, with its output written beside the log as it goes; and once it ends, its prompts' callers answered and the
 * next queued prompt started.
 */

/**
 * How a suspended turn resumes, as its log says (`prepare`), with the model it continues on: none when it was being
 * cancelled, as it then only closes, asking nothing.
 */
export type Resumption =
  | { readonly kind: "ended"; readonly reason: TurnEndReason }
  | { readonly kind: "not-started"; readonly model: ModelInfo | undefined }
  | { readonly kind: "open"; readonly plan: ResumePlan; readonly model: ModelInfo | undefined };

/**
 * Turns running at once: a turn waits for a slot before its first event, and gives it up while it waits to
 * ask the model again. When the agent stops, a waiting turn suspends; a cancelled one closes without a slot.
 */
const takeSlot = (agent: AgentContext, entry: Running) =>
  Effect.flatMap(agent.slots.take(entry, Effect.raceFirst(Deferred.await(agent.stopping), Deferred.await(entry.cancelled))), (taken) =>
    taken || !agent.suspending ? Effect.void : Effect.interrupt,
  );
const inSlot = <A, E, R>(agent: AgentContext, entry: Running, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.ensuring(Effect.andThen(takeSlot(agent, entry), body), agent.slots.release(entry));
const idle =
  (agent: AgentContext, entry: Running) =>
  <A, E, R>(wait: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.andThen(
      agent.slots.release(entry),
      Effect.tap(wait, () => takeSlot(agent, entry)),
    );

/** The steers the running turn places between steps. Taken for placing, they cannot be withdrawn meanwhile. */
const inboxOf = (agent: AgentContext, sessionId: string, entry: Running) => ({
  steers: agent.admit.withPermits(1)(
    Effect.sync(() =>
      agent.queues
        .of(sessionId)
        .queue.filter((item) => item.prompt.mode === "steer")
        .map((item) => {
          item.placing = true;
          return placedOf(item.prompt);
        }),
    ),
  ),
  placed: (requestIds: readonly string[]) =>
    agent.admit.withPermits(1)(
      Effect.gen(function* () {
        const state = agent.queues.of(sessionId);
        const placed = new Set(requestIds);
        for (const item of state.queue) if (placed.has(item.prompt.requestId)) entry.items.set(item.prompt.requestId, item);
        yield* agent.queues.setQueue(
          state,
          state.queue.filter((item) => !placed.has(item.prompt.requestId)),
        );
        // Placed in the log already: the next start finds them there, whatever the journal says.
        yield* agent.queues.persistOrWarn(sessionId);
        yield* queueChanged(agent, sessionId);
      }),
    ),
});

/**
 * Writes the running turn's output so far beside the log while it
 * changes. A write in progress finishes before the writer stops, so
 * none lands after the turn's last write or its removal.
 */
const keepLive = (agent: AgentContext, sessionId: string, live: LiveTurn) =>
  Effect.forever(
    Effect.andThen(
      Effect.sleep(LIVE_INTERVAL_MS),
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (!live.dirty) return Effect.void;
          live.dirty = false;
          return writeLive(agent.files, sessionId, live.file());
        }),
      ),
    ),
  );

/** The turn starts running: whether it was cancelled first. */
const begin = (entry: Running) =>
  Effect.sync(() => {
    entry.started = true;
    return entry.cancelling;
  });

/** What a turn of `entry` runs with, fresh or resumed, besides its model, its prompts, and where it resumes. */
const turnInput = (agent: AgentContext, sessionId: string, entry: Running, info: SessionInfo) => ({
  sessionId,
  turnId: entry.turnId,
  cwd: info.cwd,
  signal: entry.controller.signal,
  inbox: inboxOf(agent, sessionId, entry),
  live: entry.live,
  logged: (requestId: string) => void agent.requests.of(sessionId).set(requestId, entry.turnId),
  suspended: () => agent.suspending,
  stopping: Deferred.await(agent.stopping),
  idle: idle(agent, entry),
  kept: agent.branches.of(sessionId),
  unclosed: (ended: Ended) => void (entry.unclosed = ended),
  ...(info.title === undefined ? {} : { title: info.title }),
});

/** A new turn, begun, on `model`. */
const begun = (agent: AgentContext, sessionId: string, entry: Running, info: SessionInfo, model: ModelInfo) => {
  const thinking = entry.prompts.at(-1)?.options?.thinking;
  const plugins = entry.prompts.at(-1)?.options?.plugins;
  return runTurn(agent.services, agent.settings, {
    ...turnInput(agent, sessionId, entry, info),
    model,
    prompts: entry.prompts.map(placedOf),
    ...(thinking === undefined ? {} : { thinking }),
    ...(plugins === undefined ? {} : { plugins }),
  });
};

/** A new turn: the prompts it starts with, the last one's options choosing the model. */
const fresh = (agent: AgentContext, sessionId: string, entry: Running) =>
  Effect.gen(function* () {
    // Cancelled while it waited for a slot, it never runs, as a queued prompt withdrawn.
    if (yield* begin(entry)) return "cancelled" as const;
    const info = yield* agent.sessions.get(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
    return yield* begun(agent, sessionId, entry, info, yield* resolveModel(agent, sessionId, entry.prompts.at(-1)?.options));
  });

/**
 * A turn a restart cut off, continued once the composition is up (the tools it may run again are registered), as
 * `prepare` read it: nothing it needed from the store or the models is left to fail before it runs.
 */
const resumed = (agent: AgentContext, sessionId: string, entry: Running, info: SessionInfo, resumption: Resumption) =>
  Effect.gen(function* () {
    // Stopping before then, it stays as it is, for the next start. Cancelled, it closes without the tools.
    const up = yield* Effect.raceAll([
      Effect.as(agent.host.composition, true),
      Effect.as(Deferred.await(entry.cancelled), true),
      Effect.as(Deferred.await(agent.stopping), false),
    ]);
    if (!up) return yield* Effect.interrupt;
    const cancelling = yield* begin(entry);
    // Cut off before its first event: cancelled meanwhile, it never runs. (It has no model only if cancelled.)
    if (resumption.kind === "not-started") {
      if (entry.closing !== undefined) return entry.closing.reason;
      return cancelling || resumption.model === undefined ? ("cancelled" as const) : yield* begun(agent, sessionId, entry, info, resumption.model);
    }
    if (resumption.kind === "ended") return resumption.reason;
    const { plan, model } = resumption;
    const restored = yield* readLive(agent.files, sessionId);
    const turnResume: TurnResume = {
      plan,
      cancelling,
      ...(restored?.turnId === entry.turnId ? { restored } : {}),
      ...(entry.closing === undefined ? {} : { closing: entry.closing }),
    };
    return yield* runTurn(agent.services, agent.settings, {
      ...turnInput(agent, sessionId, entry, info),
      ...(model === undefined ? {} : { model }),
      prompts: entry.prompts.filter((prompt) => !plan.placed.has(prompt.requestId)).map(placedOf),
      resume: turnResume,
      ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
      ...(plan.plugins === undefined ? {} : { plugins: plan.plugins }),
    });
  });

/** How `start` starts a turn: a fresh one by default. */
export interface StartOptions {
  /** It resumes, as `prepare` read it. */
  readonly resume?: { readonly info: SessionInfo; readonly resumption: Resumption };
  readonly cancelling?: boolean;
  readonly marked?: boolean;
  readonly closing?: Ended;
  /** What starting it changes of the session's state (the queue it takes its prompts from). */
  readonly taking?: (state: SessionState<Running>) => Effect.Effect<void>;
}

/**
 * Starts a turn in the session (under `admit`), holding it with `lease`
 * (`holdFor`) until the turn has stopped. It is recorded in the journal
 * before anything reaches the log, with the prompts it starts with, and
 * with what `taking` changes of the session's state for it (the queue it
 * takes them from), so a crash at any point leaves enough to resume or
 * restart it. A new turn the journal cannot record does not start: this
 * fails `Io`, the session as it was (`recorded`) and the lease closed.
 */
export const start = (
  agent: AgentContext,
  sessionId: string,
  turnId: string,
  prompts: readonly Item[],
  lease: Scope.Closeable,
  options: StartOptions = {},
): Effect.Effect<Running, AgentError> =>
  Effect.gen(function* () {
    const entry: Running = {
      turnId,
      controller: new AbortController(),
      startedAt: yield* Clock.currentTimeMillis,
      fiber: yield* Deferred.make<Fiber.Fiber<TurnOutcome, AgentError>>(),
      cancelled: yield* Deferred.make<void>(),
      ended: yield* Deferred.make<void, AgentError>(),
      live: new LiveTurn(turnId),
      prompts: prompts.map((item) => item.prompt),
      items: new Map(prompts.map((item) => [item.prompt.requestId, item])),
      slot: false,
      started: false,
      cancelling: options.cancelling ?? false,
      marked: options.marked ?? true,
      closing: options.closing,
      unclosed: undefined,
    };
    const { resume } = options;
    const occupy = (state: SessionState<Running>) =>
      Effect.andThen(
        options.taking?.(state) ?? Effect.void,
        Effect.sync(() => {
          assert(state.turn === undefined, `session ${sessionId} starts turn ${turnId} while turn ${state.turn?.turnId} runs`);
          assert(state.suspended === undefined, `session ${sessionId} starts turn ${turnId} while one is suspended`);
          state.turn = entry;
          // One that only closes runs no queue on if it was held (see `ended`).
          if (options.closing === undefined) state.held = false;
        }),
      );
    // A resumed turn is in the journal already, as the last instance left it.
    if (resume !== undefined) yield* Effect.andThen(occupy(agent.queues.of(sessionId)), agent.queues.persistOrWarn(sessionId));
    else yield* agent.queues.recorded(sessionId, occupy).pipe(Effect.tapError(() => Scope.close(lease, Exit.void)));
    const body = agent.services.trace(
      "agent.turn",
      inSlot(agent, entry, resume === undefined ? fresh(agent, sessionId, entry) : resumed(agent, sessionId, entry, resume.info, resume.resumption)),
    );
    const fiber = yield* Effect.forkIn(
      Effect.interruptible(
        Effect.provideService(
          Effect.gen(function* () {
            const writer = yield* Effect.forkChild(keepLive(agent, sessionId, entry.live));
            return yield* body.pipe(Effect.ensuring(Fiber.interrupt(writer)));
          }),
          InteractionOrigin,
          `session:${sessionId}`,
        ),
      ).pipe(Effect.onExit((exit) => Effect.ensuring(ended(agent, sessionId, entry, exit), Scope.close(lease, Exit.void)))),
      agent.turns,
      // Uninterruptible until the body begins, so `ended` runs, and the hold goes, however early the turn is cut
      // off. The hold goes after `ended`, which holds the session again for the next turn it starts.
      { uninterruptible: true },
    );
    yield* Deferred.succeed(entry.fiber, fiber);
    return entry;
  });

/** A turn that ended so lets the queue run on: one that failed or was cancelled holds it for the next prompt. */
const runsOn = (reason: TurnOutcome) => reason === "done" || reason === "max-steps";

/**
 * A turn that ended, but not in the log, kept in the journal, suspended, before its callers hear: it is closed so
 * when its session is next taken up (prompted, cancelled, or at the next start), and the queue then runs on as it
 * would have now. Without its prompts, as any turn that ended: one sent again is found in the log if the turn placed
 * it, and is a new prompt if not, rather than waiting on a close that will not place it.
 */
const keepUnclosed = (agent: AgentContext, sessionId: string, entry: Running, state: SessionState<Running>, unclosed: Ended) =>
  Effect.gen(function* () {
    yield* writeLive(agent.files, sessionId, entry.live.file());
    state.suspended = {
      turnId: entry.turnId,
      prompts: [],
      marked: entry.marked,
      cancelling: entry.cancelling,
      closing: unclosed,
    };
    state.restored = true;
    state.held = state.queue.length > 0 && !runsOn(unclosed.reason);
    state.ranToEnd = runsOn(unclosed.reason);
    for (const item of state.queue) item.placing = false;
    yield* agent.queues.persistOrWarn(sessionId);
  });

/**
 * The queue after a turn that ended: its next prompt starts a turn when this one ran to its end (or, for one that only
 * closed, unless the queue was held), and otherwise it waits for the next prompt.
 */
const runQueueOn = (agent: AgentContext, sessionId: string, entry: Running, state: SessionState<Running>, reason: TurnOutcome) =>
  Effect.gen(function* () {
    state.ranToEnd = runsOn(reason);
    const next = state.queue[0];
    // One that only closes ended before: the queue runs on unless that held it, and a prompt since let it go.
    if (next !== undefined && (entry.closing === undefined ? runsOn(reason) : !state.held)) {
      // This turn holds the session still, so it is not being deleted: only one gone some other way refuses, and
      // the queue then waits for the next prompt, which reports it.
      const lease = yield* Effect.result(holdFor(agent, sessionId));
      if (Result.isSuccess(lease)) {
        const started = yield* Effect.result(
          start(agent, sessionId, agent.newId(), [next], lease.success, { taking: (state) => agent.queues.setQueue(state, state.queue.slice(1)) }),
        );
        if (Result.isSuccess(started)) {
          yield* queueChanged(agent, sessionId);
          return;
        }
        // Not recorded, so not started: the queue waits, as the next prompt or a retry will tell its caller.
        yield* Effect.logWarning(`agent: ${started.failure.message}; the queue waits for the next prompt`);
      }
    }
    state.held = state.queue.length > 0;
    forget(agent, sessionId, state);
    yield* agent.queues.persistOrWarn(sessionId);
  });

/**
 * After a turn's fiber exits: its prompts' callers are answered, and
 * the next queued prompt starts a turn when this one finished. A turn
 * left open (suspended by the agent closing, or stopped by the core
 * shutting down) keeps its journal and output, to resume.
 */
const ended = (agent: AgentContext, sessionId: string, entry: Running, exit: Exit.Exit<TurnOutcome, AgentError>): Effect.Effect<void> =>
  agent.admit.withPermits(1)(
    Effect.gen(function* () {
      const state = agent.queues.of(sessionId);
      assert(state.turn === entry || state.turn === undefined, `session ${sessionId} ran turn ${state.turn?.turnId} beside ${entry.turnId}`);
      if (state.turn === entry) state.turn = undefined;
      const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
      const answer: Exit.Exit<void, AgentError> = Exit.isSuccess(exit) || interrupted ? Exit.void : Exit.asVoid(exit);
      // A prompt a cancelled turn never placed (it was cancelled before it began) did not run: its call hears so, as
      // a withdrawn one's does, rather than that it was placed.
      const cancelled = (Exit.isSuccess(exit) && exit.value === "cancelled") || (interrupted && !agent.suspending);
      const answerFor = (item: Item): Exit.Exit<void, AgentError> =>
        cancelled && agent.requests.of(sessionId).get(item.prompt.requestId) !== entry.turnId
          ? Exit.fail(new AgentError({ sessionId, reason: "Retracted", message: "The turn was cancelled before it placed the prompt" }))
          : answer;
      const settle = Effect.forEach([...entry.items.values()], (item) => Deferred.done(item.done, answerFor(item)), { discard: true }).pipe(
        Effect.andThen(Deferred.done(entry.ended, answer)),
      );
      // Remembered as a withdrawn prompt is, before its caller hears: sent again (a client that never heard), it is
      // refused, not placed.
      // (One that only closes did so when it ended.)
      const retractedIds =
        cancelled && entry.closing === undefined
          ? [...entry.items.values()].filter((item) => Exit.isFailure(answerFor(item))).map((item) => item.prompt.requestId)
          : [];
      if (retractedIds.length > 0) {
        state.withdrawn = [...state.withdrawn, ...retractedIds].slice(-WITHDRAWN_KEPT);
        // Written as the turn will end it: a cancelled turn runs no queue on, which waits for the next prompt.
        state.held = state.queue.length > 0;
        yield* agent.queues.persistOrWarn(sessionId);
      }
      if ((interrupted && agent.suspending) || (Exit.isSuccess(exit) && exit.value === "suspended")) {
        yield* writeLive(agent.files, sessionId, entry.live.file());
        return yield* settle;
      }
      if (entry.unclosed !== undefined) {
        yield* keepUnclosed(agent, sessionId, entry, state, entry.unclosed);
        return yield* settle;
      }
      yield* removeLive(agent.files, sessionId);
      yield* settle;
      // Steers this turn took but did not place (it ended first) can be withdrawn again.
      for (const item of state.queue) item.placing = false;
      yield* runQueueOn(agent, sessionId, entry, state, Exit.isSuccess(exit) ? exit.value : interrupted ? "cancelled" : "error");
    }),
  );
