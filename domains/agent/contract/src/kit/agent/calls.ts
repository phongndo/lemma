import { Clock, Deferred, Effect, Fiber } from "effect";
import type { ResultCredit } from "@lemma/contracts";
import { AgentError } from "../../agent.ts";
import type { AgentView, PromptContent, PromptOptions, PromptOutcome, QueuedPrompt, TurnOptions } from "../../agent.ts";
import { admission, WITHDRAWN_KEPT } from "../queue.ts";
import type { Item } from "../queue.ts";
import { forget, holdFor, queueChanged, retractedError } from "./context.ts";
import type { AgentContext } from "./context.ts";
import { checked, notTakenUp, ready, reopen, resume } from "./takeup.ts";
import type { Prepared } from "./takeup.ts";
import { start } from "./turns.ts";

/*
 * What a caller asks of the agent (`Agent`): a prompt placed, queued, or refused; a turn cancelled; a queued prompt
 * withdrawn or promoted; and a session's live view.
 */

/** A submitted prompt, as the queue and a turn keep it, with a `done` its caller awaits. */
const makeItem = (agent: AgentContext, content: PromptContent, options: PromptOptions, mode: QueuedPrompt["mode"], credit?: ResultCredit) =>
  Effect.gen(function* () {
    const turnOptions = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    };
    const item: Item = {
      prompt: {
        requestId: options.requestId ?? `p-${agent.newId()}`,
        content,
        mode,
        ...(Object.keys(turnOptions).length === 0 ? {} : { options: turnOptions }),
        at: yield* Clock.currentTimeMillis,
        ...(credit === undefined ? {} : { credit }),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.source === undefined || options.display === undefined ? {} : { display: options.display }),
      },
      done: yield* Deferred.make<void, AgentError>(),
      placing: false,
    };
    return item;
  });

/** Whether the session knows the prompt `requestId` names: placed, queued, withdrawn, or in a turn, running or suspended. */
const known = (agent: AgentContext, sessionId: string, requestId: string | undefined) => {
  if (requestId === undefined) return false;
  const state = agent.queues.get(sessionId);
  return (
    agent.requests.of(sessionId).has(requestId) ||
    state?.withdrawn.includes(requestId) === true ||
    state?.queue.some((item) => item.prompt.requestId === requestId) === true ||
    state?.turn?.items.has(requestId) === true ||
    state?.suspended?.prompts.some((item) => item.prompt.requestId === requestId) === true
  );
};

/** A prompt as `AgentInputHook` placed it, and its caller's request id. */
interface Placing {
  readonly requestId: string | undefined;
  readonly content: PromptContent;
  readonly options: PromptOptions;
  readonly credit: ResultCredit | undefined;
}

/**
 * Admits a prompt `AgentInputHook` placed (under `admit`, not split by the caller's interruption, or a prompt could be
 * queued and forgotten): what the last instance left of the session runs first, as it would have had this one started
 * with it (`prepared`); then the prompt is found where it is already, queued, refused, or starts a turn. Returns what
 * its caller awaits: the turn that places it ending.
 */
const admit = (agent: AgentContext, sessionId: string, { requestId, content, options, credit }: Placing, prepared: Prepared | undefined) =>
  agent.admit.withPermits(1)(
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (prepared !== undefined) yield* reopen(agent, sessionId, prepared);
        const state = agent.queues.of(sessionId);
        if (requestId !== undefined) {
          if (state.withdrawn.includes(requestId)) return yield* Effect.fail(retractedError(sessionId));
          // Dropped meanwhile if the session went idle: read again, under the lock, so the check is complete.
          yield* agent.requests.load(sessionId);
        }
        const whenBusy = options.whenBusy ?? "follow-up";
        const admitting = admission(sessionId, state, { requestId, whenBusy }, agent.requests.of(sessionId));
        switch (admitting.kind) {
          case "queued":
            // Held after a failed or cancelled turn: the retry starts it, as a new prompt would (not a plugin's,
            // which waits with it).
            if (admitting.start && options.source === undefined) {
              const lease = yield* holdFor(agent, sessionId);
              yield* start(agent, sessionId, agent.newId(), state.queue, lease, { taking: (taken) => agent.queues.setQueue(taken, []) });
            }
            // Told again, so a client retrying sees its prompt taken.
            yield* queueChanged(agent, sessionId);
            return admitting.item.done;
          case "placed":
            return admitting.done;
          case "logged":
            return admitting.ended;
          case "busy":
            return yield* new AgentError({ sessionId, reason: "Busy", message: admitting.message });
          case "queue": {
            const item = yield* makeItem(agent, content, options, whenBusy === "reject" ? "follow-up" : whenBusy, credit);
            // Accepted once it is in the journal, as a crash would lose it otherwise.
            yield* agent.queues.recorded(sessionId, (queued) =>
              Effect.andThen(
                agent.queues.setQueue(queued, [...queued.queue, item]),
                Effect.sync(() => {
                  // Behind a turn that only closes one that ended before, a person's new prompt lets go of a
                  // queue that ended held, as it would have had the turn closed then. A plugin's does not.
                  if (queued.turn?.closing !== undefined && options.source === undefined) queued.held = false;
                }),
              ),
            );
            yield* queueChanged(agent, sessionId);
            return item.done;
          }
          case "start": {
            // A plugin's prompt starts a turn only after one that ran to its end, with nothing held: one the
            // user stopped, or that failed, stays stopped, and the prompt waits, held, for theirs.
            if (options.source !== undefined && !(state.ranToEnd && state.queue.length === 0)) {
              const item = yield* makeItem(agent, content, options, "follow-up", credit);
              yield* agent.queues.recorded(sessionId, (queued) =>
                Effect.andThen(
                  agent.queues.setQueue(queued, [...queued.queue, item]),
                  Effect.sync(() => void (queued.held = true)),
                ),
              );
              yield* queueChanged(agent, sessionId);
              return item.done;
            }
            const lease = yield* holdFor(agent, sessionId);
            // Prompts held after a failed or cancelled turn go first, then this one.
            const item = yield* makeItem(agent, content, options, "follow-up", credit);
            const prompts = [...state.queue, item];
            yield* start(agent, sessionId, agent.newId(), prompts, lease, {
              taking: (taken) => (taken.queue.length > 0 ? agent.queues.setQueue(taken, []) : Effect.void),
            });
            if (prompts.length > 1) yield* queueChanged(agent, sessionId);
            return item.done;
          }
        }
      }),
    ),
  );

/** `Agent.prompt`. */
export const prompt = (agent: AgentContext, sessionId: string, content: PromptContent, options: PromptOptions = {}) =>
  Effect.gen(function* () {
    const { requestId } = options;
    // Outside the lock: the first exactly-once check of a session reads its log.
    if (requestId !== undefined) yield* agent.requests.load(sessionId);
    // A new prompt goes through `AgentInputHook` first, outside the lock (a handler may take its time). One placed
    // already, an exactly-once retry, answers as it did; two retries racing may both ask, and the lock places one.
    // One withdrawn is known too, though not refused here: a withdrawal is final once its journal write is, which
    // the check under the lock sees.
    const decided = known(agent, sessionId, requestId)
      ? { kind: "place" as const, content, options }
      : yield* agent.decisions.decide(sessionId, content, options);
    if (decided.kind !== "place") return decided;
    const placing: Placing = { requestId, content: decided.content, options: decided.options, credit: "credit" in decided ? decided.credit : undefined };
    // Placed (or found placed): known by where it is from now on, so its decision is let go.
    const waitOn = yield* Effect.scoped(Effect.flatMap(ready(agent, sessionId), (prepared) => admit(agent, sessionId, placing, prepared))).pipe(
      Effect.ensuring(Effect.sync(() => agent.decisions.forget(sessionId, requestId))),
    );
    // Awaiting, not joining: a caller that goes away leaves the turn running. A cancelled turn resolves normally.
    if (waitOn !== undefined) yield* Deferred.await(waitOn);
    return { kind: "placed" } satisfies PromptOutcome;
  });

/**
 * `Agent.cancel`. Marks the turn cancelling, in the journal, and stops it, as one step the caller's interruption cannot
 * split (a flag set and never acted on would close the turn as cancelled only when it next resumes); then waits for
 * it to close, which the caller may stop waiting for.
 */
export const cancel = (agent: AgentContext, sessionId: string) =>
  Effect.gen(function* () {
    const suspended = agent.queues.get(sessionId)?.suspended;
    if (suspended !== undefined) {
      // Not running: marked in the journal, it closes as cancelled when it resumes, asking the model nothing. Now,
      // if the session can be taken up.
      yield* agent.admit.withPermits(1)(
        Effect.uninterruptible(
          Effect.suspend(() => {
            suspended.cancelling = true;
            return agent.queues.persistOrWarn(sessionId);
          }),
        ),
      );
      yield* resume(agent, sessionId).pipe(Effect.catch(notTakenUp(sessionId)));
    }
    const entry = agent.queues.of(sessionId).turn;
    if (entry === undefined) return;
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // In the journal first: a host that stops while the turn closes resumes it as cancelled.
        entry.cancelling = true;
        yield* agent.queues.persistOrWarn(sessionId);
        yield* Deferred.succeed(entry.cancelled, undefined);
        // A turn whose body has not begun (waiting for a slot, or a resumed one for the composition) stops
        // waiting, reads the flag, and closes at once.
        if (!entry.started) return yield* restore(Effect.exit(Deferred.await(entry.ended)));
        entry.controller.abort();
        const fiber = yield* Deferred.await(entry.fiber);
        // Interrupted by the agent's own fiber, so the turn is stopped however soon the caller stops waiting.
        yield* Effect.forkIn(Fiber.interrupt(fiber), agent.turns);
        yield* restore(Fiber.await(fiber));
      }),
    );
  });

/** `Agent.withdraw`. */
export const withdraw = (agent: AgentContext, sessionId: string, requestId: string) =>
  Effect.andThen(
    checked(agent, sessionId),
    // Not split by the caller's interruption, as admission is not: a prompt taken out of the queue and never answered
    // would leave its caller waiting for good.
    agent.admit.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const state = agent.queues.get(sessionId);
          const item = state?.queue.find((candidate) => candidate.prompt.requestId === requestId);
          // Being placed in the running turn: too late to take out.
          if (state === undefined || item === undefined || item.placing) return false;
          // Withdrawn once the journal no longer has it, and remembers it, as a crash would bring it back otherwise.
          yield* agent.queues.recorded(sessionId, (from) =>
            Effect.andThen(
              agent.queues.setQueue(
                from,
                from.queue.filter((candidate) => candidate !== item),
              ),
              Effect.sync(() => void (from.withdrawn = [...from.withdrawn, requestId].slice(-WITHDRAWN_KEPT))),
            ),
          );
          yield* Deferred.fail(item.done, retractedError(sessionId));
          forget(agent, sessionId, state);
          yield* queueChanged(agent, sessionId);
          return true;
        }),
      ),
    ),
  );

/**
 * `Agent.promote`. Makes a queued follow-up a steer in its place, with its caller's `done`: the running turn places it
 * after its current step. With no turn running (the queue held, or the turn suspended), it waits as a follow-up would.
 * Made once the journal has it, as admission is, and not split by the caller's interruption.
 */
export const promote = (agent: AgentContext, sessionId: string, requestId: string) =>
  Effect.andThen(
    checked(agent, sessionId),
    agent.admit.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const state = agent.queues.get(sessionId);
          const item = state?.queue.find((candidate) => candidate.prompt.requestId === requestId);
          if (state?.turn === undefined || item === undefined || item.prompt.mode !== "follow-up") return false;
          const steer: Item = { prompt: { ...item.prompt, mode: "steer" }, done: item.done, placing: false };
          yield* agent.queues.recorded(sessionId, (from) =>
            agent.queues.setQueue(
              from,
              from.queue.map((candidate) => (candidate === item ? steer : candidate)),
            ),
          );
          yield* queueChanged(agent, sessionId);
          return true;
        }),
      ),
    ),
  );

/** `Agent.view`. */
export const view = (agent: AgentContext, sessionId: string): Effect.Effect<AgentView, AgentError> =>
  Effect.andThen(
    checked(agent, sessionId),
    Effect.sync(() => {
      // A session never prompted here gets no state: a view keeps nothing. A suspended turn is not running: no view.
      const state = agent.queues.get(sessionId) ?? { turn: undefined, queue: [], revision: agent.base };
      const queue = { queue: state.queue.map((item) => item.prompt), queueRevision: state.revision };
      return state.turn === undefined ? { output: [], ...queue } : { ...state.turn.live.view(), ...queue };
    }),
  );

/** `Agent.queue`. */
export const queue = (agent: AgentContext, sessionId: string) =>
  Effect.andThen(
    checked(agent, sessionId),
    Effect.sync(() => (agent.queues.get(sessionId)?.queue ?? []).map((item) => item.prompt)),
  );

/**
 * The model and thinking the session's last turn ran with, for a turn a notice starts: a notice chooses none, and
 * the agent's default may be another model, whose turn would also declare the prompt afresh.
 */
export const lastTurnOptions = (agent: AgentContext, sessionId: string): Effect.Effect<TurnOptions> =>
  agent.sessions.branch(sessionId).pipe(
    Effect.map((branch): TurnOptions => {
      for (let i = branch.length - 1; i >= 0; i--) {
        const data = branch[i]!.data;
        if (data.type !== "turn-start") continue;
        return { ...(data.model === undefined ? {} : { model: data.model }), ...(data.thinking === undefined ? {} : { thinking: data.thinking }) };
      }
      return {};
    }),
    Effect.catch(() => Effect.succeed({})),
  );
