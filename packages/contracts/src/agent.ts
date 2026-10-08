import { Context, Data, Effect, Schema, Stream } from "effect";
import { Event, Hook } from "@lemma/core";
import type { Events } from "@lemma/core";
import { defineChannel, eventFeed, serveChannel } from "./channels.ts";
import type { Channel } from "./channels.ts";
import { AssistantMessage, ImageContent, Message, ModelRef, StreamEvent, TextContent, ThinkingLevel, Usage } from "./llm.ts";
import type { ToolResultMessage } from "./llm.ts";
import { TurnEndReason } from "./sessions.ts";
import type { EventData, SessionEvent } from "./sessions.ts";
import { ToolOutput } from "./tools.ts";
import type { ToolContribution } from "./tools.ts";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly sessionId: string;
  /** `Retracted`: `withdraw` took the prompt out of the queue before a turn placed it. */
  readonly reason: "Busy" | "NoModel" | "Session" | "Hook" | "Retracted";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const TurnOptions = Schema.Struct({
  /** Falls back to the agent's configured default, then the first available model. */
  model: Schema.optional(ModelRef),
  thinking: Schema.optional(ThinkingLevel),
});
export type TurnOptions = typeof TurnOptions.Type;

export const PromptContent = Schema.Array(Schema.Union([TextContent, ImageContent]));
export type PromptContent = typeof PromptContent.Type;

/**
 * What a prompt does while the session has a turn running: `steer` joins the
 * running turn after its current tool calls; `follow-up` waits and starts the
 * next turn; `reject` fails with `Busy`.
 */
export const WhenBusy = Schema.Literals(["steer", "follow-up", "reject"]);
export type WhenBusy = typeof WhenBusy.Type;

/** A prompt waiting for a turn to place it (see `WhenBusy`). */
export const QueuedPrompt = Schema.Struct({
  /** The caller's `requestId`, or one the agent gave it. */
  requestId: Schema.String,
  content: PromptContent,
  mode: Schema.Literals(["steer", "follow-up"]),
  options: Schema.optional(TurnOptions),
  /** Epoch milliseconds it was queued. */
  at: Schema.Number,
});
export type QueuedPrompt = typeof QueuedPrompt.Type;

/**
 * What a client that joins or reconnects needs to show a session as it is now,
 * beyond its log: the running turn's model output so far and running tools'
 * output (both also streamed as events), and the queue.
 */
export const AgentView = Schema.Struct({
  /** The running turn, absent while idle. */
  turnId: Schema.optional(Schema.String),
  /**
   * The model call in flight: its step and what it has produced, through the stream event numbered `seq`. Each block
   * carries its `index` in the stream, which the deltas that follow name.
   */
  draft: Schema.optional(
    Schema.Struct({
      stepId: Schema.String,
      seq: Schema.Number,
      blocks: Schema.Array(Schema.Struct({ index: Schema.Number, block: AssistantMessage.fields.content.value })),
    }),
  ),
  /** Running tools' output so far, by tool call id: its tail, and `length`, how much the tool has printed in all. */
  output: Schema.Array(Schema.Struct({ toolCallId: Schema.String, output: Schema.String, length: Schema.Number })),
  queue: Schema.Array(QueuedPrompt),
  /** The queue's revision (see `QueueChanged`): a client keeps whichever queue it has with the higher one. */
  queueRevision: Schema.Number,
});
export type AgentView = typeof AgentView.Type;

/** A named part of the system prompt and the plugin that contributed it (a handler uses its own `PluginContext` id). */
export interface SystemSection {
  readonly id: string;
  readonly source: string;
  readonly text: string;
}

/**
 * The model-facing request before it is logged and sent. Handlers of
 * `AgentRequestHook` add or edit sections and tools and may change the model
 * or thinking level. `branch` and `history` are read-only, as they stood when
 * the hook began: the terminal ignores them, because changing what the model
 * sees means appending session events, with `append`.
 */
export interface RequestDraft {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly model: ModelRef;
  readonly thinking?: ThinkingLevel;
  readonly sections: readonly SystemSection[];
  readonly tools: readonly ToolContribution[];
  /**
   * The previous call failed because its request was too long for the model: a handler that shortens the history
   * (compaction) does so now, whatever its own estimate says. Asked once: another overflow before the model answers
   * ends the turn.
   */
  readonly overflow?: boolean;
  /** The turn's branch, root to its last event: what the request continues. */
  readonly branch: readonly SessionEvent[];
  /** `deriveMessages(branch)`. */
  readonly history: readonly Message[];
  /**
   * Appends an event after the turn's last one (a `compaction`, say); the
   * request, and the rest of the turn, continue from it. It stays on the
   * turn's branch even if a later handler fails or the turn is cancelled, and
   * a checkout meanwhile cannot move it. A handler written with promises
   * runs the Effect it returns with its plugin's `run`.
   */
  readonly append: (data: EventData) => Effect.Effect<SessionEvent, AgentError>;
}

export type RequestPlan = Omit<RequestDraft, "history" | "branch" | "append" | "sessionId" | "turnId" | "cwd" | "overflow">;

/** Runs before every model call. Skills, project context, and prompt plugins contribute here. */
export const AgentRequestHook = Hook.make<RequestDraft, RequestPlan, AgentError>("lemma/agent.request");

/**
 * Runs after each step. The default continues while the model asked for tools
 * (or tools answered it, so it has results to read) and stops otherwise; a
 * handler can stop early or push the model to continue.
 */
export interface StepOutcome {
  readonly sessionId: string;
  readonly turnId: string;
  readonly step: number;
  readonly message: AssistantMessage;
  readonly results: readonly ToolResultMessage[];
}
export const AgentContinueHook = Hook.make<StepOutcome, "continue" | "stop", AgentError>("lemma/agent.continue");

export const TurnStarted = Event.make<{ readonly sessionId: string; readonly turnId: string }>("lemma/agent.turn.started");
export const TurnEnded = Event.make<{
  readonly sessionId: string;
  readonly turnId: string;
  readonly usage: Usage;
  readonly reason: TurnEndReason;
}>("lemma/agent.turn.ended");
/**
 * The session's queue changed: a prompt was queued, placed, or withdrawn.
 * `revision` grows with every change (across restarts too), so a client
 * holding a queue from `Agent.view` and from this event keeps the newer.
 */
export const QueueChanged = Event.make<{ readonly sessionId: string; readonly queue: readonly QueuedPrompt[]; readonly revision: number }>(
  "lemma/agent.queue.changed",
);
/**
 * Live model output for UIs; the durable record is the `message` or `attempt` event appended when the stream settles.
 * `seq` numbers a step's stream events from 1, so a client seeded from `Agent.view` skips those its draft holds.
 */
export const AssistantDelta = Event.make<{
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly seq: number;
  readonly event: StreamEvent;
}>("lemma/agent.delta");

/** How a prompt is submitted: the turn's options, plus what to do while busy and its id for exactly-once delivery. */
export interface PromptOptions extends TurnOptions {
  /**
   * Makes the submission exactly-once: a prompt with an id the session has
   * seen (queued, placed in the running turn, or in its log) is not placed
   * again; the call waits for the turn that placed it, or returns at once
   * when that turn has ended. A caller that may have to call again (a client
   * whose connection drops, or whose `agent.prompt` ends `Withdrawn`) reuses
   * the id, and `agent.prompt` requires one; without one, the agent gives the
   * prompt an id of its own.
   */
  readonly requestId?: string;
  /** Default `follow-up`. */
  readonly whenBusy?: WhenBusy;
}

/** The turn loop. Its provider serves it to clients too: it adds `serveAgent` to `Channels`. */
export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Appends the user message and runs steps (model, then tools) until the
     * model stops. One turn per session at a time: while one runs, the prompt
     * steers it, follows it, or fails `Busy` (`whenBusy`). Resolves when the
     * turn that placed the prompt has ended; progress arrives through events
     * and the log. A turn cut off by a host restart resumes when the agent
     * starts again.
     */
    readonly prompt: (sessionId: string, content: PromptContent, options?: PromptOptions) => Effect.Effect<void, AgentError>;
    readonly cancel: (sessionId: string) => Effect.Effect<void>;
    readonly busy: (sessionId: string) => Effect.Effect<boolean>;
    /** Sessions with a running turn. */
    readonly running: Effect.Effect<readonly string[]>;
    /** Prompts waiting for a turn, oldest first. */
    readonly queue: (sessionId: string) => Effect.Effect<readonly QueuedPrompt[]>;
    /** Takes a queued prompt out; its `prompt` call fails `Retracted`. False when it was not queued (placed already). */
    readonly withdraw: (sessionId: string, requestId: string) => Effect.Effect<boolean>;
    /** The session as a client joining now should show it (see `AgentView`). */
    readonly view: (sessionId: string) => Effect.Effect<AgentView>;
  }
>()("lemma/Agent") {}

/** What `agent.activity` sends: `subscribed` first, then the agent's live output and each turn's and queue's change, in any session. */
export const AgentActivity = Schema.Union([
  /** First: from here on the stream hears everything. `running` is the sessions with a turn running as of then (`Agent.running`). */
  Schema.Struct({ type: Schema.Literal("subscribed"), running: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("turn-started"), sessionId: Schema.String, turnId: Schema.String }),
  /** `AssistantDelta`: model output, numbered by `seq` within its step. */
  Schema.Struct({
    type: Schema.Literal("delta"),
    sessionId: Schema.String,
    turnId: Schema.String,
    stepId: Schema.String,
    seq: Schema.Number,
    event: StreamEvent,
  }),
  /** `ToolOutput`: a running tool's output, `offset` being how much it had printed before `chunk`. */
  Schema.Struct({ type: Schema.Literal("tool-output"), sessionId: Schema.String, toolCallId: Schema.String, chunk: Schema.String, offset: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("queue-changed"), sessionId: Schema.String, queue: Schema.Array(QueuedPrompt), revision: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("turn-ended"), sessionId: Schema.String, turnId: Schema.String, usage: Usage, reason: TurnEndReason }),
]);
export type AgentActivity = typeof AgentActivity.Type;

const sessionField = { sessionId: Schema.String };

/**
 * How clients reach `Agent`, served by its provider (`serveAgent`). A call
 * that fails with an `AgentError` reaches the client with its `reason` as the
 * code and the session as the subject.
 */
export const AgentChannels = {
  /**
   * `Agent.prompt` for a client: answers when the turn that places the prompt
   * ends. The call can end sooner, when its connection drops or the agent
   * reloads (`Withdrawn`, below), as it does whenever its configuration or a
   * plugin it requires changes; the client then calls again with the same
   * `requestId`, which waits for the turn that placed the prompt, or places it
   * if it never was, and never places it twice. So every call names one, new
   * for each prompt (`PromptOptions.requestId`): a retry without it would
   * place the prompt again.
   *
   * Fails as `Agent.prompt` does: `Busy`, `NoModel`, `Session`, `Hook`, or
   * `Retracted` when `agent.withdraw` took the prompt out of the queue, each
   * with the session as its subject. `Withdrawn` (its subject `agent.prompt`)
   * says instead that the agent stopped or was replaced while the call
   * waited, and the call ends at once; a prompt it took stays taken, its
   * turn resuming in the replacement once the channel answers again. A client
   * that clears its input once the prompt is taken reads that from
   * `agent.activity`, opened first: `turn-started` for the session, or the
   * `requestId` in a `queue-changed`; or its message on the session's
   * `sessions.log`.
   */
  prompt: defineChannel({
    kind: "call",
    id: "agent.prompt",
    title: "Prompt",
    description:
      "Sends a prompt to a session and answers when the turn that places it ends; whenBusy says what it does while a turn runs, and calling again with the same requestId never places it twice",
    payload: Schema.Struct({
      ...sessionField,
      content: PromptContent,
      options: Schema.optional(TurnOptions),
      requestId: Schema.NonEmptyString,
      whenBusy: Schema.optional(WhenBusy),
    }),
    success: Schema.Void,
  }),
  cancel: defineChannel({
    kind: "call",
    id: "agent.cancel",
    title: "Cancel a turn",
    description: "Cancels the session's running turn, if any, and answers once it has ended",
    payload: Schema.Struct(sessionField),
    success: Schema.Void,
  }),
  running: defineChannel({
    kind: "call",
    id: "agent.running",
    title: "Running turns",
    description: "The sessions with a turn running",
    payload: Schema.Void,
    success: Schema.Array(Schema.String),
  }),
  queue: defineChannel({
    kind: "call",
    id: "agent.queue",
    title: "Queued prompts",
    description: "The session's prompts waiting for a turn, oldest first",
    payload: Schema.Struct(sessionField),
    success: Schema.Array(QueuedPrompt),
  }),
  withdraw: defineChannel({
    kind: "call",
    id: "agent.withdraw",
    title: "Withdraw a prompt",
    description: "Takes a queued prompt out, failing its prompt call Retracted; false when it was no longer queued",
    payload: Schema.Struct({ ...sessionField, requestId: Schema.String }),
    success: Schema.Boolean,
  }),
  view: defineChannel({
    kind: "call",
    id: "agent.view",
    title: "View a session",
    description: "What a client joining now shows of the session beyond its log: the running turn's model and tool output so far, and the queue",
    payload: Schema.Struct(sessionField),
    success: AgentView,
  }),
  /**
   * The agent's live output and each turn's and queue's change, as
   * `TurnStarted`, `AssistantDelta`, `ToolOutput`, `QueueChanged`, and
   * `TurnEnded` report them, after `subscribed` (see `eventFeed`). Each kind
   * comes in its own order, not across kinds: `turn-ended` can overtake the
   * turn's last `delta`. Losable: a client that falls behind loses the oldest,
   * and one reopening it after a reconnect has missed what came between; it
   * resyncs from `subscribed`'s `running`, `agent.view`, and the log.
   */
  activity: defineChannel({
    kind: "stream",
    id: "agent.activity",
    title: "Agent activity",
    description: "Turns starting and ending, model and tool output, and queue changes in every session, after a subscribed acknowledgement",
    payload: Schema.Void,
    success: AgentActivity,
  }),
};

/** What each source of a client's `agent.activity` holds: as much as the client does (see `eventFeed`). */
const FEED = { buffer: 1024 };

/** `AgentChannels` served from `agent`: what a provider of `Agent` adds to `Channels`, each with `PluginContext.add`. */
export const serveAgent = (agent: Context.Service.Shape<typeof Agent>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  // The turn is the agent's, not the call's: when the agent leaves, the call stops waiting, and the turn resumes in
  // the replacement, where calling again with the same `requestId` waits for it.
  serveChannel(AgentChannels.prompt, ({ sessionId, content, options, requestId, whenBusy }, { left }) =>
    Effect.raceFirst(agent.prompt(sessionId, content, { ...options, requestId, ...(whenBusy === undefined ? {} : { whenBusy }) }), left),
  ),
  serveChannel(AgentChannels.cancel, ({ sessionId }) => agent.cancel(sessionId)),
  serveChannel(AgentChannels.running, () => agent.running),
  serveChannel(AgentChannels.queue, ({ sessionId }) => agent.queue(sessionId)),
  serveChannel(AgentChannels.withdraw, ({ sessionId, requestId }) => agent.withdraw(sessionId, requestId)),
  serveChannel(AgentChannels.view, ({ sessionId }) => agent.view(sessionId)),
  serveChannel(AgentChannels.activity, () =>
    eventFeed(
      Effect.map(agent.running, (running): AgentActivity => ({ type: "subscribed", running })),
      [
        Stream.map(events.stream(TurnStarted, FEED), ({ sessionId, turnId }): AgentActivity => ({ type: "turn-started", sessionId, turnId })),
        Stream.map(events.stream(AssistantDelta, FEED), ({ sessionId, turnId, stepId, seq, event }): AgentActivity => ({
          type: "delta",
          sessionId,
          turnId,
          stepId,
          seq,
          event,
        })),
        Stream.map(events.stream(ToolOutput, FEED), ({ sessionId, toolCallId, chunk, offset }): AgentActivity => ({
          type: "tool-output",
          sessionId,
          toolCallId,
          chunk,
          offset,
        })),
        Stream.map(events.stream(QueueChanged, FEED), ({ sessionId, queue, revision }): AgentActivity => ({
          type: "queue-changed",
          sessionId,
          queue,
          revision,
        })),
        Stream.map(events.stream(TurnEnded, FEED), ({ sessionId, turnId, usage, reason }): AgentActivity => ({
          type: "turn-ended",
          sessionId,
          turnId,
          usage,
          reason,
        })),
      ],
    ),
  ),
];
