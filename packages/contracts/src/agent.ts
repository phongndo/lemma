import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Hook } from "@lemma/core";
import { AssistantMessage, ImageContent, Message, ModelRef, StreamEvent, TextContent, ThinkingLevel, Usage } from "./llm.ts";
import type { ToolResultMessage } from "./llm.ts";
import type { EventData, SessionEvent } from "./sessions.ts";
import type { ToolContribution } from "./tools.ts";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly sessionId: string;
  /** `Withdrawn`: the prompt was taken out of the queue before a turn placed it. */
  readonly reason: "Busy" | "NoModel" | "Session" | "Hook" | "Withdrawn";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const TurnOptions = Schema.Struct({
  /** Falls back to the agent's configured default, then the first available model. */
  model: Schema.optional(ModelRef),
  thinking: Schema.optional(ThinkingLevel),
});
export type TurnOptions = typeof TurnOptions.Type;

export const PromptContent = Schema.Array(Schema.Union(TextContent, ImageContent));
export type PromptContent = typeof PromptContent.Type;

/**
 * What a prompt does while the session has a turn running: `steer` joins the
 * running turn after its current tool calls; `follow-up` waits and starts the
 * next turn; `reject` fails with `Busy`.
 */
export const WhenBusy = Schema.Literal("steer", "follow-up", "reject");
export type WhenBusy = typeof WhenBusy.Type;

/** A prompt waiting for a turn to place it (see `WhenBusy`). */
export const QueuedPrompt = Schema.Struct({
  /** The caller's `requestId`, or one the agent gave it. */
  requestId: Schema.String,
  content: PromptContent,
  mode: Schema.Literal("steer", "follow-up"),
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
  /** Declared to the model: the request's tool list. */
  readonly tools: readonly ToolContribution[];
  /**
   * Offered without being declared: the model does not see them, but a tool
   * that runs others (codemode's scripts) may call them. A handler moves a
   * tool here from `tools` to keep its definition out of the request (the
   * `mcp` plugin does, for servers reached through codemode). Starts empty.
   */
  readonly reachable: readonly ToolContribution[];
  /** The turn's branch, root to its last event: what the request continues. */
  readonly branch: readonly SessionEvent[];
  /** `deriveMessages(branch)`. */
  readonly history: readonly Message[];
  /**
   * Appends an event after the turn's last one (a `compaction`, say); the
   * request, and the rest of the turn, continue from it. It stays on the
   * turn's branch even if a later handler fails or the turn is cancelled, and
   * a checkout meanwhile cannot move it.
   */
  readonly append: (data: EventData) => Effect.Effect<SessionEvent, AgentError>;
}

export type RequestPlan = Omit<RequestDraft, "history" | "branch" | "append" | "sessionId" | "turnId" | "cwd">;

/** Runs before every model call. Skills, project context, and prompt plugins contribute here. */
export const AgentRequestHook = Hook.make<RequestDraft, RequestPlan, AgentError>("lemma/agent.request");

/**
 * Runs after each step. The default continues while the model asked for tools
 * and stops otherwise; a handler can stop early or push the model to continue.
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
  readonly reason: "done" | "cancelled" | "error" | "max-steps";
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
   * when that turn has ended. A client retrying after a lost connection
   * reuses the id.
   */
  readonly requestId?: string;
  /** Default `follow-up`. */
  readonly whenBusy?: WhenBusy;
}

export class Agent extends Context.Tag("lemma/Agent")<
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
    /** Takes a queued prompt out; its `prompt` call fails `Withdrawn`. False when it was not queued (placed already). */
    readonly withdraw: (sessionId: string, requestId: string) => Effect.Effect<boolean>;
    /** The session as a client joining now should show it (see `AgentView`). */
    readonly view: (sessionId: string) => Effect.Effect<AgentView>;
  }
>() {}
