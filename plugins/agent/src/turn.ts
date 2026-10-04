import { randomBytes } from "node:crypto";
import { Cause, Effect, Exit, Stream } from "effect";
import type { Context } from "effect";
import type { Events, Hooks } from "@lemma/core";
import {
  addUsage,
  AgentContinueHook,
  AgentError,
  AgentRequestHook,
  AssistantDelta,
  deriveMessages,
  emptyUsage,
  rebuildRequest,
  requestState,
  ToolInvocation,
  TurnEnded,
  TurnStarted,
} from "@lemma/contracts";
import type {
  Contribution,
  EventData,
  HostControl,
  Llm,
  LlmRequest,
  ModelInfo,
  PromptContent,
  RequestDraft,
  RequestPlan,
  SessionError,
  SessionEvent,
  Sessions,
  StreamEvent,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
  Tools,
  ToolSpec,
  Usage,
} from "@lemma/contracts";
import { partialMessage } from "./live.ts";
import type { LiveTurn, PartialMessage } from "./live.ts";
import { baseSection, environmentSection, titleFrom } from "./prompt.ts";
import { INTERRUPTED_CALL } from "./resume.ts";
import type { ResumePlan, StepOutcome } from "./resume.ts";
import type { LiveFile } from "./state.ts";

export interface TurnServices {
  readonly sessions: Context.Tag.Service<typeof Sessions>;
  readonly llm: Context.Tag.Service<typeof Llm>;
  readonly tools: Context.Tag.Service<typeof Tools>;
  readonly host: Context.Tag.Service<typeof HostControl>;
  readonly hooks: Context.Tag.Service<typeof Hooks>;
  readonly events: Context.Tag.Service<typeof Events>;
  /** The agent plugin's id, recorded as the source of the sections it contributes. */
  readonly source: string;
}

export interface TurnSettings {
  readonly systemPrompt?: string;
  /** Shell command for the `lemma` CLI, named in the environment section. */
  readonly cli?: string;
  readonly maxSteps: number;
}

/** A prompt as a turn places it: a user message carrying the submission's id. */
export interface Placed {
  readonly requestId: string;
  readonly content: PromptContent;
}

/** The session's queue as the turn sees it: steers join the turn between steps. */
export interface TurnInbox {
  /** Queued steers, oldest first. They stay queued until `placed`, so one is never lost between the queue and the log. */
  readonly steers: Effect.Effect<readonly Placed[]>;
  /** These steers' messages are in the log: take them out of the queue. */
  readonly placed: (requestIds: readonly string[]) => Effect.Effect<void>;
}

/** A turn that a host restart cut off: where it stopped, and what its cut-off calls had produced then. */
export interface TurnResume {
  readonly plan: ResumePlan;
  readonly restored?: LiveFile;
  /** `cancel` had been asked for: the turn closes as cancelled. */
  readonly cancelling: boolean;
}

export interface TurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** Session title before the turn; a missing title is set from the first prompt. */
  readonly title?: string;
  readonly model: ModelInfo;
  readonly thinking?: ThinkingLevel;
  /** Placed first, in order: a new turn's prompts, or those a resumed turn had not placed yet. */
  readonly prompts: readonly Placed[];
  /** Present when the turn continues one a restart cut off. */
  readonly resume?: TurnResume;
  /** Aborted by `cancel`; handed to every tool execution. */
  readonly signal: AbortSignal;
  readonly inbox: TurnInbox;
  readonly live: LiveTurn;
  /** A prompt's message is in the log. */
  readonly logged: (requestId: string) => void;
  /**
   * True once the agent is closing (the host stopping, or the agent
   * reloading): a turn interrupted then is left open in the log, to resume
   * when the agent starts again, rather than closed as cancelled.
   */
  readonly suspended: () => boolean;
}

export type TurnReason = "done" | "cancelled" | "error" | "max-steps";
interface Ended {
  readonly reason: TurnReason;
  readonly error?: string;
}

/** The text a cut-off tool call that is not run again returns to the model. */
const interruptedText = (output: string | undefined) =>
  output === undefined || output === ""
    ? "Tool execution was interrupted: the host stopped while it ran. It may or may not have finished; check before running it again."
    : `Tool execution was interrupted: the host stopped while it ran. It may or may not have finished; check before running it again. Its output until then:\n${output}`;

export const newId = (): string => randomBytes(6).toString("base64url");

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => Object.hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

const isFirstToken = (event: StreamEvent) =>
  event.type === "text-delta" || event.type === "thinking-delta" || event.type === "toolcall-start" || event.type === "toolcall-delta";

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};

/**
 * One turn. The log is written as the turn goes: `turn-start`, the user
 * messages, then per step `step-start`, `request`, the assistant `message` (or
 * an `attempt`), tool results, and `step-end`, with steers placed between
 * steps; `turn-end` closes it, unless the agent suspends it to resume later.
 * Every append names the previous one as its parent, so a checkout elsewhere
 * during the turn cannot splice the turn into another branch.
 */
export function runTurn(services: TurnServices, settings: TurnSettings, input: TurnInput): Effect.Effect<TurnReason, AgentError> {
  const { sessions, llm, tools, host, hooks, events, source } = services;
  const { sessionId, turnId, cwd, signal, live } = input;

  const state: {
    lastId: string | undefined;
    usage: Usage;
    /** Open step, closed by `step-end`. */
    step: { readonly id: string; readonly model: ModelInfo } | undefined;
    /** Output of a model call in flight. */
    partial: PartialMessage | undefined;
    partialStartedAt: number;
    /** Tool calls of the logged assistant message that have no result yet. */
    pending: ToolCall[];
  } = { lastId: undefined, usage: emptyUsage, step: undefined, partial: undefined, partialStartedAt: 0, pending: [] };

  const sessionError = (error: SessionError) => new AgentError({ sessionId, reason: "Session", message: error.message, cause: error });

  /** Uninterruptible so a cancelled turn never loses track of an event that did reach the log. */
  const append = (data: EventData): Effect.Effect<SessionEvent, AgentError> =>
    Effect.uninterruptible(
      sessions.append(sessionId, data, state.lastId === undefined ? undefined : { parent: state.lastId }).pipe(
        Effect.tap((event) =>
          Effect.sync(() => {
            state.lastId = event.id;
          }),
        ),
        Effect.mapError(sessionError),
      ),
    );

  const hookError = (hook: string) => (error: { readonly message: string }) =>
    new AgentError({ sessionId, reason: "Hook", message: `${hook}: ${error.message}`, cause: error });

  const userMessage = (placed: Placed) =>
    append({ type: "message", message: { role: "user", content: placed.content, timestamp: Date.now() }, turnId, requestId: placed.requestId }).pipe(
      Effect.tap(() => Effect.sync(() => input.logged(placed.requestId))),
    );

  const toolResult = (call: ToolCall, text: string): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: true,
    timestamp: Date.now(),
  });

  /** Builds, logs, and returns the exact request for this step. */
  const prepareRequest = (stepId: string) =>
    Effect.gen(function* () {
      const branch = yield* sessions.branch(sessionId, { leaf: state.lastId! }).pipe(Effect.mapError(sessionError));
      const listed = yield* tools.list;
      const draft: RequestDraft = {
        sessionId,
        turnId,
        cwd,
        model: input.model.ref,
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
        sections: [
          baseSection(source, new Set(listed.map((tool) => tool.spec.name)), settings.systemPrompt),
          environmentSection(source, { cwd, sessionId, ...(settings.cli === undefined ? {} : { cli: settings.cli }) }),
        ],
        tools: listed,
        branch,
        history: deriveMessages(branch),
        // Through the turn's own append, so the event chains after the turn's last one and the turn continues from it.
        append: (data) =>
          Effect.uninterruptible(
            append(data).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (data.type === "compaction" && data.usage !== undefined) state.usage = addUsage(state.usage, data.usage);
                }),
              ),
            ),
          ),
      };
      const plan = yield* hooks
        .invoke(AgentRequestHook, draft, (final): Effect.Effect<RequestPlan> =>
          Effect.succeed({
            model: final.model,
            ...(final.thinking === undefined ? {} : { thinking: final.thinking }),
            sections: final.sections,
            tools: final.tools,
          }),
        )
        .pipe(Effect.mapError(hookError("AgentRequestHook")));
      const model =
        plan.model === input.model.ref
          ? input.model
          : yield* llm
              .model(plan.model)
              .pipe(Effect.mapError((error) => new AgentError({ sessionId, reason: "NoModel", message: error.message, cause: error })));
      const system = plan.sections
        .map((section) => section.text)
        .filter((text) => text.length > 0)
        .join("\n\n");
      const specs: ToolSpec[] = plan.tools.map((tool) => tool.spec);
      const contributions: Contribution[] = [
        ...plan.sections.map((section): Contribution => ({ source: section.source, kind: "system", label: section.id, chars: section.text.length })),
        ...plan.tools.map((tool): Contribution => ({ source: tool.source, kind: "tool", label: tool.spec.name, chars: JSON.stringify(tool.spec).length })),
      ];
      const previous = requestState(branch);
      const composition = yield* host.composition;
      const logged = yield* append({
        type: "request",
        turnId,
        stepId,
        model: plan.model,
        ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
        composition: composition.id,
        ...(previous.system === system ? {} : { system }),
        ...(deepEqual(previous.tools ?? [], specs) ? {} : { tools: specs }),
        contributions,
      });
      // Send what the log says was sent: the request is rebuilt from the branch that now ends at the request event.
      const request = rebuildRequest(yield* sessions.branch(sessionId, { leaf: logged.id }).pipe(Effect.mapError(sessionError)), logged.id, sessionId);
      if (request === undefined) return yield* Effect.dieMessage(`request ${logged.id} is not on its own branch`);
      return { request, model };
    });

  /** Streams one model call. Returns the settled message, or how the turn ends when the call failed. */
  const callModel = (stepId: string, request: LlmRequest, model: ModelInfo) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      let firstTokenAt: number | undefined;
      let settled: Extract<StreamEvent, { type: "done" | "error" }> | undefined;
      const partial = live.startStep(stepId, startedAt);
      state.partial = partial;
      state.partialStartedAt = startedAt;
      const failure = yield* llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (firstTokenAt === undefined && isFirstToken(event)) firstTokenAt = Date.now();
            const seq = live.apply(event);
            if (event.type === "done" || event.type === "error") settled = event;
            yield* events.publish(AssistantDelta, { sessionId, turnId, stepId, seq, event });
          }),
        ),
        Effect.as(undefined),
        Effect.catchAll((error) => Effect.succeed(error.message)),
      );
      const timing = { startedAt, ...(firstTokenAt === undefined ? {} : { firstTokenAt }), endedAt: Date.now() };
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          state.partial = undefined;
          live.endStep();
          if (settled === undefined) {
            const error = failure ?? "The model stream ended without a result";
            yield* append({ type: "attempt", turnId, stepId, message: partial.message(model, "error", error), timing });
            return { ended: { reason: "error", error } satisfies Ended };
          }
          state.usage = addUsage(state.usage, settled.message.usage);
          if (settled.type === "error") {
            yield* append({ type: "attempt", turnId, stepId, message: settled.message, timing });
            const aborted = settled.message.stopReason === "aborted";
            return {
              ended: { reason: aborted ? "cancelled" : "error", error: settled.message.errorMessage ?? (aborted ? "Aborted" : "Model error") } satisfies Ended,
            };
          }
          yield* append({ type: "message", message: settled.message, turnId, stepId, timing });
          state.pending = settled.message.content.filter((block): block is ToolCall => block.type === "toolCall");
          return { message: settled.message };
        }),
      );
    });

  /**
   * Runs the pending tool calls in order, logging each result as it arrives.
   * A call in `interrupted` (cut off by a restart, and not safe to repeat) is
   * not run: the model is told so, with the output it had printed.
   */
  const runTools = (stepId: string, interrupted: ReadonlyMap<string, string | undefined> = new Map()) =>
    Effect.gen(function* () {
      const results: ToolResultMessage[] = [];
      while (state.pending.length > 0) {
        // `cancel` aborts before it interrupts; start nothing new in between.
        if (signal.aborted) return yield* Effect.interrupt;
        const call = state.pending[0]!;
        const startedAt = Date.now();
        const invocation = new ToolInvocation({ sessionId, toolCallId: call.id, name: call.name, input: call.arguments, cwd });
        const result = interrupted.has(call.id)
          ? { content: [{ type: "text" as const, text: interruptedText(interrupted.get(call.id)) }], isError: true, details: undefined }
          : yield* tools.execute(invocation, signal).pipe(
              Effect.map((value) => ({ content: value.content, isError: value.isError ?? false, details: value.details })),
              Effect.catchAll((error) => Effect.succeed({ content: [{ type: "text" as const, text: error.message }], isError: true, details: undefined })),
              Effect.catchAllDefect((defect) =>
                Effect.succeed({
                  content: [{ type: "text" as const, text: `Tool ${call.name} crashed: ${String(defect)}` }],
                  isError: true,
                  details: undefined,
                }),
              ),
            );
        const message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: result.isError,
          timestamp: Date.now(),
        };
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* append({
              type: "message",
              message,
              turnId,
              stepId,
              timing: { startedAt, endedAt: Date.now() },
              ...(result.details === undefined ? {} : { details: result.details }),
            });
            state.pending.shift();
            live.toolEnded(call.id);
          }),
        );
        results.push(message);
      }
      return results;
    });

  /**
   * Places queued steers after the turn's last event; returns how many. Each
   * one logged leaves the queue whatever happens next: a cancel waits for
   * that, so a steer is never both in the log and still queued.
   */
  const placeSteers = Effect.uninterruptible(
    Effect.gen(function* () {
      const steers = yield* input.inbox.steers;
      const logged: string[] = [];
      yield* Effect.forEach(steers, (steer) => Effect.tap(userMessage(steer), () => Effect.sync(() => logged.push(steer.requestId))), {
        discard: true,
      }).pipe(Effect.ensuring(Effect.suspend(() => (logged.length === 0 ? Effect.void : input.inbox.placed(logged)))));
      return steers.length;
    }),
  );

  const decide = (step: number, outcome: StepOutcome) =>
    hooks
      .invoke(AgentContinueHook, { sessionId, turnId, step, message: outcome.message, results: outcome.results }, (final) =>
        Effect.succeed(final.message.stopReason === "toolUse" ? ("continue" as const) : ("stop" as const)),
      )
      .pipe(Effect.mapError(hookError("AgentContinueHook")));

  /**
   * After a step's `step-end`: whether the turn ends. Steers queued meanwhile
   * join here and keep it going, unless it is out of steps (then they stay
   * queued and start the next turn).
   */
  const afterStep = (step: number, decision: "continue" | "stop") =>
    Effect.gen(function* () {
      if (step >= settings.maxSteps) return { reason: decision === "stop" ? "done" : "max-steps" } satisfies Ended;
      const steered = yield* placeSteers;
      return steered === 0 && decision === "stop" ? ({ reason: "done" } satisfies Ended) : undefined;
    });

  /** Steps numbered from `first` until the turn ends. */
  const steps = (first: number) =>
    Effect.gen(function* () {
      for (let step = first; ; step++) {
        // A resumed turn can come here out of steps: a cut-off call counted as one.
        if (step > settings.maxSteps) return { reason: "max-steps" } satisfies Ended;
        const stepId = newId();
        yield* append({ type: "step-start", turnId, stepId });
        state.step = { id: stepId, model: input.model };
        const { request, model } = yield* prepareRequest(stepId);
        state.step = { id: stepId, model };
        const outcome = yield* callModel(stepId, request, model);
        if ("ended" in outcome) return outcome.ended;
        const results = yield* runTools(stepId);
        const decision = yield* decide(step, { message: outcome.message, results });
        yield* append({ type: "step-end", turnId, stepId });
        state.step = undefined;
        const ended = yield* afterStep(step, decision);
        if (ended !== undefined) return ended;
      }
    });

  /**
   * Continues a turn a restart cut off, from where it stopped: a cut-off model
   * call is logged as an interrupted attempt and asked again in a new step;
   * cut-off tool calls run again when their tool is safe to repeat, and
   * otherwise tell the model they were interrupted; a turn that was closing
   * (cancelled, or failed) closes the same way.
   */
  const resumed = (resume: TurnResume) =>
    Effect.gen(function* () {
      const { plan, restored, cancelling } = resume;
      const at = plan.at;
      state.lastId = plan.lastId;
      state.usage = plan.usage;
      yield* append({ type: "custom", kind: "agent.resumed", data: { turnId } });
      for (const prompt of input.prompts) yield* userMessage(prompt);
      const stepId = at.kind === "between" ? undefined : at.stepId;
      const output = (toolCallId: string) => restored?.output.find((entry) => entry.toolCallId === toolCallId)?.output;
      // What the cut-off call had produced, when the output file got that far.
      const cutStep = restored?.step !== undefined && restored.step.stepId === stepId ? restored.step : undefined;
      const cutOff = () => partialMessage(cutStep?.content ?? [], input.model, cancelling ? "aborted" : "error", cancelling ? "Cancelled" : INTERRUPTED_CALL);
      const timing = () => ({ startedAt: cutStep?.startedAt ?? Date.now(), endedAt: Date.now() });

      if (at.kind === "failed") {
        if (!at.closed) state.step = { id: at.stepId, model: input.model };
        const aborted = at.attempt.stopReason === "aborted";
        return { reason: aborted ? "cancelled" : "error", error: at.attempt.errorMessage ?? (aborted ? "Aborted" : "Model error") } satisfies Ended;
      }
      if (cancelling) {
        // The closing sequence logs the cut-off call and answers the pending tool calls.
        if (at.kind !== "between") state.step = { id: at.stepId, model: input.model };
        if (at.kind === "model" && !at.logged) yield* append({ type: "attempt", turnId, stepId: at.stepId, message: cutOff(), timing: timing() });
        if (at.kind === "tools") state.pending = [...at.pending];
        return { reason: "cancelled" } satisfies Ended;
      }
      switch (at.kind) {
        case "model":
          if (!at.logged) yield* append({ type: "attempt", turnId, stepId: at.stepId, message: cutOff(), timing: timing() });
          yield* append({ type: "step-end", turnId, stepId: at.stepId });
          return yield* steps(plan.steps + 1);
        case "before-request":
          yield* append({ type: "step-end", turnId, stepId: at.stepId });
          return yield* steps(plan.steps + 1);
        case "tools": {
          state.step = { id: at.stepId, model: input.model };
          state.pending = [...at.pending];
          const listed = yield* tools.list;
          const repeatable = new Set(listed.filter((tool) => tool.replay === "safe").map((tool) => tool.spec.name));
          const interrupted = new Map(at.pending.filter((call) => !repeatable.has(call.name)).map((call) => [call.id, output(call.id)] as const));
          const results = [...at.results, ...(yield* runTools(at.stepId, interrupted))];
          const decision = yield* decide(plan.steps, { message: at.message, results });
          yield* append({ type: "step-end", turnId, stepId: at.stepId });
          state.step = undefined;
          return (yield* afterStep(plan.steps, decision)) ?? (yield* steps(plan.steps + 1));
        }
        case "between": {
          // Prompts already placed after the last step are what the model answers next.
          if (at.outcome === undefined || at.steered) return yield* steps(plan.steps + 1);
          const decision = yield* decide(plan.steps, at.outcome);
          return (yield* afterStep(plan.steps, decision)) ?? (yield* steps(plan.steps + 1));
        }
      }
    });

  /**
   * Closes the turn whatever happened: the partial output of an interrupted
   * model call becomes an `attempt`, unanswered tool calls get error results so
   * the next request is still valid, then `step-end` and `turn-end`.
   */
  const finish = (exit: Exit.Exit<Ended, AgentError>) =>
    Effect.gen(function* () {
      // Suspended: left as it is, to resume when the agent starts again.
      if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause) && input.suspended()) return;
      const ended: Ended = Exit.isSuccess(exit)
        ? exit.value
        : Cause.isInterruptedOnly(exit.cause)
          ? { reason: "cancelled" }
          : { reason: "error", error: causeMessage(exit.cause) };
      const cancelled = ended.reason === "cancelled";
      const step = state.step;
      if (step !== undefined && state.partial !== undefined) {
        const message = state.partial.message(step.model, cancelled ? "aborted" : "error", cancelled ? "Cancelled" : (ended.error ?? "Turn failed"));
        yield* append({ type: "attempt", turnId, stepId: step.id, message, timing: { startedAt: state.partialStartedAt, endedAt: Date.now() } });
        state.partial = undefined;
      }
      while (state.pending.length > 0) {
        const call = state.pending[0]!;
        const text = cancelled ? "Tool execution was cancelled." : `Tool was not executed: the turn failed (${ended.error ?? "unknown error"}).`;
        yield* append({ type: "message", message: toolResult(call, text), turnId, ...(step === undefined ? {} : { stepId: step.id }) });
        state.pending.shift();
        live.toolEnded(call.id);
      }
      if (step !== undefined) yield* append({ type: "step-end", turnId, stepId: step.id });
      yield* append({ type: "turn-end", turnId, reason: ended.reason, ...(ended.error === undefined ? {} : { error: ended.error }) });
    }).pipe(
      Effect.catchAll((error) => Effect.logWarning(`agent: could not close turn ${turnId} in session ${sessionId}: ${error.message}`)),
      Effect.ensuring(
        Effect.suspend(() =>
          Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause) && input.suspended()
            ? Effect.void
            : events.publish(TurnEnded, {
                sessionId,
                turnId,
                usage: state.usage,
                reason: Exit.isSuccess(exit) ? exit.value.reason : Cause.isInterruptedOnly(exit.cause) ? "cancelled" : "error",
              }),
        ),
      ),
    );

  return Effect.gen(function* () {
    const resume = input.resume;
    if (resume === undefined) {
      yield* append({
        type: "turn-start",
        turnId,
        model: input.model.ref,
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      });
    }
    yield* events.publish(TurnStarted, { sessionId, turnId });
    const body =
      resume !== undefined
        ? resumed(resume)
        : Effect.gen(function* () {
            for (const prompt of input.prompts) yield* userMessage(prompt);
            const first = input.prompts[0];
            const title = input.title === undefined && first !== undefined ? titleFrom(first.content) : undefined;
            if (title !== undefined) yield* append({ type: "title", title });
            return yield* steps(1);
          });
    return yield* body.pipe(
      Effect.onExit(finish),
      Effect.map((ended) => ended.reason),
    );
  });
}
