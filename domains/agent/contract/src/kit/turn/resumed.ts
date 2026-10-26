import { Clock, Effect } from "effect";
import { requestState } from "@lemma/sessions";
import { partialMessage } from "../live.ts";
import type { ModelIdentity } from "../live.ts";
import { INTERRUPTED_CALL, RESUMED } from "../resume.ts";
import type { ResumePlan, ResumePoint } from "../resume.ts";
import type { Ended, TurnResume } from "../turn.ts";
import { userMessage, waitUntil } from "./context.ts";
import type { Turn } from "./context.ts";
import type { Offer } from "./request.ts";
import { afterStep, decide, steps } from "./steps.ts";
import { answerTruncated, runTools } from "./tools.ts";

/*
 * A turn a restart cut off, continued from where its log stops (`planResume`): a cut-off model call is logged as an
 * interrupted attempt and asked again in a new step (a failed one being retried is asked again once its wait is over);
 * cut-off tool calls run again when their tool is safe to repeat, and otherwise tell the model they were interrupted,
 * while calls that had not started run; a turn that was closing (cancelled, or failed) closes the same way.
 */

/**
 * What the turn had when it was cut off, set before anything is written, so a write that fails (a full disk) still
 * closes it as it should: where its appends continue, what it cost, its retries, the cut-off step, and the calls it
 * left without results.
 */
const restore = (turn: Turn, plan: ResumePlan) => {
  const { log, state } = turn;
  const { at } = plan;
  log.lastId = plan.lastId;
  state.usage = plan.usage;
  if (plan.retry !== undefined) {
    state.streak = { retries: plan.retry.attempts, overflowed: plan.retry.overflowed, shorten: plan.retry.overflow };
  }
  if (at.kind === "tools" || at.kind === "model" || at.kind === "before-request" || (at.kind === "failed" && !at.closed)) {
    state.step = { id: at.stepId, model: turn.input.model };
  }
  if (at.kind === "tools") {
    state.pending = [...at.pending];
    for (const id of at.started) state.started.add(id);
  }
};

/**
 * The rest of a step cut off among its tool calls, traced as the step it is: the calls run (or reported interrupted),
 * held to what the step's request offered, as logged, as a call made before the restart was: a tool a mode or another
 * handler took out is not there for it now either. A log from before the `nested` tools offered were logged has every
 * one listed now.
 */
const finishTools = (turn: Turn, plan: ResumePlan, at: Extract<ResumePoint, { kind: "tools" }>, output: (toolCallId: string) => string | undefined) =>
  Effect.gen(function* () {
    const { services, input, log, state } = turn;
    const listed = yield* services.tools.list;
    const repeatable = new Set(listed.filter((tool) => tool.replay === "safe").map((tool) => tool.spec.name));
    // A call that may have begun is run again only when that is safe; one that had not begun runs now.
    const interrupted = new Map(
      at.pending.filter((call) => at.started.has(call.id) && !repeatable.has(call.name)).map((call) => [call.id, output(call.id)] as const),
    );
    const logged = requestState(yield* log.branchNow);
    const declared = (logged.tools ?? []).map((spec) => spec.name);
    const nested = logged.nested ?? listed.filter((tool) => tool.nested === true).map((tool) => tool.spec.name);
    const resumedOffer: Offer = { declared, offered: [...declared, ...nested] };
    return yield* services
      .trace(
        "agent.step",
        Effect.andThen(
          Effect.annotateCurrentSpan("step.resumed", true),
          Effect.gen(function* () {
            const ran =
              at.message.stopReason === "length"
                ? yield* answerTruncated(turn, at.stepId)
                : yield* services.trace("agent.tools", runTools(turn, at.stepId, interrupted, resumedOffer));
            const decision = yield* decide(turn, plan.steps, { message: at.message, results: [...at.results, ...ran] });
            yield* log.append({ type: "step-end", turnId: input.turnId, stepId: at.stepId, decision });
            state.step = undefined;
            return yield* afterStep(turn, plan.steps, decision.result);
          }),
        ),
      )
      .pipe(Effect.annotateSpans({ "step.id": at.stepId, "step.index": plan.steps }));
  });

/** Continues a turn a restart cut off, from where it stopped (see the module's comment). */
export const resumed = (turn: Turn, resume: TurnResume) =>
  Effect.gen(function* () {
    const { input, log, state } = turn;
    const { turnId } = input;
    const { plan, restored, cancelling } = resume;
    const at = plan.at;
    restore(turn, plan);
    yield* log.append({ type: "custom", kind: RESUMED, data: { turnId } });
    // One that ended places nothing more: its callers were answered as it ended.
    if (resume.closing === undefined) for (const prompt of input.prompts) yield* userMessage(turn, prompt);
    const stepId = at.kind === "between" ? undefined : at.stepId;
    const output = (toolCallId: string) => restored?.output.find((entry) => entry.toolCallId === toolCallId)?.output;
    // What the cut-off call had produced, when the output file got that far.
    const cutStep = restored?.step !== undefined && restored.step.stepId === stepId ? restored.step : undefined;
    const now = yield* Clock.currentTimeMillis;
    /** The model the cut-off call asked: the turn's, or, for one closing as cancelled with none, the one its request named, by name alone. */
    const cutModel = (): ModelIdentity => {
      if (input.model !== undefined) return input.model;
      const ref = at.kind === "model" ? (at.model ?? "") : "";
      const slash = ref.indexOf("/");
      return { api: "", provider: ref.slice(0, Math.max(slash, 0)), id: ref.slice(slash + 1) };
    };
    const cutOff = () => partialMessage(cutStep?.content ?? [], cutModel(), cancelling ? "aborted" : "error", cancelling ? "Cancelled" : INTERRUPTED_CALL, now);
    const timing = () => ({ startedAt: cutStep?.startedAt ?? now, endedAt: now });
    /** The next step, once a retry's wait (cut short by the restart) is over. */
    const again = () => Effect.andThen(plan.retry === undefined ? Effect.void : waitUntil(turn, plan.retry.at), steps(turn, plan.steps + 1));

    if (at.kind === "failed") {
      const aborted = at.attempt.stopReason === "aborted";
      return { reason: aborted ? "cancelled" : "error", error: at.attempt.errorMessage ?? (aborted ? "Aborted" : "Model error") } satisfies Ended;
    }
    const closing = resume.closing ?? (cancelling ? ({ reason: "cancelled" } satisfies Ended) : undefined);
    if (closing !== undefined) {
      // The closing sequence logs the cut-off call and answers the pending tool calls (set above).
      if (at.kind === "model" && !at.logged) yield* log.append({ type: "attempt", turnId, stepId: at.stepId, message: cutOff(), timing: timing() });
      return closing;
    }
    switch (at.kind) {
      case "model":
        if (!at.logged) {
          yield* log.append({
            type: "attempt",
            turnId,
            stepId: at.stepId,
            message: cutOff(),
            timing: timing(),
            retry: { reason: "restart", attempt: 1, at: now },
          });
        }
        yield* log.append({ type: "step-end", turnId, stepId: at.stepId });
        state.step = undefined;
        return yield* again();
      case "before-request":
        yield* log.append({ type: "step-end", turnId, stepId: at.stepId });
        state.step = undefined;
        return yield* again();
      case "tools":
        return (yield* finishTools(turn, plan, at, output)) ?? (yield* steps(turn, plan.steps + 1));
      case "between": {
        // Prompts already placed after the last step are what the model answers next.
        if (at.outcome === undefined || at.steered) return yield* again();
        // The decision its step-end logged is what the turn acts on; one logged before decisions were is made now.
        const decision = at.decision ?? (yield* decide(turn, plan.steps, at.outcome)).result;
        return (yield* afterStep(turn, plan.steps, decision)) ?? (yield* steps(turn, plan.steps + 1));
      }
    }
  });
