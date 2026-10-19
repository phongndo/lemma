import { isDeepStrictEqual } from "node:util";
import { Cause, Deferred, Effect, Exit } from "effect";
import type { Context } from "effect";
import type { Hooks, HandlerStep } from "@lemma/core";
import { creditOf, inChainOrder } from "@lemma/contracts";
import type { ResultCredit } from "@lemma/contracts";
import { AgentError, AgentInputHook } from "../agent.ts";
import type { PromptContent, PromptDecision, PromptInput, PromptOptions, PromptOutcome } from "../agent.ts";

/** How many prompts `AgentInputHook` handled or refused the agent remembers, for a retry to be answered the same. */
const ANSWERS_KEPT = 1024;

/**
 * `AgentInputHook` over a new prompt: what to place, with the handlers that shaped it, or how a handler answered it
 * instead (`by` the one that did).
 */
const decideInput = (hooks: Context.Service.Shape<typeof Hooks>, sessionId: string, content: PromptContent, options: PromptOptions) =>
  Effect.gen(function* () {
    const steps: HandlerStep<PromptInput, PromptDecision>[] = [];
    const decision = yield* hooks
      .invoke(
        AgentInputHook,
        { sessionId, content, options },
        (input): Effect.Effect<PromptDecision> => Effect.succeed({ kind: "place", content: input.content, options: input.options }),
        {
          onStep: (step) => void steps.push(step),
        },
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentError" ? error : new AgentError({ sessionId, reason: "Hook", message: `AgentInputHook: ${error.message}`, cause: error }),
        ),
      );
    const ordered = inChainOrder(steps);
    if (decision.kind !== "place") {
      // The handler that answered it: the outermost whose answer is not the one the rest of the chain handed it.
      const by =
        ordered.find((step) => step.output !== undefined && (step.next?.output === undefined || !isDeepStrictEqual(step.output, step.next.output)))?.pluginId ??
        "unknown";
      return decision.kind === "handle"
        ? ({ kind: "handled", by, ...(decision.message === undefined ? {} : { message: decision.message }) } satisfies PromptOutcome)
        : ({ kind: "refused", by, reason: decision.reason } satisfies PromptOutcome);
    }
    // What a handler changed: the content or the options it handed on, or those it placed instead of the rest's.
    const rewrote = (step: HandlerStep<PromptInput, PromptDecision>) => {
      const handed = step.next?.input;
      const made = step.output?.kind === "place" ? step.output : undefined;
      const from = step.next?.output?.kind === "place" ? step.next.output : step.input;
      return (["content", "options"] as const).filter(
        (key) => (handed !== undefined && !isDeepStrictEqual(handed[key], step.input[key])) || (made !== undefined && !isDeepStrictEqual(made[key], from[key])),
      );
    };
    const handlers = ordered.map((step) => creditOf(step, rewrote(step)));
    // The request id stays the caller's, whatever a handler handed on: it is what makes the prompt exactly-once.
    const { requestId: _, ...placed } = decision.options;
    return {
      kind: "place" as const,
      content: decision.content,
      options: { ...placed, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) } satisfies PromptOptions,
      ...(handlers.length === 0 ? {} : { credit: { handlers } satisfies ResultCredit }),
    };
  });

/** What `AgentInputHook` made of a prompt: to place it, as shaped, or how a handler answered it. */
export type Decided = Effect.Success<ReturnType<typeof decideInput>>;

/**
 * What `AgentInputHook` made of prompts, by session and request id: one being decided, which a retry waits for
 * rather than asking again, or one it handled or refused, which a retry is answered with. One placed is let go once it
 * is (`forget`), as the agent knows it from then on; the oldest answers go past `ANSWERS_KEPT`. Kept while the agent
 * runs: a retry after a restart asks again.
 */
export const makeInputDecisions = (hooks: Context.Service.Shape<typeof Hooks>) => {
  const answers = new Map<string, Deferred.Deferred<Decided, AgentError>>();
  const answerKey = (sessionId: string, requestId: string) => `${sessionId}\u0000${requestId}`;
  const decide = (sessionId: string, content: PromptContent, options: PromptOptions): Effect.Effect<Decided, AgentError> =>
    Effect.suspend(() => {
      const { requestId } = options;
      if (requestId === undefined) return decideInput(hooks, sessionId, content, options);
      const key = answerKey(sessionId, requestId);
      const asked = answers.get(key);
      // The call that asked was cut off: this one asks.
      if (asked !== undefined)
        return Effect.flatMap(Effect.exit(Deferred.await(asked)), (exit) =>
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? decide(sessionId, content, options) : exit,
        );
      const answer = Deferred.makeUnsafe<Decided, AgentError>();
      answers.set(key, answer);
      for (const oldest of answers.keys()) {
        if (answers.size <= ANSWERS_KEPT) break;
        answers.delete(oldest);
      }
      return decideInput(hooks, sessionId, content, options).pipe(
        Effect.onExit((exit) =>
          Effect.andThen(
            Deferred.done(answer, exit),
            // A decision that failed, or was cut off, is asked again by a retry.
            Effect.sync(() => (Exit.isFailure(exit) && answers.get(key) === answer ? void answers.delete(key) : undefined)),
          ),
        ),
      );
    });
  /** The prompt is placed (or found placed): known by where it is from now on, so its decision is let go. */
  const forget = (sessionId: string, requestId: string | undefined): void => {
    if (requestId !== undefined) answers.delete(answerKey(sessionId, requestId));
  };
  return { decide, forget };
};
