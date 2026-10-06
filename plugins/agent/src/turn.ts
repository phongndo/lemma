import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Cause, Effect, Exit, Stream } from "effect";
import type { Context } from "effect";
import { CoreClosed, Hook } from "@lemma/core";
import type { Events, Hooks } from "@lemma/core";
import {
  addUsage,
  AgentContinueHook,
  AgentError,
  AgentRequestHook,
  AssistantDelta,
  deriveMessages,
  emptyUsage,
  modelView,
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
  LlmFailure,
  LlmRequest,
  ModelInfo,
  PromptContent,
  RequestDraft,
  RequestPlan,
  SessionEvent,
  Sessions,
  StreamEvent,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
  Tools,
  ToolSpec,
  TurnEndReason,
  Usage,
} from "@lemma/contracts";
import { partialMessage } from "./live.ts";
import type { LiveTurn, PartialMessage } from "./live.ts";
import { baseSection, environmentSection, titleFrom } from "./prompt.ts";
import { INTERRUPTED_CALL, RESUMED, TOOLS_STARTED } from "./resume.ts";
import type { ResumePlan, StepOutcome } from "./resume.ts";
import type { LiveFile } from "./state.ts";

interface TurnServices {
  readonly sessions: Context.Tag.Service<typeof Sessions>;
  readonly llm: Context.Tag.Service<typeof Llm>;
  readonly tools: Context.Tag.Service<typeof Tools>;
  readonly host: Context.Tag.Service<typeof HostControl>;
  readonly hooks: Context.Tag.Service<typeof Hooks>;
  readonly events: Context.Tag.Service<typeof Events>;
  /** The agent plugin's id, recorded as the source of the sections it contributes. */
  readonly source: string;
}

interface TurnSettings {
  readonly systemPrompt?: string;
  /** Shell command for the `lemma` CLI, named in the environment section. */
  readonly cli?: string;
  readonly maxSteps: number;
  /** Failed model calls asked again in a row before the turn ends in error (an overflow is asked again once even at 0). */
  readonly retries: number;
  /** Milliseconds before the first retry; each later one waits twice as long, up to `maxRetryDelay`. */
  readonly retryDelay: number;
  readonly maxRetryDelay: number;
}

/** Calls of one response that run at once, at most, when their tools may run together. */
const PARALLEL_TOOLS = 8;
/** The longest wait a provider may ask for before a retry; a longer one is cut to this. */
const MAX_REQUESTED_DELAY_MS = 15 * 60_000;

/** Milliseconds before retry `attempt` (from 1): the provider's delay when it named one, else doubling backoff with ±20% jitter. */
const retryDelay = (settings: Pick<TurnSettings, "retryDelay" | "maxRetryDelay">, attempt: number, requested?: number): number =>
  requested !== undefined
    ? Math.min(requested, MAX_REQUESTED_DELAY_MS)
    : Math.round(Math.min(settings.maxRetryDelay, settings.retryDelay * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4));

/** A prompt as a turn places it: a user message carrying the submission's id. */
interface Placed {
  readonly requestId: string;
  readonly content: PromptContent;
}

/** The session's queue as the turn sees it: steers join the turn between steps. */
interface TurnInbox {
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

interface TurnInput {
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
   * reloading): a turn interrupted then, or failing, is left open in the log,
   * to resume when the agent starts again, rather than closed as cancelled or
   * failed. The turn suspends itself at its next step or tool call, or when
   * `stopping` completes while it waits to ask again. (A host stopping shuts
   * the core's hooks before it closes the agent; a turn that finds them shut
   * is left open the same way.)
   */
  readonly suspended: () => boolean;
  readonly stopping: Effect.Effect<void>;
  /** Runs a wait (before a failed call is asked again) during which the turn holds no slot, then waits for one. */
  readonly idle: <A, E, R>(wait: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** How `runTurn` returns: the reason it ended, or `suspended` when it was left open in the log to resume. */
export type TurnOutcome = TurnEndReason | "suspended";
interface Ended {
  readonly reason: TurnEndReason;
  readonly error?: string;
}

/** What a tool call in a response cut off at its output limit returns, instead of running. */
const TRUNCATED_CALL =
  "Not run: your response reached its output token limit before this call was complete, so its arguments may be cut off. Make the call again; if it carries a lot of text (a long file), split it into smaller calls.";

/** The text a cut-off tool call that is not run again returns to the model. */
const interruptedText = (output: string | undefined) =>
  output === undefined || output === ""
    ? "Tool execution was interrupted: the host stopped while it ran. It may or may not have finished; check before running it again."
    : `Tool execution was interrupted: the host stopped while it ran. It may or may not have finished; check before running it again. Its output until then:\n${output}`;

export const newId = (): string => randomBytes(6).toString("base64url");

/** What a tool call the branch left without a result tells the model. */
export const BRANCHED_CALL = "No result was recorded for this tool call: the conversation continued without it.";

/**
 * The last assistant message on `branch` the model sees, and its tool calls
 * that have no result after it. A turn answers its calls, so this is set
 * where a checkout put the leaf inside a turn, or a turn ended without
 * logging its results (a write that failed).
 */
export function unansweredCalls(branch: readonly SessionEvent[]): { readonly event: SessionEvent; readonly calls: readonly ToolCall[] } | undefined {
  const { start } = modelView(branch);
  for (let i = branch.length - 1; i >= start; i--) {
    const event = branch[i]!;
    if (event.data.type !== "message" || event.data.message.role !== "assistant") continue;
    const answered = new Set(
      branch
        .slice(i + 1)
        .flatMap((later) => (later.data.type === "message" && later.data.message.role === "toolResult" ? [later.data.message.toolCallId] : [])),
    );
    const calls = event.data.message.content.filter((block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id));
    return calls.length === 0 ? undefined : { event, calls };
  }
  return undefined;
}

const isFirstToken = (event: StreamEvent) =>
  event.type === "text-delta" || event.type === "thinking-delta" || event.type === "toolcall-start" || event.type === "toolcall-delta";

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};

/** A failure of another capability (the log, the models) as the agent reports it: its message, with it as the cause. */
export const failedAs =
  (sessionId: string, reason: AgentError["reason"]) =>
  (error: { readonly message: string }): AgentError =>
    new AgentError({ sessionId, reason, message: error.message, cause: error });

/** `error` is the core's `CoreClosed`, or wraps one (as a hook failure the turn reports does). */
const isCoreClosed = (error: unknown, depth = 0): boolean =>
  typeof error === "object" &&
  error !== null &&
  depth < 8 &&
  ((error as { readonly _tag?: unknown })._tag === "CoreClosed" || ("cause" in error && isCoreClosed(error.cause, depth + 1)));

/** The turn failed because the core is shutting down. */
const closedCore = (cause: Cause.Cause<unknown>): boolean => [...Cause.failures(cause), ...Cause.defects(cause)].some((error) => isCoreClosed(error));

/** Never handled: dispatching it says whether the core still dispatches hooks. */
const Probe = Hook.make<void, void>("agent/core-closing");

/**
 * One turn. The log is written as the turn goes: `turn-start`, the user
 * messages, then per step `step-start`, `request`, the assistant `message` (or
 * an `attempt`), tool results, and `step-end`, with steers placed between
 * steps; `turn-end` closes it, unless the agent suspends it to resume later.
 * Every append names the previous one as its parent, so a checkout elsewhere
 * during the turn cannot splice the turn into another branch.
 */
export function runTurn(services: TurnServices, settings: TurnSettings, input: TurnInput): Effect.Effect<TurnOutcome, AgentError> {
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
    /** Tool calls a `TOOLS_STARTED` event names: they may have run, whatever becomes of the turn. */
    started: Set<string>;
    /** Failed calls asked again since the model last answered. */
    retries: number;
    /** One of them was an overflow (asked again once only). */
    overflowed: boolean;
    /** The last of them failed as too long: the next request asks handlers to shorten the history. */
    shorten: boolean;
  } = {
    lastId: undefined,
    usage: emptyUsage,
    step: undefined,
    partial: undefined,
    partialStartedAt: 0,
    pending: [],
    started: new Set(),
    retries: 0,
    overflowed: false,
    shorten: false,
  };

  const sessionError = failedAs(sessionId, "Session");

  /**
   * Whether the core is shutting down. It refuses every hook call from the moment it begins (hooks fail closed, so
   * that no guard is skipped), before it stops the agent: a turn can go no further, and is not over either.
   */
  const coreClosing = hooks
    .invoke(Probe, undefined, () => Effect.void)
    .pipe(
      Effect.as(false),
      Effect.catchAll((error) => Effect.succeed(error._tag === "CoreClosed")),
    );
  /** Stops the turn, to be left open, when the core is shutting down. */
  const unlessClosing = Effect.flatMap(coreClosing, (closing) => (closing ? Effect.die(new CoreClosed()) : Effect.void));

  /**
   * Uninterruptible so a cancelled turn never loses track of an event that did reach the log. One at a time, so tool
   * calls running together each chain after the last.
   */
  const appending = Effect.unsafeMakeSemaphore(1);
  const append = (data: EventData): Effect.Effect<SessionEvent, AgentError> =>
    appending.withPermits(1)(
      Effect.uninterruptible(
        Effect.suspend(() => sessions.append(sessionId, data, state.lastId === undefined ? undefined : { parent: state.lastId })).pipe(
          Effect.tap((event) =>
            Effect.sync(() => {
              state.lastId = event.id;
            }),
          ),
          Effect.mapError(sessionError),
        ),
      ),
    );

  /** Where a stopping agent suspends the turn: before a step or a tool call, never inside one. */
  const boundary = Effect.suspend(() => (input.suspended() ? Effect.interrupt : Effect.void));

  /**
   * Waits until epoch `at`, without a slot; a stopping agent suspends the turn instead, and the rest of the wait comes
   * when it resumes.
   */
  const waitUntil = (at: number) => Effect.zipRight(input.idle(Effect.raceFirst(Effect.sleep(Math.max(0, at - Date.now())), input.stopping)), boundary);

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

  /**
   * Answers tool calls the branch left without a result, before the turn
   * starts after them: every request needs a result for each call, and a
   * provider adapter that made one up would send what the log does not hold.
   * The results name the call's own turn and step, as that turn's closing
   * results would.
   */
  const closeBranch = Effect.gen(function* () {
    const branch = yield* sessions.branch(sessionId).pipe(Effect.mapError(sessionError));
    // The turn follows the leaf just read, answered or not: a checkout meanwhile cannot move it onto unanswered calls.
    state.lastId = branch.at(-1)?.id;
    const open = unansweredCalls(branch);
    if (open === undefined || open.event.data.type !== "message") return;
    const { turnId: callTurn, stepId: callStep } = open.event.data;
    for (const call of open.calls) {
      yield* append({
        type: "message",
        message: toolResult(call, BRANCHED_CALL),
        ...(callTurn === undefined ? {} : { turnId: callTurn }),
        ...(callStep === undefined ? {} : { stepId: callStep }),
      });
    }
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
        ...(state.shorten ? { overflow: true } : {}),
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
      const model = plan.model === input.model.ref ? input.model : yield* llm.model(plan.model).pipe(Effect.mapError(failedAs(sessionId, "NoModel")));
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
        ...(isDeepStrictEqual(previous.tools ?? [], specs) ? {} : { tools: specs }),
        contributions,
      });
      // Send what the log says was sent: the request is rebuilt from the branch that now ends at the request event.
      const request = rebuildRequest(yield* sessions.branch(sessionId, { leaf: logged.id }).pipe(Effect.mapError(sessionError)), logged.id, sessionId);
      if (request === undefined) return yield* Effect.dieMessage(`request ${logged.id} is not on its own branch`);
      return { request, model, offered: specs.map((spec) => spec.name) };
    });

  /**
   * Whether a failed call is asked again, and when: a transient or rate-limit failure up to `retries` times in a row,
   * and besides those, an overflow once (with a shortened history) until the model answers. A cancelled turn asks
   * nothing again.
   */
  const retryOf = (failure: LlmFailure | undefined) => {
    if (failure === undefined || signal.aborted) return undefined;
    const attempt = state.retries + 1;
    if (failure.kind === "overflow") return state.overflowed ? undefined : { reason: "failure" as const, attempt, at: Date.now() };
    if (failure.kind === "fatal" || attempt - (state.overflowed ? 1 : 0) > settings.retries) return undefined;
    return { reason: "failure" as const, attempt, at: Date.now() + retryDelay(settings, attempt, failure.retryAfterMs) };
  };

  /**
   * Streams one model call. Returns the settled message; or, when the call failed, when it is to be asked again
   * (`retry`) or how the turn ends.
   */
  const callModel = (stepId: string, request: LlmRequest, model: ModelInfo) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      let firstTokenAt: number | undefined;
      let settled: Extract<StreamEvent, { type: "done" | "error" }> | undefined;
      const partial = live.startStep(stepId, startedAt);
      state.partial = partial;
      state.partialStartedAt = startedAt;
      const streamError = yield* llm.stream(request).pipe(
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
      // A call that failed as the core shut down failed because of it, maybe: asked again when the turn resumes, not logged.
      if (settled === undefined || (settled.type === "error" && settled.message.stopReason !== "aborted")) yield* unlessClosing;
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          state.partial = undefined;
          live.endStep();
          if (settled === undefined) {
            const error = streamError ?? "The model stream ended without a result";
            yield* append({ type: "attempt", turnId, stepId, message: partial.message(model, "error", error), timing });
            return { ended: { reason: "error", error } satisfies Ended };
          }
          state.usage = addUsage(state.usage, settled.message.usage);
          if (settled.type === "error") {
            const aborted = settled.message.stopReason === "aborted";
            const failure = aborted ? undefined : settled.failure;
            const retry = retryOf(failure);
            yield* append({
              type: "attempt",
              turnId,
              stepId,
              message: settled.message,
              timing,
              ...(failure === undefined ? {} : { failure }),
              ...(retry === undefined ? {} : { retry }),
            });
            if (retry !== undefined) {
              state.retries = retry.attempt;
              state.shorten = failure?.kind === "overflow";
              state.overflowed ||= state.shorten;
              return { retry };
            }
            return {
              ended: { reason: aborted ? "cancelled" : "error", error: settled.message.errorMessage ?? (aborted ? "Aborted" : "Model error") } satisfies Ended,
            };
          }
          state.retries = 0;
          state.overflowed = false;
          state.shorten = false;
          yield* append({ type: "message", message: settled.message, turnId, stepId, timing });
          state.pending = settled.message.content.filter((block): block is ToolCall => block.type === "toolCall");
          return { message: settled.message };
        }),
      );
    });

  /**
   * Runs one tool call and logs its result. A call in `interrupted` (cut off by a restart, and not safe to repeat) is
   * not run: the model is told so, with the output it had printed. `offered`: the request's tools, the only ones its
   * calls may run.
   */
  const runCall = (stepId: string, call: ToolCall, interrupted: ReadonlyMap<string, string | undefined>, offered?: readonly string[]) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const invocation = new ToolInvocation({
        sessionId,
        toolCallId: call.id,
        name: call.name,
        input: call.arguments,
        cwd,
        ...(offered === undefined ? {} : { offered }),
      });
      // Run as the core shuts down, the call would fail for that alone (its tool not found, its guards closed).
      if (!interrupted.has(call.id)) yield* unlessClosing;
      const result = interrupted.has(call.id)
        ? { content: [{ type: "text" as const, text: interruptedText(interrupted.get(call.id)) }], isError: true, details: undefined }
        : yield* tools.execute(invocation, signal).pipe(
            Effect.map((value) => ({ content: value.content, isError: value.isError ?? false, details: value.details })),
            Effect.catchAll((error) =>
              isCoreClosed(error)
                ? Effect.die(error)
                : Effect.succeed({ content: [{ type: "text" as const, text: error.message }], isError: true, details: undefined }),
            ),
            Effect.catchAllDefect((defect) =>
              isCoreClosed(defect)
                ? Effect.die(defect)
                : Effect.succeed({
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
          state.pending = state.pending.filter((pending) => pending.id !== call.id);
          live.toolEnded(call.id);
        }),
      );
      return message;
    });

  /**
   * Runs the pending tool calls, logging each result as it arrives: in order,
   * except that a run of calls whose tools may run together (`parallel`) runs
   * at once, up to `PARALLEL_TOOLS` of them. Before calls run, an event names
   * them (`TOOLS_STARTED`), so a restart can tell a call that began from one
   * that never did. Returns the results in call order.
   */
  const runTools = (stepId: string, interrupted: ReadonlyMap<string, string | undefined> = new Map(), offered?: readonly string[]) =>
    Effect.gen(function* () {
      const together = new Set((yield* tools.list).flatMap((tool) => (tool.parallel === "safe" ? [tool.spec.name] : [])));
      const joins = (call: ToolCall) => together.has(call.name) && !interrupted.has(call.id);
      const order = new Map(state.pending.map((call, index) => [call.id, index]));
      const results: ToolResultMessage[] = [];
      while (state.pending.length > 0) {
        // `cancel` aborts before it interrupts; start nothing new in between. A stopping agent suspends here.
        if (signal.aborted) return yield* Effect.interrupt;
        yield* boundary;
        // The next call, and when it may run together with others, those after it that may too.
        const [first, ...rest] = state.pending as [ToolCall, ...ToolCall[]];
        const group = [first];
        if (joins(first)) {
          for (const call of rest) {
            if (!joins(call) || group.length >= PARALLEL_TOOLS) break;
            group.push(call);
          }
        }
        const running = group.filter((call) => !interrupted.has(call.id));
        if (running.length > 0) {
          yield* unlessClosing;
          yield* append({ type: "custom", kind: TOOLS_STARTED, data: { turnId, stepId, toolCallIds: running.map((call) => call.id) } });
          for (const call of running) state.started.add(call.id);
        }
        // Every call named starts now: none waits for another to finish first.
        yield* Effect.forEach(
          group,
          (call) =>
            Effect.map(runCall(stepId, call, interrupted, offered), (message) => {
              results.push(message);
            }),
          { concurrency: "unbounded", discard: true },
        );
      }
      return results.sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0));
    });

  /** A response cut off at its output limit: its tool calls may be cut off too, so none runs, and each is answered for the model to make again. */
  const answerTruncated = (stepId: string) =>
    Effect.gen(function* () {
      const results: ToolResultMessage[] = [];
      while (state.pending.length > 0) {
        const call = state.pending[0]!;
        const message = toolResult(call, TRUNCATED_CALL);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* append({ type: "message", message, turnId, stepId });
            state.pending = state.pending.slice(1);
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
        // Tool results the model has not read yet keep it going too, whatever the provider called its stop.
        Effect.succeed(final.message.stopReason === "toolUse" || final.results.length > 0 ? ("continue" as const) : ("stop" as const)),
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

  /**
   * Steps numbered from `first` until the turn ends. A failed call asked
   * again closes its step and waits; the step that asks again keeps the
   * number, so retries take no steps from the turn.
   */
  const steps = (first: number) =>
    Effect.gen(function* () {
      for (let step = first; ;) {
        // A resumed turn can come here out of steps: a cut-off call counted as one.
        if (step > settings.maxSteps) return { reason: "max-steps" } satisfies Ended;
        yield* boundary;
        const stepId = newId();
        yield* append({ type: "step-start", turnId, stepId });
        state.step = { id: stepId, model: input.model };
        const { request, model, offered } = yield* prepareRequest(stepId);
        state.step = { id: stepId, model };
        const outcome = yield* callModel(stepId, request, model);
        if ("retry" in outcome) {
          yield* append({ type: "step-end", turnId, stepId });
          state.step = undefined;
          yield* waitUntil(outcome.retry.at);
          continue;
        }
        if ("ended" in outcome) return outcome.ended;
        const results = outcome.message.stopReason === "length" ? yield* answerTruncated(stepId) : yield* runTools(stepId, new Map(), offered);
        const decision = yield* decide(step, { message: outcome.message, results });
        yield* append({ type: "step-end", turnId, stepId });
        state.step = undefined;
        const ended = yield* afterStep(step, decision);
        if (ended !== undefined) return ended;
        step++;
      }
    });

  /**
   * Continues a turn a restart cut off, from where it stopped: a cut-off model
   * call is logged as an interrupted attempt and asked again in a new step (a
   * failed one being retried is asked again once its wait is over); cut-off
   * tool calls run again when their tool is safe to repeat, and otherwise
   * tell the model they were interrupted, while calls that had not started
   * run; a turn that was closing (cancelled, or failed) closes the same way.
   */
  const resumed = (resume: TurnResume) =>
    Effect.gen(function* () {
      const { plan, restored, cancelling } = resume;
      const at = plan.at;
      state.lastId = plan.lastId;
      state.usage = plan.usage;
      if (plan.retry !== undefined) {
        state.retries = plan.retry.attempts;
        state.overflowed = plan.retry.overflowed;
        state.shorten = plan.retry.overflow;
      }
      yield* append({ type: "custom", kind: RESUMED, data: { turnId } });
      for (const prompt of input.prompts) yield* userMessage(prompt);
      const stepId = at.kind === "between" ? undefined : at.stepId;
      const output = (toolCallId: string) => restored?.output.find((entry) => entry.toolCallId === toolCallId)?.output;
      // What the cut-off call had produced, when the output file got that far.
      const cutStep = restored?.step !== undefined && restored.step.stepId === stepId ? restored.step : undefined;
      const cutOff = () => partialMessage(cutStep?.content ?? [], input.model, cancelling ? "aborted" : "error", cancelling ? "Cancelled" : INTERRUPTED_CALL);
      const timing = () => ({ startedAt: cutStep?.startedAt ?? Date.now(), endedAt: Date.now() });
      /** The next step, once a retry's wait (cut short by the restart) is over. */
      const again = () => Effect.zipRight(plan.retry === undefined ? Effect.void : waitUntil(plan.retry.at), steps(plan.steps + 1));

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
          if (!at.logged) {
            yield* append({
              type: "attempt",
              turnId,
              stepId: at.stepId,
              message: cutOff(),
              timing: timing(),
              retry: { reason: "restart", attempt: 1, at: Date.now() },
            });
          }
          yield* append({ type: "step-end", turnId, stepId: at.stepId });
          return yield* again();
        case "before-request":
          yield* append({ type: "step-end", turnId, stepId: at.stepId });
          return yield* again();
        case "tools": {
          state.step = { id: at.stepId, model: input.model };
          state.pending = [...at.pending];
          for (const id of at.started) state.started.add(id);
          const listed = yield* tools.list;
          const repeatable = new Set(listed.filter((tool) => tool.replay === "safe").map((tool) => tool.spec.name));
          // A call that may have begun is run again only when that is safe; one that had not begun runs now.
          const interrupted = new Map(
            at.pending.filter((call) => at.started.has(call.id) && !repeatable.has(call.name)).map((call) => [call.id, output(call.id)] as const),
          );
          const ran = at.message.stopReason === "length" ? yield* answerTruncated(at.stepId) : yield* runTools(at.stepId, interrupted);
          const results = [...at.results, ...ran];
          const decision = yield* decide(plan.steps, { message: at.message, results });
          yield* append({ type: "step-end", turnId, stepId: at.stepId });
          state.step = undefined;
          return (yield* afterStep(plan.steps, decision)) ?? (yield* steps(plan.steps + 1));
        }
        case "between": {
          // Prompts already placed after the last step are what the model answers next.
          if (at.outcome === undefined || at.steered) return yield* again();
          const decision = yield* decide(plan.steps, at.outcome);
          return (yield* afterStep(plan.steps, decision)) ?? (yield* steps(plan.steps + 1));
        }
      }
    });

  /**
   * Whether the turn stopped because the agent or the core is stopping, rather
   * than ending: then it is left as it is in the log, to resume when the agent
   * starts again. Interrupted otherwise, it was cancelled.
   */
  const leftOpen = (exit: Exit.Exit<Ended, AgentError>): Effect.Effect<boolean> => {
    if (Exit.isSuccess(exit)) return Effect.succeed(false);
    if (input.suspended() || closedCore(exit.cause)) return Effect.succeed(true);
    return Cause.isInterruptedOnly(exit.cause) ? Effect.succeed(false) : coreClosing;
  };
  /** Set by `finish`: the turn was left open. */
  let open = false;

  /**
   * Closes the turn whatever happened, unless it is left open: the partial
   * output of an interrupted model call becomes an `attempt`, unanswered tool
   * calls get error results so the next request is still valid, then
   * `step-end` and `turn-end`.
   */
  const finish = (exit: Exit.Exit<Ended, AgentError>) =>
    Effect.gen(function* () {
      open = yield* leftOpen(exit);
      if (open) return;
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
        const failed = `the turn failed (${ended.error ?? "unknown error"})`;
        const text = cancelled
          ? "Tool execution was cancelled."
          : state.started.has(call.id)
            ? `Tool execution was stopped: ${failed}. It may or may not have finished; check before running it again.`
            : `Tool was not executed: ${failed}.`;
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
          open
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
      yield* closeBranch;
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
      Effect.map((ended): TurnOutcome => ended.reason),
      Effect.catchAllCause((cause) => (open ? Effect.succeed("suspended" as const) : Effect.failCause(cause))),
    );
  });
}
