import { Cause, Clock, Effect, Exit, Semaphore, Stream } from "effect";
import type { Context } from "effect";
import type { Contribution, Events, Registries } from "@lemma/core";
import { AgentError, AssistantDelta, NATIVE_HARNESS, TurnEnded, TurnStarted } from "@lemma/agent";
import type { Access, Harness, HarnessTurn, HarnessUpdate, PromptContent } from "@lemma/agent";
import { emptyUsage } from "@lemma/llm";
import type { AssistantMessage, Message, StreamEvent, ToolCall, Usage } from "@lemma/llm";
import { deriveMessages } from "@lemma/sessions";
import type { EventData, SessionEvent, Sessions, TurnEndReason } from "@lemma/sessions";
import { ToolOutput } from "@lemma/tools";
import type { ResultCredit } from "@lemma/contracts";
import type { LiveTurn } from "./live.ts";
import { titleFrom } from "./prompt.ts";
import { BRANCHED_CALL, failedAs, unansweredCalls } from "./turn.ts";
import type { TurnOutcome } from "./turn.ts";

/** The `custom` event a harness turn logs for what the harness keeps of the session (`HarnessUpdate` `state`). */
export const HARNESS_STATE = "agent.harness-state";

/** What a `HARNESS_STATE` event holds. */
interface StateData {
  readonly harness: string;
  readonly state: unknown;
}

interface HarnessServices {
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  readonly events: Context.Service.Shape<typeof Events>;
  readonly registries: Context.Service.Shape<typeof Registries>;
  /** A new id for a step. */
  readonly newId: () => string;
}

interface Placed {
  readonly requestId: string;
  readonly content: PromptContent;
  readonly credit?: ResultCredit;
}

export interface HarnessTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly harness: Contribution<Harness>;
  readonly prompts: readonly Placed[];
  /** The last prompt's access level, when it chose one. */
  readonly access?: Access;
  /** The last prompt's model, one of the harness's own. */
  readonly model?: string;
  readonly signal: AbortSignal;
  readonly live: LiveTurn;
  readonly logged: (requestId: string) => void;
  /** True once the agent is closing: a turn interrupted then was cut off by the host stopping, not cancelled. */
  readonly suspended: () => boolean;
  readonly kept?: { readonly branch: () => readonly SessionEvent[] | undefined; readonly keep: (branch: readonly SessionEvent[]) => void };
}

/**
 * What a harness that last ran a turn on the branch kept, and the messages logged since: `HarnessTurn.previous`.
 * `branch` ends before the new turn.
 */
export function previousOf(branch: readonly SessionEvent[], harness: string): HarnessTurn["previous"] {
  let start = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = branch[i]!.data;
    if (data.type === "turn-start" && (data.harness ?? NATIVE_HARNESS) === harness) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;
  const turnId = (branch[start]!.data as Extract<EventData, { type: "turn-start" }>).turnId;
  let state: { readonly value: unknown } | undefined;
  for (let i = branch.length - 1; i >= 0 && state === undefined; i--) {
    const data = branch[i]!.data;
    if (data.type === "custom" && data.kind === HARNESS_STATE && (data.data as StateData | undefined)?.harness === harness) {
      state = { value: (data.data as StateData).state };
    }
  }
  if (state === undefined) return undefined;
  const since: Message[] = [];
  for (const event of branch.slice(start)) if (event.data.type === "message" && event.data.turnId !== turnId) since.push(event.data.message);
  return { state: state.value, since };
}

const isStateOf = (event: SessionEvent, harness: string): boolean =>
  event.data.type === "custom" && event.data.kind === HARNESS_STATE && (event.data.data as StateData | undefined)?.harness === harness;

/**
 * Whether what the harness kept on the branch is stale: it ran a later turn on another branch (the log has a later
 * state of its), so the session it continues (another agent's, which only goes forward) holds turns this branch does not.
 */
export function movedOn(log: readonly SessionEvent[], branch: readonly SessionEvent[], harness: string): boolean {
  const kept = branch.filter((event) => isStateOf(event, harness)).at(-1);
  return kept !== undefined && log.some((event) => event.seq > kept.seq && isStateOf(event, harness));
}

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};

type Block = AssistantMessage["content"][number];

/**
 * A turn another harness runs. The agent logs it as it logs its own: `turn-start` naming the harness, the user
 * messages, then for each message the other agent writes a `step-start`, the assistant `message`, its tool results, and
 * `step-end`; `turn-end` closes it, whatever happened (a harness's turn is never left open to resume: one a crash cut
 * off is closed by `closeHarnessTurn`). Every append names the previous one as its parent.
 */
export function runHarnessTurn(services: HarnessServices, input: HarnessTurnInput): Effect.Effect<TurnOutcome, AgentError> {
  const { sessions, events } = services;
  const { sessionId, turnId, live } = input;
  const harness = input.harness.item;
  const sessionError = failedAs(sessionId, "Session");

  const state: {
    lastId: string | undefined;
    branch: SessionEvent[];
    usage: Usage;
    model: string;
    /** The message being written: its step, blocks by stream index, and its calls' indexes. */
    step: { readonly id: string; readonly startedAt: number; blocks: Block[]; readonly calls: Map<string, number>; logged: boolean } | undefined;
    /** Calls of logged messages without a result yet, with the step each was called in. */
    pending: Map<string, { readonly call: ToolCall; readonly stepId: string }>;
    /** Output each running call has printed, for `ToolOutput`'s offsets. */
    printed: Map<string, number>;
  } = { lastId: undefined, branch: [], usage: emptyUsage, model: harness.id, step: undefined, pending: new Map(), printed: new Map() };

  /** How the turn ended, as `finish` closed it. */
  let reason: TurnEndReason = "error";

  const appending = Semaphore.makeUnsafe(1);
  const append = (data: EventData): Effect.Effect<SessionEvent, AgentError> =>
    appending.withPermits(1)(
      Effect.uninterruptible(
        Effect.suspend(() => sessions.append(sessionId, data, state.lastId === undefined ? undefined : { parent: state.lastId })).pipe(
          Effect.tap((event) =>
            Effect.sync(() => {
              state.lastId = event.id;
              state.branch.push(event);
            }),
          ),
          Effect.mapError(sessionError),
        ),
      ),
    );

  const message = (blocks: readonly Block[], stopReason: AssistantMessage["stopReason"], timestamp: number, errorMessage?: string): AssistantMessage => ({
    role: "assistant",
    content: [...blocks],
    api: "harness",
    provider: harness.id,
    model: state.model,
    usage: emptyUsage,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp,
  });

  const delta = (stepId: string, event: StreamEvent) =>
    Effect.suspend(() => events.publish(AssistantDelta, { sessionId, turnId, stepId, seq: live.apply(event), event }));

  /**
   * The message being written, begun when there is none. Calls of an earlier message still running stay open: their
   * results are logged when they come, under the step that called them.
   */
  const openStep = Effect.gen(function* () {
    if (state.step !== undefined && !state.step.logged) return state.step;
    yield* closeStep(undefined);
    const id = services.newId();
    yield* append({ type: "step-start", turnId, stepId: id });
    const startedAt = yield* Clock.currentTimeMillis;
    live.startStep(id, startedAt);
    state.step = { id, startedAt, blocks: [], calls: new Map(), logged: false };
    yield* delta(id, { type: "start" });
    return state.step;
  });

  /** Logs the message being written, if it has anything to log. */
  const logMessage = (stopReason: AssistantMessage["stopReason"], errorMessage?: string) =>
    Effect.gen(function* () {
      const step = state.step;
      if (step === undefined || step.logged) return;
      step.logged = true;
      const endedAt = yield* Clock.currentTimeMillis;
      const calls = step.blocks.filter((block): block is ToolCall => block.type === "toolCall");
      for (const call of calls) state.pending.set(call.id, { call, stepId: step.id });
      yield* append({
        type: "message",
        message: message(step.blocks, calls.length > 0 && stopReason === "stop" ? "toolUse" : stopReason, endedAt, errorMessage),
        turnId,
        stepId: step.id,
        timing: { startedAt: step.startedAt, endedAt },
      });
      live.endStep();
    });

  /**
   * Ends the step: its message logged, and `step-end`. `unanswered`, as the turn ends: every call still open is answered
   * with it first; none, as the agent moves on: they stay open.
   */
  const closeStep = (unanswered: string | undefined, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string) =>
    Effect.gen(function* () {
      const step = state.step;
      if (step !== undefined) yield* logMessage(stopReason, errorMessage);
      // An earlier step's calls are answered too, though no step is being written.
      if (unanswered !== undefined) for (const open of state.pending.values()) yield* toolResult(open, [{ type: "text", text: unanswered }], true);
      if (step === undefined) return;
      yield* append({ type: "step-end", turnId, stepId: step.id });
      state.step = undefined;
    });

  const toolResult = (
    open: { readonly call: ToolCall; readonly stepId: string },
    content: Extract<HarnessUpdate, { type: "tool-result" }>["content"],
    isError: boolean,
    details?: unknown,
  ) =>
    Effect.gen(function* () {
      const { call } = open;
      state.pending.delete(call.id);
      yield* append({
        type: "message",
        message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [...content], isError, timestamp: yield* Clock.currentTimeMillis },
        turnId,
        stepId: open.stepId,
        ...(details === undefined ? {} : { details }),
      });
      live.toolEnded(call.id);
    });

  const textBlock = (kind: "text" | "thinking", text: string) =>
    Effect.gen(function* () {
      const step = yield* openStep;
      const last = step.blocks.at(-1);
      if (last?.type === "text" && kind === "text") step.blocks[step.blocks.length - 1] = { ...last, text: last.text + text };
      else if (last?.type === "thinking" && kind === "thinking") step.blocks[step.blocks.length - 1] = { ...last, thinking: last.thinking + text };
      else step.blocks.push(kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text });
      const index = step.blocks.length - 1;
      yield* delta(step.id, kind === "text" ? { type: "text-delta", index, delta: text } : { type: "thinking-delta", index, delta: text });
    });

  const apply = (update: HarnessUpdate): Effect.Effect<void, AgentError> => {
    switch (update.type) {
      case "text":
      case "thinking":
        return update.delta === "" ? Effect.void : textBlock(update.type, update.delta);
      case "tool-call":
        return Effect.gen(function* () {
          // Its message is logged already: its arguments stay as logged.
          if (state.pending.has(update.id)) return;
          const step = yield* openStep;
          const call: ToolCall = { type: "toolCall", id: update.id, name: update.name, arguments: { ...update.arguments } };
          const known = step.calls.get(update.id);
          const index = known ?? step.blocks.length;
          step.blocks[index] = call;
          if (known === undefined) {
            step.calls.set(update.id, index);
            yield* delta(step.id, { type: "toolcall-start", index, id: call.id, name: call.name });
          }
          yield* delta(step.id, { type: "toolcall-end", index, toolCall: call });
        });
      case "tool-output":
        return Effect.suspend(() => {
          const offset = state.printed.get(update.id) ?? 0;
          state.printed.set(update.id, offset + update.chunk.length);
          live.toolOutput(update.id, update.chunk, offset);
          return events.publish(ToolOutput, { sessionId, toolCallId: update.id, chunk: update.chunk, offset });
        });
      case "tool-result":
        return Effect.gen(function* () {
          const step = state.step;
          if (step !== undefined && !step.logged && step.calls.has(update.id)) yield* logMessage("stop");
          const open = state.pending.get(update.id);
          if (open === undefined) return;
          yield* toolResult(open, update.content, update.isError, update.details);
          // The step that called it ends once its calls are answered; a later one the agent is writing goes on.
          if (state.pending.size === 0 && state.step?.id === open.stepId) yield* closeStep("");
        });
      case "model":
        return Effect.sync(() => {
          state.model = update.model;
        });
      case "usage":
        return Effect.sync(() => {
          state.usage = update.usage;
        });
      case "state":
        return Effect.asVoid(append({ type: "custom", kind: HARNESS_STATE, data: { harness: harness.id, state: update.data } satisfies StateData }));
    }
  };

  /** The branch the turn continues: the one the last turn left, if the leaf has not moved, else read from the store. */
  const branchNow = Effect.gen(function* () {
    const kept = input.kept?.branch();
    const leaf = kept === undefined ? undefined : (yield* sessions.get(sessionId).pipe(Effect.mapError(sessionError))).leaf;
    return kept !== undefined && leaf !== undefined && kept.at(-1)?.id === leaf
      ? [...kept]
      : yield* sessions.branch(sessionId).pipe(Effect.mapError(sessionError));
  });

  /** Closes the turn whatever happened: the message being written is logged as it stands, its open calls answered. */
  const finish = (exit: Exit.Exit<void, AgentError>) =>
    Effect.gen(function* () {
      const ended: { reason: TurnEndReason; error?: string } = Exit.isSuccess(exit)
        ? { reason: "done" }
        : !Cause.hasInterruptsOnly(exit.cause)
          ? { reason: "error", error: causeMessage(exit.cause) }
          : input.suspended()
            ? { reason: "error", error: `The host stopped while ${harness.title} ran this turn.` }
            : { reason: "cancelled" };
      reason = ended.reason;
      const unanswered =
        ended.reason === "done"
          ? "The agent ended its turn without reporting this call's result."
          : ended.reason === "cancelled"
            ? "Tool execution was cancelled."
            : `Tool execution was stopped: the turn failed (${ended.error}). It may or may not have finished.`;
      if (ended.reason === "done") yield* closeStep(unanswered);
      else yield* closeStep(unanswered, ended.reason === "cancelled" ? "aborted" : "error", ended.reason === "cancelled" ? "Cancelled" : ended.error);
      // The harness reports what the whole turn cost, which its messages do not carry: logged with the turn's end.
      const usage = state.usage.totalTokens > 0 || state.usage.cost.total > 0 ? { usage: state.usage } : {};
      yield* append({ type: "turn-end", turnId, reason: ended.reason, ...(ended.error === undefined ? {} : { error: ended.error }), ...usage });
      input.kept?.keep(state.branch);
    }).pipe(
      Effect.catch((error) => Effect.logWarning(`agent: could not close turn ${turnId} in session ${sessionId}: ${error.message}`)),
      Effect.ensuring(
        Effect.suspend(() =>
          events.publish(TurnEnded, {
            sessionId,
            turnId,
            usage: state.usage,
            reason,
          }),
        ),
      ),
    );

  return Effect.gen(function* () {
    const branch = yield* branchNow;
    state.branch = [...branch];
    state.lastId = branch.at(-1)?.id;
    // Calls a checkout left without a result are answered first, as every turn's are.
    const open = unansweredCalls(branch);
    if (open !== undefined && open.event.data.type === "message") {
      const { turnId: callTurn, stepId: callStep } = open.event.data;
      for (const call of open.calls) {
        yield* append({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: BRANCHED_CALL }],
            isError: true,
            timestamp: yield* Clock.currentTimeMillis,
          },
          ...(callTurn === undefined ? {} : { turnId: callTurn }),
          ...(callStep === undefined ? {} : { stepId: callStep }),
        });
      }
    }
    const before = [...state.branch];
    yield* append({ type: "turn-start", turnId, harness: harness.id });
    yield* events.publish(TurnStarted, { sessionId, turnId, requestIds: input.prompts.map((prompt) => prompt.requestId) });
    const body = Effect.gen(function* () {
      for (const placed of input.prompts) {
        yield* Effect.uninterruptible(
          Effect.flatMap(Clock.currentTimeMillis, (timestamp) =>
            append({
              type: "message",
              message: { role: "user", content: placed.content, timestamp },
              turnId,
              requestId: placed.requestId,
              ...(placed.credit === undefined ? {} : { credit: placed.credit }),
            }),
          ).pipe(Effect.tap(() => Effect.sync(() => input.logged(placed.requestId)))),
        );
      }
      const first = input.prompts[0];
      const title = input.title === undefined && first !== undefined ? titleFrom(first.content) : undefined;
      if (title !== undefined) yield* append({ type: "title", title });
      const found = previousOf(before, harness.id);
      // Kept on a branch since left: the harness starts afresh, handed the whole conversation.
      const previous =
        found !== undefined && movedOn(yield* sessions.events(sessionId).pipe(Effect.mapError(sessionError)), before, harness.id) ? undefined : found;
      const turn: HarnessTurn = {
        sessionId,
        turnId,
        cwd: input.cwd,
        prompts: input.prompts.map((prompt) => prompt.content),
        history: deriveMessages(before),
        ...(previous === undefined ? {} : { previous }),
        ...(input.access === undefined ? {} : { access: input.access }),
        ...(input.model === undefined ? {} : { model: input.model }),
        signal: input.signal,
      };
      const stopped = new AgentError({
        sessionId,
        reason: "NoHarness",
        message: `${harness.title} stopped while it ran the turn: its plugin stopped, or the host did.`,
      });
      yield* services.registries
        .run(input.harness, (left) =>
          Effect.raceFirst(
            harness.run(turn).pipe(
              Stream.mapError((error) => new AgentError({ sessionId, reason: "NoHarness", message: `${harness.title}: ${error.message}`, cause: error })),
              Stream.runForEach(apply),
            ),
            Effect.andThen(left, Effect.fail(stopped)),
          ),
        )
        .pipe(Effect.mapError((error) => (error._tag === "AgentError" ? error : stopped)));
    });
    return yield* body.pipe(
      Effect.onExit((exit) => finish(Exit.asVoid(exit))),
      Effect.as<TurnOutcome>("done"),
    );
  });
}

/**
 * Closes a turn another harness ran that a crash or a host stopping cut off, as the agent starts again: harnesses do
 * not resume turns. Its message being written stays as it was logged; open calls are answered, the step ended, and the
 * turn ends in error, or cancelled when `cancel` had been asked for.
 */
export function closeHarnessTurn(
  services: Pick<HarnessServices, "sessions" | "events">,
  input: { readonly sessionId: string; readonly turnId: string; readonly harness: string; readonly cancelling: boolean },
): Effect.Effect<TurnOutcome, AgentError> {
  const { sessions, events } = services;
  const { sessionId, turnId } = input;
  return Effect.gen(function* () {
    yield* events.publish(TurnStarted, { sessionId, turnId, requestIds: [] });
    const log = yield* sessions.events(sessionId).pipe(Effect.mapError(failedAs(sessionId, "Session")));
    const own = log.filter((event) => "turnId" in event.data && event.data.turnId === turnId);
    let lastId = own.at(-1)?.id;
    const append = (data: EventData) =>
      sessions.append(sessionId, data, lastId === undefined ? undefined : { parent: lastId }).pipe(
        Effect.tap((event) => Effect.sync(() => (lastId = event.id))),
        Effect.mapError(failedAs(sessionId, "Session")),
      );
    const reason: TurnEndReason = input.cancelling ? "cancelled" : "error";
    const error = input.cancelling ? undefined : `The host stopped while the ${input.harness} harness ran this turn.`;
    const branch = yield* sessions.branch(sessionId, { leaf: lastId! }).pipe(Effect.mapError(failedAs(sessionId, "Session")));
    const open = unansweredCalls(branch);
    if (open !== undefined && open.event.data.type === "message" && open.event.data.turnId === turnId) {
      for (const call of open.calls) {
        yield* append({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: input.cancelling ? "Tool execution was cancelled." : `Tool execution was stopped: ${error}` }],
            isError: true,
            timestamp: yield* Clock.currentTimeMillis,
          },
          turnId,
          ...(open.event.data.stepId === undefined ? {} : { stepId: open.event.data.stepId }),
        });
      }
    }
    const steps = new Set<string>();
    for (const event of own) {
      if (event.data.type === "step-start") steps.add(event.data.stepId);
      if (event.data.type === "step-end") steps.delete(event.data.stepId);
    }
    for (const stepId of steps) yield* append({ type: "step-end", turnId, stepId });
    yield* append({ type: "turn-end", turnId, reason, ...(error === undefined ? {} : { error }) });
    yield* events.publish(TurnEnded, { sessionId, turnId, usage: emptyUsage, reason });
    return reason;
  });
}
