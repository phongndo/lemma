import { randomBytes } from "node:crypto";
import { Cause, Effect, Exit } from "effect";
import type { Context } from "effect";
import type { Events } from "@lemma/core";
import { addUsage, AgentError, AssistantDelta, emptyUsage, titleFrom, TurnEnded, TurnStarted } from "@lemma/contracts";
import type {
  AssistantMessage,
  EventData,
  HarnessTurn,
  ImageContent,
  PlacedPrompt,
  SessionError,
  SessionEvent,
  Sessions,
  StopReason,
  StreamEvent,
  TextContent,
  ToolCall,
  TurnReason,
  Usage,
} from "@lemma/contracts";

/*
 * Logs a turn that another agent runs. The agent reports what it does as a
 * stream (text, thinking, tool calls, their results); this turns that into
 * the events the native loop logs, so every client shows the session the
 * same way: `turn-start` naming the harness, the prompts, then per stretch of
 * model output a step (`step-start`, the assistant `message` with its tool
 * calls, their results, `step-end`), and `turn-end`. There are no `request`
 * events: the agent keeps its own context, and the log records what it did.
 *
 * A step's assistant message is logged when the first of its tool calls gets
 * a result (or when the turn ends), so each result follows the call it
 * answers. Output after a result starts the next step.
 */

export interface RecorderServices {
  readonly sessions: Context.Tag.Service<typeof Sessions>;
  readonly events: Context.Tag.Service<typeof Events>;
}

/** What the turn's assistant messages say produced them. */
export interface Producer {
  /** The harness id, recorded in `turn-start`. */
  readonly harness: string;
  /** `AssistantMessage.api`: the protocol the agent speaks (`acp`). */
  readonly api: string;
  /** `AssistantMessage.provider`: the agent. */
  readonly provider: string;
  /** `AssistantMessage.model`, until the agent names one (`TurnRecorder.model`). */
  readonly model: string;
  /** The agent's name in what the record says to people. Absent: `provider`. */
  readonly title?: string;
}

/** A tool call as the agent reports it. */
export interface RecordedCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A tool call's result. `details` is for UIs (a diff, an exit code) and never shown to a model. */
export interface RecordedResult {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError: boolean;
  readonly details?: unknown;
}

/** How the turn ends, as its body reports it. */
export interface Ended {
  readonly reason: TurnReason;
  readonly error?: string;
}

export interface TurnRecorder {
  readonly text: (delta: string) => Effect.Effect<void, AgentError>;
  readonly thinking: (delta: string) => Effect.Effect<void, AgentError>;
  /** A call the agent is making; a call it reports again (with its input filled in) updates the one recorded. */
  readonly toolCall: (call: RecordedCall) => Effect.Effect<void, AgentError>;
  /** A call's result. One for a call that is not recorded, or already answered, is ignored. */
  readonly toolResult: (id: string, result: RecordedResult) => Effect.Effect<void, AgentError>;
  /** Adds to the turn's cost; carried by the next assistant message logged. */
  readonly usage: (usage: Usage) => Effect.Effect<void>;
  /** The model the agent is now running on, for the messages logged from here. */
  readonly model: (model: string) => Effect.Effect<void>;
  /** A `custom` event, chained after the turn's last. */
  readonly custom: (kind: string, data: unknown) => Effect.Effect<SessionEvent, AgentError>;
}

const newId = (): string => randomBytes(6).toString("base64url");

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};

type Block = AssistantMessage["content"][number];

/** The step's model output not logged yet. */
interface Draft {
  readonly blocks: Block[];
  readonly startedAt: number;
  firstTokenAt: number | undefined;
}

/**
 * Runs `body` as the turn: logs its beginning, hands it a recorder, and closes
 * the turn however the body ends, including when the agent suspends it (the
 * host stopping): another agent's turn cannot continue after a restart. One a
 * crash left open (`turn.resume`) is closed as interrupted (or cancelled), its
 * unanswered calls answered, without running `body`.
 */
export function recordTurn(
  services: RecorderServices,
  turn: HarnessTurn,
  producer: Producer,
  body: (recorder: TurnRecorder) => Effect.Effect<Ended, AgentError>,
): Effect.Effect<TurnReason, AgentError> {
  const { sessions, events } = services;
  const { sessionId, turnId, live } = turn;

  const state: {
    lastId: string | undefined;
    model: string;
    /** Cost not yet carried by a logged message. */
    unlogged: Usage;
    /** The whole turn's cost, for `TurnEnded`. */
    usage: Usage;
    /** The open step: `step-start` logged, `step-end` not. */
    step: string | undefined;
    draft: Draft | undefined;
    /** Calls in the draft, by id, with their block index. */
    drafted: Map<string, number>;
    /** Logged calls without a result, with their step and name. */
    pending: Map<string, { readonly stepId: string; readonly name: string }>;
  } = {
    lastId: undefined,
    model: producer.model,
    unlogged: emptyUsage,
    usage: emptyUsage,
    step: undefined,
    draft: undefined,
    drafted: new Map(),
    pending: new Map(),
  };

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

  const userMessage = (placed: PlacedPrompt) =>
    append({ type: "message", message: { role: "user", content: placed.content, timestamp: Date.now() }, turnId, requestId: placed.requestId }).pipe(
      Effect.tap(() => Effect.sync(() => turn.logged(placed.requestId))),
    );

  const publish = (stepId: string, event: StreamEvent) => {
    const seq = live.apply(event);
    return events.publish(AssistantDelta, { sessionId, turnId, stepId, seq, event });
  };

  const closeStep = Effect.suspend(() => {
    const stepId = state.step;
    if (stepId === undefined) return Effect.void;
    state.step = undefined;
    return Effect.asVoid(append({ type: "step-end", turnId, stepId }));
  });

  /** The draft of the open step, beginning a step for it when there is none (or the open one's message is logged). */
  const draft = Effect.gen(function* () {
    if (state.draft !== undefined && state.step !== undefined) return { draft: state.draft, stepId: state.step };
    yield* closeStep;
    const stepId = newId();
    yield* append({ type: "step-start", turnId, stepId });
    state.step = stepId;
    const startedAt = Date.now();
    state.draft = { blocks: [], startedAt, firstTokenAt: undefined };
    live.startStep(stepId, startedAt);
    return { draft: state.draft, stepId };
  });

  /** Logs the draft as the step's assistant message; its calls then wait for results. */
  const flush = (stopReason: StopReason, errorMessage?: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = state.draft;
        const stepId = state.step;
        if (current === undefined || stepId === undefined) return;
        const message: AssistantMessage = {
          role: "assistant",
          content: current.blocks,
          api: producer.api,
          provider: producer.provider,
          model: state.model,
          usage: state.unlogged,
          stopReason,
          ...(errorMessage === undefined ? {} : { errorMessage }),
          timestamp: Date.now(),
        };
        const timing = {
          startedAt: current.startedAt,
          ...(current.firstTokenAt === undefined ? {} : { firstTokenAt: current.firstTokenAt }),
          endedAt: Date.now(),
        };
        yield* append({ type: "message", message, turnId, stepId, timing });
        state.unlogged = emptyUsage;
        for (const block of current.blocks) if (block.type === "toolCall") state.pending.set(block.id, { stepId, name: block.name });
        state.draft = undefined;
        state.drafted = new Map();
        live.endStep();
      }),
    );

  const delta = (kind: "text" | "thinking", text: string) =>
    Effect.gen(function* () {
      if (text === "") return;
      const { draft: current, stepId } = yield* draft;
      current.firstTokenAt ??= Date.now();
      const last = current.blocks.length - 1;
      const block = current.blocks[last];
      let index = last;
      if (kind === "text" && block?.type === "text") current.blocks[last] = { ...block, text: block.text + text };
      else if (kind === "thinking" && block?.type === "thinking") current.blocks[last] = { ...block, thinking: block.thinking + text };
      else {
        current.blocks.push(kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text });
        index = current.blocks.length - 1;
      }
      yield* publish(stepId, kind === "text" ? { type: "text-delta", index, delta: text } : { type: "thinking-delta", index, delta: text });
    });

  const recorder: TurnRecorder = {
    text: (text) => delta("text", text),
    thinking: (text) => delta("thinking", text),
    toolCall: (call) =>
      Effect.gen(function* () {
        // Logged already: its input is on record, and a late report changes nothing there.
        if (state.pending.has(call.id)) return;
        const known = state.drafted.get(call.id);
        const toolCall: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: { ...call.arguments } };
        if (known !== undefined && state.draft !== undefined && state.step !== undefined) {
          const before = state.draft.blocks[known];
          // Agents report a call again with each status change; only a change to what it is reaches clients.
          if (before?.type === "toolCall" && before.name === toolCall.name && JSON.stringify(before.arguments) === JSON.stringify(toolCall.arguments)) return;
          state.draft.blocks[known] = toolCall;
          yield* publish(state.step, { type: "toolcall-end", index: known, toolCall });
          return;
        }
        const { draft: current, stepId } = yield* draft;
        current.firstTokenAt ??= Date.now();
        current.blocks.push(toolCall);
        const index = current.blocks.length - 1;
        state.drafted.set(call.id, index);
        yield* publish(stepId, { type: "toolcall-start", index, id: call.id, name: call.name });
        yield* publish(stepId, { type: "toolcall-end", index, toolCall });
      }),
    toolResult: (id, result) =>
      Effect.gen(function* () {
        if (state.drafted.has(id)) yield* flush("toolUse");
        const call = state.pending.get(id);
        if (call === undefined) return;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* append({
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: id,
                toolName: call.name,
                content: [...result.content],
                isError: result.isError,
                timestamp: Date.now(),
              },
              turnId,
              stepId: call.stepId,
              ...(result.details === undefined ? {} : { details: result.details }),
            });
            state.pending.delete(id);
            live.toolEnded(id);
          }),
        );
      }),
    usage: (usage) =>
      Effect.sync(() => {
        state.unlogged = addUsage(state.unlogged, usage);
        state.usage = addUsage(state.usage, usage);
      }),
    model: (model) =>
      Effect.sync(() => {
        state.model = model;
      }),
    custom: (kind, data) => append({ type: "custom", kind, data }),
  };

  /**
   * Closes the turn whatever happened: the draft is logged (as an error or
   * cancelled message when the turn did not finish), unanswered calls get
   * error results so the record stays whole, then `step-end` and `turn-end`.
   */
  const finish = (exit: Exit.Exit<Ended, AgentError>) =>
    Effect.gen(function* () {
      const interrupted = Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause);
      // Another agent's turn cannot continue after the agent stops (its prompt stops with it), so one the agent
      // suspends is closed now, with what it produced, rather than left open for a resume that cannot happen.
      const ended: Ended = Exit.isSuccess(exit)
        ? exit.value
        : interrupted && turn.suspended()
          ? { reason: "error", error: `Lemma stopped while ${producer.title ?? producer.provider} was running this turn. Send the prompt again to go on.` }
          : interrupted
            ? { reason: "cancelled" }
            : { reason: "error", error: causeMessage(exit.cause) };
      const cancelled = ended.reason === "cancelled";
      if (state.draft !== undefined) {
        const calls = state.draft.blocks.some((block) => block.type === "toolCall");
        if (ended.reason === "done" || ended.reason === "max-steps") yield* flush(calls ? "toolUse" : "stop");
        else yield* flush(cancelled ? "aborted" : "error", cancelled ? "Cancelled" : (ended.error ?? "Turn failed"));
      } else if (state.unlogged.totalTokens > 0 || state.unlogged.cost.total > 0) {
        // Cost reported after the last message: carried by an empty one, so the turn's total in the log is whole.
        yield* draft;
        yield* flush("stop");
      }
      for (const [id, call] of state.pending) {
        const text = cancelled ? "Tool execution was cancelled." : `The agent reported no result for this call (${ended.error ?? "the turn ended"}).`;
        yield* append({
          type: "message",
          message: { role: "toolResult", toolCallId: id, toolName: call.name, content: [{ type: "text", text }], isError: true, timestamp: Date.now() },
          turnId,
          stepId: call.stepId,
        });
        state.pending.delete(id);
        live.toolEnded(id);
      }
      yield* closeStep;
      yield* append({ type: "turn-end", turnId, reason: ended.reason, ...(ended.error === undefined ? {} : { error: ended.error }) });
    }).pipe(
      Effect.catchAll((error) => Effect.logWarning(`${producer.harness}: could not close turn ${turnId} in session ${sessionId}: ${error.message}`)),
      Effect.ensuring(
        Effect.suspend(() =>
          events.publish(TurnEnded, {
            sessionId,
            turnId,
            usage: state.usage,
            reason: Exit.isSuccess(exit) ? exit.value.reason : Cause.isInterruptedOnly(exit.cause) && !turn.suspended() ? "cancelled" : "error",
          }),
        ),
      ),
    );

  /** A turn a restart cut off: chained after its last event, with its open step and unanswered calls, to close it. */
  const reopen = Effect.gen(function* () {
    const log = yield* sessions.events(sessionId).pipe(Effect.mapError(sessionError));
    // The turn's events, with the `custom` ones a harness logged naming it in their data.
    const mine = log.filter(
      (event) =>
        ("turnId" in event.data && event.data.turnId === turnId) ||
        (event.data.type === "custom" && (event.data.data as { readonly turnId?: unknown } | null)?.turnId === turnId),
    );
    state.lastId = mine[mine.length - 1]?.id;
    const answered = new Set<string>();
    for (const event of mine) {
      const data = event.data;
      if (data.type === "step-start") state.step = data.stepId;
      else if (data.type === "step-end") state.step = undefined;
      else if (data.type === "message" && data.message.role === "toolResult") answered.add(data.message.toolCallId);
      else if (data.type === "message" && data.message.role === "assistant" && data.stepId !== undefined) {
        state.usage = addUsage(state.usage, data.message.usage);
        for (const block of data.message.content) if (block.type === "toolCall") state.pending.set(block.id, { stepId: data.stepId, name: block.name });
      }
    }
    for (const id of answered) state.pending.delete(id);
  });

  return Effect.gen(function* () {
    const resume = turn.resume;
    if (resume !== undefined) {
      yield* reopen;
      yield* events.publish(TurnStarted, { sessionId, turnId });
      const ended: Ended = resume.cancelling
        ? { reason: "cancelled" }
        : {
            reason: "error",
            error: `The host stopped while ${producer.title ?? producer.provider} was running this turn, and it cannot continue it. Send the prompt again.`,
          };
      yield* finish(Exit.succeed(ended));
      return ended.reason;
    }
    yield* append({
      type: "turn-start",
      turnId,
      harness: producer.harness,
      ...(turn.options.model === undefined ? {} : { model: turn.options.model }),
      ...(turn.options.thinking === undefined ? {} : { thinking: turn.options.thinking }),
    });
    yield* events.publish(TurnStarted, { sessionId, turnId });
    const run = Effect.gen(function* () {
      for (const prompt of turn.prompts) yield* userMessage(prompt);
      const first = turn.prompts[0];
      const title = turn.title === undefined && first !== undefined ? titleFrom(first.content) : undefined;
      if (title !== undefined) yield* append({ type: "title", title });
      return yield* body(recorder);
    });
    return yield* run.pipe(
      Effect.onExit(finish),
      Effect.map((ended) => ended.reason),
    );
  });
}
