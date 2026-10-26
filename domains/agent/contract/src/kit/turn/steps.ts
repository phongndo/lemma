import { Effect } from "effect";
import type { HandlerStep } from "@lemma/core";
import { creditOf, inChainOrder } from "@lemma/contracts";
import type { ModelInfo } from "@lemma/llm";
import { AgentContinueHook } from "../../agent.ts";
import type { StepOutcome } from "../resume.ts";
import type { Ended } from "../turn.ts";
import { asked, boundary, hookError, userMessage, waitUntil } from "./context.ts";
import type { Turn } from "./context.ts";
import { callModel } from "./model.ts";
import { prepareRequest } from "./request.ts";
import { answerTruncated, runTools } from "./tools.ts";

/*
 * A turn's steps: each logs its request, asks the model, runs the tools it called, and decides whether the turn
 * takes another; steers queued meanwhile join between steps.
 */

/**
 * `AgentContinueHook`'s terminal, the agent's own decision: another step while the model asked for tools, or tools
 * answered it (results it has not read yet keep it going, whatever the provider called its stop); else it stops. It
 * says why, which the step's `step-end` logs.
 */
export const toolLoop = (outcome: StepOutcome): { readonly result: "continue" | "stop"; readonly why: string } =>
  outcome.message.stopReason === "toolUse"
    ? { result: "continue", why: "the model asked for tools" }
    : outcome.results.length > 0
      ? { result: "continue", why: "tool results to read" }
      : { result: "stop", why: `the model stopped (${outcome.message.stopReason})` };

/** Whether the turn takes another step, why by default, and the handlers that weighed in (`step-end`'s `decision`). */
export const decide = (turn: Turn, step: number, outcome: StepOutcome) =>
  Effect.gen(function* () {
    const { sessionId, turnId } = turn.input;
    const steps: HandlerStep<StepOutcome, "continue" | "stop">[] = [];
    // Why the default decides as it does, on what it saw (which a handler may have rewritten); on the step's own outcome
    // when a handler answered without it.
    let why = toolLoop(outcome).why;
    const result = yield* turn.services.hooks
      .invoke(
        AgentContinueHook,
        { sessionId, turnId, step, message: outcome.message, results: outcome.results },
        (final) =>
          Effect.sync(() => {
            const decided = toolLoop(final);
            why = decided.why;
            return decided.result;
          }),
        { onStep: (heard) => void steps.push(heard) },
      )
      .pipe(Effect.mapError(hookError(turn, "AgentContinueHook")));
    // A handler changed the decision by what it returned, or by what it passed on.
    const handlers = inChainOrder(steps).map((heard) =>
      creditOf(heard, [
        ...(heard.next !== undefined && heard.next.input !== heard.input ? ["input"] : []),
        ...(heard.output !== undefined && heard.next?.output !== undefined && heard.output !== heard.next.output
          ? [`${heard.next.output} → ${heard.output}`]
          : []),
      ]),
    );
    return { result, why, ...(handlers.length === 0 ? {} : { handlers }) };
  });

/**
 * Places queued steers after the turn's last event; returns how many. Each
 * one logged leaves the queue whatever happens next: a cancel waits for
 * that, so a steer is never both in the log and still queued.
 */
const placeSteers = (turn: Turn) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { inbox } = turn.input;
      const steers = yield* inbox.steers;
      const logged: string[] = [];
      yield* Effect.forEach(steers, (steer) => userMessage(turn, steer, () => void logged.push(steer.requestId)), {
        discard: true,
      }).pipe(Effect.ensuring(Effect.suspend(() => (logged.length === 0 ? Effect.void : inbox.placed(logged)))));
      return steers.length;
    }),
  );

/**
 * After a step's `step-end`: whether the turn ends. Steers queued meanwhile
 * join here and keep it going, unless it is out of steps (then they stay
 * queued and start the next turn).
 */
export const afterStep = (turn: Turn, step: number, decision: "continue" | "stop") =>
  Effect.gen(function* () {
    if (step >= turn.settings.maxSteps) return { reason: decision === "stop" ? "done" : "max-steps" } satisfies Ended;
    const steered = yield* placeSteers(turn);
    return steered === 0 && decision === "stop" ? ({ reason: "done" } satisfies Ended) : undefined;
  });

/**
 * One step: its request, the model's answer, and the tools it asked for. Says whether the turn goes on (`next`), asks
 * again from `retryAt` (a failed call, in a step that keeps the number), or how it ended.
 */
const oneStep = (turn: Turn, step: number, stepId: string, asking: ModelInfo) =>
  Effect.gen(function* () {
    const { services, input, log, state } = turn;
    const { turnId } = input;
    yield* log.append({ type: "step-start", turnId, stepId });
    state.step = { id: stepId, model: asking };
    const { request, model, offer } = yield* services.trace("agent.request", prepareRequest(turn, stepId, asking));
    state.step = { id: stepId, model };
    const outcome = yield* services.trace(
      "agent.model",
      Effect.andThen(Effect.annotateCurrentSpan("llm.model", model.ref), callModel(turn, stepId, request, model)),
    );
    if ("retry" in outcome) {
      yield* log.append({ type: "step-end", turnId, stepId });
      state.step = undefined;
      return { retryAt: outcome.retry.at };
    }
    if ("ended" in outcome) return outcome.ended;
    const results =
      outcome.message.stopReason === "length"
        ? yield* answerTruncated(turn, stepId)
        : yield* services.trace("agent.tools", runTools(turn, stepId, new Map(), offer));
    const decision = yield* decide(turn, step, { message: outcome.message, results });
    yield* log.append({ type: "step-end", turnId, stepId, decision });
    state.step = undefined;
    return (yield* afterStep(turn, step, decision.result)) ?? ("next" as const);
  });

/**
 * Steps numbered from `first` until the turn ends. A failed call asked
 * again closes its step and waits; the step that asks again keeps the
 * number, so retries take no steps from the turn.
 */
export const steps = (turn: Turn, first: number) =>
  Effect.gen(function* () {
    const asking = yield* asked(turn);
    for (let step = first; ;) {
      // A resumed turn can come here out of steps: a cut-off call counted as one.
      if (step > turn.settings.maxSteps) return { reason: "max-steps" } satisfies Ended;
      yield* boundary(turn);
      const stepId = turn.services.newId();
      // Every span of the step's work carries both, so a trace narrows to a step by either.
      const next = yield* turn.services
        .trace("agent.step", oneStep(turn, step, stepId, asking))
        .pipe(Effect.annotateSpans({ "step.id": stepId, "step.index": step }));
      if (typeof next === "object" && "retryAt" in next) {
        yield* waitUntil(turn, next.retryAt);
        continue;
      }
      if (next !== "next") return next;
      step++;
    }
  });
