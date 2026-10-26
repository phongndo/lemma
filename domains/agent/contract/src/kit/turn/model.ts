import { Clock, Effect, Stream } from "effect";
import { addUsage } from "@lemma/llm";
import type { AssistantMessage, LlmFailure, LlmRequest, ModelInfo, StreamEvent, ToolCall } from "@lemma/llm";
import type { ProviderAnswer } from "@lemma/sessions";
import { AssistantDelta } from "../../agent.ts";
import type { PartialMessage } from "../live.ts";
import { nextRetry, noRetries, retried } from "../retry.ts";
import type { Ended } from "../turn.ts";
import { unlessClosing } from "./context.ts";
import type { Turn } from "./context.ts";

/*
 * A step's model call: its stream, published as it comes, and what comes of it, logged as the assistant `message` or
 * an `attempt` (and whether the call is asked again).
 */

/**
 * What a reply the user stopped keeps for the model: its text, and thinking a provider can replay (signed); never a
 * tool call, which nothing will answer. Undefined when that leaves no text.
 */
export const stopped = (message: AssistantMessage): AssistantMessage | undefined => {
  const content = message.content.filter((block) => block.type === "text" || (block.type === "thinking" && block.thinkingSignature !== undefined));
  return content.some((block) => block.type === "text" && block.text.trim() !== "") ? { ...message, content } : undefined;
};

const isFirstToken = (event: StreamEvent) =>
  event.type === "text-delta" || event.type === "thinking-delta" || event.type === "toolcall-start" || event.type === "toolcall-delta";

/** A model call as its stream ended: how it settled (if it did), the stream's own failure, when, and how the provider answered. */
interface Streamed {
  readonly partial: PartialMessage;
  readonly settled: Extract<StreamEvent, { type: "done" | "error" }> | undefined;
  readonly streamError: string | undefined;
  readonly timing: { readonly startedAt: number; readonly firstTokenAt?: number; readonly endedAt: number };
  readonly answer: { readonly response?: ProviderAnswer };
}

/** Streams the call, publishing each event as `AssistantDelta` and keeping what it produced in the live view. */
const stream = (turn: Turn, stepId: string, request: LlmRequest) =>
  Effect.gen(function* () {
    const { services, input, state } = turn;
    const { sessionId, turnId, live } = input;
    const startedAt = yield* Clock.currentTimeMillis;
    let firstTokenAt: number | undefined;
    let settled: Extract<StreamEvent, { type: "done" | "error" }> | undefined;
    /** How the provider answered, before its body: logged with what comes of the call. */
    let response: ProviderAnswer | undefined;
    const partial = live.startStep(stepId, startedAt);
    state.partial = partial;
    state.partialStartedAt = startedAt;
    const streamError = yield* services.llm.stream(request).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          // Not model output: kept for the log, not streamed to clients.
          if (event.type === "provider") {
            response = { status: event.status, ...(event.requestId === undefined ? {} : { requestId: event.requestId }) };
            return;
          }
          if (firstTokenAt === undefined && isFirstToken(event)) firstTokenAt = yield* Clock.currentTimeMillis;
          const seq = live.apply(event);
          if (event.type === "done" || event.type === "error") settled = event;
          yield* services.events.publish(AssistantDelta, { sessionId, turnId, stepId, seq, event });
        }),
      ),
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(error.message)),
    );
    // Observers hear the end of the reply before the turn goes on to log it: a provider's last delta and its `done`
    // often come together, and the observers of both would otherwise wait for the answer's logging, then its tools.
    yield* Effect.yieldNow;
    const timing = { startedAt, ...(firstTokenAt === undefined ? {} : { firstTokenAt }), endedAt: yield* Clock.currentTimeMillis };
    const streamed: Streamed = { partial, settled, streamError, timing, answer: response === undefined ? {} : { response } };
    return streamed;
  });

/** Whether a failed call is asked again, and when (`nextRetry`): a cancelled turn asks nothing again. */
const retryOf = (turn: Turn, failure: LlmFailure | undefined) =>
  failure === undefined || turn.input.signal.aborted ? Effect.succeed(undefined) : nextRetry(failure, turn.state.streak, turn.settings);

/**
 * Logs what came of the call, in one step a cancel cannot split: the assistant `message`, or an `attempt` (a reply the
 * user stopped, kept as far as it got, is a `message`). Returns the settled message; or, when the call failed, when it
 * is to be asked again (`retry`) or how the turn ends.
 */
const settle = (turn: Turn, stepId: string, model: ModelInfo, { partial, settled, streamError, timing, answer }: Streamed) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { input, log, settings, state } = turn;
      const { turnId, live } = input;
      state.partial = undefined;
      live.endStep();
      if (settled === undefined) {
        const error = streamError ?? "The model stream ended without a result";
        yield* log.append({ type: "attempt", turnId, stepId, message: partial.message(model, "error", error, timing.endedAt), timing, ...answer });
        return { ended: { reason: "error", error } satisfies Ended };
      }
      state.usage = addUsage(state.usage, settled.message.usage);
      if (settled.type === "error") {
        const aborted = settled.message.stopReason === "aborted";
        const kept = aborted && settings.keepCancelled ? stopped(settled.message) : undefined;
        if (kept !== undefined) {
          yield* log.append({ type: "message", message: kept, turnId, stepId, timing, ...answer });
          return { ended: { reason: "cancelled", error: kept.errorMessage ?? "Aborted" } satisfies Ended };
        }
        const failure = aborted ? undefined : settled.failure;
        const retry = yield* retryOf(turn, failure);
        yield* log.append({
          type: "attempt",
          turnId,
          stepId,
          message: settled.message,
          timing,
          ...(failure === undefined ? {} : { failure }),
          ...(retry === undefined ? {} : { retry }),
          ...answer,
        });
        if (retry !== undefined && failure !== undefined) {
          state.streak = retried(state.streak, failure, retry.attempt);
          return { retry };
        }
        return {
          ended: { reason: aborted ? "cancelled" : "error", error: settled.message.errorMessage ?? (aborted ? "Aborted" : "Model error") } satisfies Ended,
        };
      }
      state.streak = noRetries;
      yield* log.append({ type: "message", message: settled.message, turnId, stepId, timing, ...answer });
      state.pending = settled.message.content.filter((block): block is ToolCall => block.type === "toolCall");
      return { message: settled.message };
    }),
  );

/**
 * Streams one model call. Returns the settled message; or, when the call failed, when it is to be asked again
 * (`retry`) or how the turn ends.
 */
export const callModel = (turn: Turn, stepId: string, request: LlmRequest, model: ModelInfo) =>
  Effect.gen(function* () {
    const streamed = yield* stream(turn, stepId, request);
    const { settled } = streamed;
    // A call that failed as the core shut down failed because of it, maybe: asked again when the turn resumes, not logged.
    if (settled === undefined || (settled.type === "error" && settled.message.stopReason !== "aborted")) yield* unlessClosing(turn);
    return yield* settle(turn, stepId, model, streamed);
  });
