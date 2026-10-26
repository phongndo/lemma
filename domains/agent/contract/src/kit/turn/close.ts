import { Cause, Clock, Effect, Exit } from "effect";
import { assert, Verify } from "@lemma/core";
import { TurnEnded } from "../../agent.ts";
import type { AgentError } from "../../agent.ts";
import { causeMessage, closedCore } from "../errors.ts";
import type { Ended } from "../turn.ts";
import type { Turn } from "./context.ts";
import { unansweredCalls } from "./log.ts";
import { stopped } from "./model.ts";
import { answerPending } from "./tools.ts";

/*
 * How a turn ends: closed in the log (`turn-end`), or left open there to resume, as the agent or the core stopping
 * left it.
 */

/**
 * Whether the turn stopped because the agent or the core is stopping, rather
 * than ending: then it is left as it is in the log, to resume when the agent
 * starts again. Interrupted otherwise, it was cancelled.
 */
const leftOpen = (turn: Turn, exit: Exit.Exit<Ended, AgentError>): Effect.Effect<boolean> => {
  if (Exit.isSuccess(exit)) return Effect.succeed(false);
  if (turn.input.suspended() || closedCore(exit.cause)) return Effect.succeed(true);
  return Cause.hasInterruptsOnly(exit.cause) ? Effect.succeed(false) : turn.services.hooks.closed;
};

/** The closing sequence `finish` logs for a turn that ended so. */
const close = (turn: Turn, ended: Ended) =>
  Effect.gen(function* () {
    const { services, input, log, settings, state } = turn;
    const { sessionId, turnId } = input;
    const cancelled = ended.reason === "cancelled";
    const step = state.step;
    // Only a call in flight has output so far, and its step a model.
    if (step?.model !== undefined && state.partial !== undefined) {
      const endedAt = yield* Clock.currentTimeMillis;
      const message = state.partial.message(step.model, cancelled ? "aborted" : "error", cancelled ? "Cancelled" : (ended.error ?? "Turn failed"), endedAt);
      const timing = { startedAt: state.partialStartedAt, endedAt };
      // What the user read of a reply they stopped is the model's to see next; anything else is kept for inspection.
      const kept = cancelled && settings.keepCancelled ? stopped(message) : undefined;
      yield* log.append(
        kept === undefined
          ? { type: "attempt", turnId, stepId: step.id, message, timing }
          : { type: "message", message: kept, turnId, stepId: step.id, timing },
      );
      state.partial = undefined;
    }
    const failed = `the turn failed (${ended.error ?? "unknown error"})`;
    yield* answerPending(turn, step?.id, (call) =>
      cancelled
        ? "Tool execution was cancelled."
        : state.started.has(call.id)
          ? `Tool execution was stopped: ${failed}. It may or may not have finished; check before running it again.`
          : `Tool was not executed: ${failed}.`,
    );
    if (step !== undefined) yield* log.append({ type: "step-end", turnId, stepId: step.id });
    yield* log.append({ type: "turn-end", turnId, reason: ended.reason, ...(ended.error === undefined ? {} : { error: ended.error }) });
    state.closed = true;
    if (log.branch !== undefined) input.kept?.keep({ events: log.branch, request: log.request! });
    // A closed turn has answered every call it made, or the next request would be malformed.
    if (yield* Verify) {
      const branch = yield* services.sessions.branch(sessionId, { leaf: log.lastId! });
      assert(unansweredCalls(branch) === undefined, `turn ${turnId} of session ${sessionId} closed with tool calls unanswered`);
    }
  });

/**
 * Closes the turn whatever happened, unless it is left open: the partial
 * output of an interrupted model call becomes an `attempt`, unanswered tool
 * calls get error results so the next request is still valid, then
 * `step-end` and `turn-end`. When that fails, the turn is left open in the
 * log, for the agent to close later (`TurnInput.unclosed`). `TurnEnded` is
 * published for a turn that closed.
 */
export const finish = (turn: Turn, exit: Exit.Exit<Ended, AgentError>) => {
  const { services, input, state } = turn;
  const { sessionId, turnId } = input;
  return Effect.gen(function* () {
    state.open = yield* leftOpen(turn, exit);
    if (state.open) return;
    const ended: Ended = Exit.isSuccess(exit)
      ? exit.value
      : Cause.hasInterruptsOnly(exit.cause)
        ? { reason: "cancelled" }
        : { reason: "error", error: causeMessage(exit.cause) };
    yield* close(turn, ended).pipe(
      Effect.catch((error) =>
        state.closed
          ? Effect.logWarning(`agent: could not check closed turn ${turnId} in session ${sessionId}: ${error.message}`)
          : Effect.andThen(
              Effect.sync(() => {
                state.unclosed = true;
                input.unclosed?.(ended);
              }),
              Effect.logWarning(`agent: could not close turn ${turnId} in session ${sessionId}: ${error.message}; it closes when the session is next taken up`),
            ),
      ),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        state.open || state.unclosed
          ? Effect.void
          : services.events.publish(TurnEnded, {
              sessionId,
              turnId,
              usage: state.usage,
              reason: Exit.isSuccess(exit) ? exit.value.reason : Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "error",
            }),
      ),
    ),
  );
};
