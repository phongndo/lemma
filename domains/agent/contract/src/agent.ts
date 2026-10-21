import { Context, Data, Effect, Option, Predicate, Schema, Stream } from "effect";
import { Event, Hook, Registry, schemaCheck } from "@lemma/core";
import type { Awaitable, Events } from "@lemma/core";
import { defineChannel, eventFeed, ResultCredit, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { AssistantMessage, ImageContent, Message, ModelRef, StreamEvent, TextContent, ThinkingLevel, Usage } from "@lemma/llm";
import type { ToolResultMessage } from "@lemma/llm";
import { TurnEndReason } from "@lemma/sessions";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { ToolOutput } from "@lemma/tools";
import type { ToolContribution } from "@lemma/tools";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly sessionId: string;
  /**
   * `Retracted`: the prompt never ran: `withdraw` took it out of the queue before a turn placed it, or the turn started
   * with it was cancelled before it placed it. (A steer queued for a turn that is cancelled is not retracted: it stays
   * queued, held for the next prompt.) Sent again with the same `requestId`, it is refused again while it is among the
   * session's latest 64 retracted ids (a cancel's record of it is written as the turn ends, and a failed write loses
   * it).
   *
   * `Io`: the agent could not record the change the call asked for on disk (its journal), so it did not make it in
   * this instance: the queue is as it was. A write that failed may have landed part-way, so the next instance may find
   * the change made: send the prompt again with the same `requestId` to settle its fate.
   */
  readonly reason: "Busy" | "NoModel" | "Session" | "Hook" | "Retracted" | "Io";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const TurnOptions = Schema.Struct({
  /** Falls back to the agent's configured default, then the first available model. */
  model: Schema.optional(ModelRef),
  thinking: Schema.optional(ThinkingLevel),
  /**
   * Choices for plugins, by plugin id, that the turn is taken with (the thread's profile, for `agent.profiles`):
   * logged with the turn (`turn-start`), so a turn resumed after a restart goes on with them and a request rebuilds
   * from the log, and handed to its prompt sections and `AgentRequestHook` (`plugins`). Each plugin checks its own.
   */
  plugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
  /** As `AgentInputHook` left it: what is placed. */
  content: PromptContent,
  mode: Schema.Literals(["steer", "follow-up"]),
  options: Schema.optional(TurnOptions),
  /** Epoch milliseconds it was queued. */
  at: Schema.Number,
  /** `AgentInputHook`'s handlers, logged with the user message it becomes. */
  credit: Schema.optional(ResultCredit),
  /** The plugin that sent it, when no person did (`PromptOptions.source`). */
  source: Schema.optional(Schema.String),
  /** What a transcript shows of a plugin's (`PromptOptions.display`). */
  display: Schema.optional(Schema.String),
});
export type QueuedPrompt = typeof QueuedPrompt.Type;

/**
 * What became of a prompt: `placed` (in a turn, now or queued), or answered by a plugin's `AgentInputHook` handler
 * without reaching the model: `handled` (it did what was asked, and says so) or `refused` (and why). `by` is that
 * plugin.
 */
export const PromptOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("placed") }),
  Schema.Struct({ kind: Schema.Literal("handled"), by: Schema.String, message: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("refused"), by: Schema.String, reason: Schema.String }),
]);
export type PromptOutcome = typeof PromptOutcome.Type;

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

/** The request a prompt section is written for. */
export interface SectionRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly model: ModelRef;
  /** The tools on offer, before `AgentRequestHook` changes them. */
  readonly tools: readonly ToolContribution[];
  /**
   * The turn's branch as the request is built, its last event the turn's latest: a section that reads the log reads it
   * here, not at the session's current leaf, which a checkout during the turn can move elsewhere.
   */
  readonly branch: readonly SessionEvent[];
  /** The turn's choices for plugins, by plugin id (`TurnOptions.plugins`). */
  readonly plugins?: Readonly<Record<string, unknown>>;
}

/**
 * A part of the system prompt, written for each request. Its source is the plugin that added it, and an empty text
 * (`undefined` or "") leaves it out of that request. A section that fails fails the request, as a hook's failure does.
 */
export interface PromptSection {
  /** Unique among the sections: `project-context`, `skills`. */
  readonly id: string;
  /** Its text for this request: a value, a promise of one, or an Effect (`Awaitable`). */
  readonly text: (request: SectionRequest) => Awaitable<string | undefined, unknown>;
}

/**
 * The system prompt's sections, in order: the agent asks each for its text, then runs `AgentRequestHook`, whose
 * handlers change or drop sections. Its phases are `base` (the agent's base prompt), `body` (where a section naming no
 * phase goes, ordered within it by `order`), and `environment` (the agent's, last). A section whose text changes
 * between requests does not rewrite the prompt the model was sent: the agent tells the model its new text in a
 * `prompt-update` event (`@lemma/sessions`), and the next request that declares the prompt afresh carries it.
 *
 * @composition every section is written for each request, in phase order (`base`, `body`, `environment`, then
 * `order`), one per id (another plugin adding an id fails `Conflict`); a section whose text fails fails the request,
 * and an empty one is left out.
 */
export const PromptSections = Registry.make<PromptSection>("lemma/agent.sections", {
  key: (section) => section.id,
  unique: true,
  phases: ["base", "body", "environment"],
  defaultPhase: "body",
  check: (value) =>
    typeof value === "object" && value !== null && typeof (value as PromptSection).id === "string" && typeof (value as PromptSection).text === "function"
      ? undefined
      : "A prompt section is { id: string, text: (request) => string | undefined }",
});

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
  /** The tools on offer: the model is sent the declarations of those `declaredTools` keeps (`@lemma/tools`). */
  readonly tools: readonly ToolContribution[];
  /**
   * What the provider passes on as it is (`LlmRequest.providerOptions`: a temperature, sampling parameters,
   * metadata), set by a handler; logged with the request.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
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
  /** The turn's choices for plugins, by plugin id (`TurnOptions.plugins`): read-only, as the turn was taken with them. */
  readonly plugins?: Readonly<Record<string, unknown>>;
  /**
   * Appends an event after the turn's last one (a `compaction`, say); the
   * request, and the rest of the turn, continue from it. It stays on the
   * turn's branch even if a later handler fails or the turn is cancelled, and
   * a checkout meanwhile cannot move it. A handler written with promises
   * runs the Effect it returns with its plugin's `run`.
   */
  readonly append: (data: EventData) => Effect.Effect<SessionEvent, AgentError>;
}

export type RequestPlan = Omit<RequestDraft, "history" | "branch" | "append" | "sessionId" | "turnId" | "cwd" | "overflow" | "plugins">;

/** A prompt as it was submitted, before the agent places it. */
export interface PromptInput {
  readonly sessionId: string;
  readonly content: PromptContent;
  readonly options: PromptOptions;
}

/**
 * What a handler of `AgentInputHook` makes of a prompt: `place` it (as it came, or rewritten: what the terminal
 * returns for what it is handed, its content and its options but the request id, which stays the caller's), `handle`
 * it itself (nothing reaches the model; `message` tells whoever sent it what it did), or `refuse` it (and why). The
 * prompt is the sender's until then: a handled or refused one is not logged.
 */
export type PromptDecision =
  | { readonly kind: "place"; readonly content: PromptContent; readonly options: PromptOptions }
  | { readonly kind: "handle"; readonly message?: string }
  | { readonly kind: "refuse"; readonly reason: string };

const contentProblem = (content: unknown): string | undefined =>
  Array.isArray(content) && content.every((part) => Predicate.isObject(part) && (part.type === "text" || part.type === "image"))
    ? undefined
    : "content must be an array of text and image parts";

/** What a handler of `AgentInputHook` hands on: the prompt, its content and options. */
const promptInputProblem = (value: unknown): string | undefined =>
  !Predicate.isObject(value)
    ? "expected a prompt"
    : typeof value.sessionId !== "string"
      ? "sessionId must be a string"
      : (contentProblem(value.content) ?? (Predicate.isObject(value.options) ? undefined : "options must be an object"));

/** What a handler of `AgentInputHook` returns: a `PromptDecision`. */
const decisionProblem = (value: unknown): string | undefined => {
  if (!Predicate.isObject(value)) return "expected a decision: { kind: place | handle | refuse }";
  switch (value.kind) {
    case "place":
      return contentProblem(value.content) ?? (Predicate.isObject(value.options) ? undefined : "a placed prompt's options must be an object");
    case "handle":
      return value.message === undefined || typeof value.message === "string" ? undefined : "a handled prompt's message must be a string";
    case "refuse":
      return typeof value.reason === "string" ? undefined : "a refusal needs a reason string";
    default:
      return `unknown decision kind ${JSON.stringify(value.kind)}: expected place, handle, or refuse`;
  }
};

const thinkingProblem = schemaCheck(ThinkingLevel);

/** What a handler of `AgentRequestHook` hands on or returns: the request's model, sections, and tools. */
const planProblem = (value: unknown): string | undefined => {
  if (!Predicate.isObject(value)) return "expected a request plan";
  if (typeof value.model !== "string") return "model must be a string (<provider>/<model>)";
  if (value.thinking !== undefined) {
    const problem = thinkingProblem(value.thinking);
    if (problem !== undefined) return `thinking: ${problem}`;
  }
  if (!Array.isArray(value.sections)) return "sections must be an array";
  const section = value.sections.findIndex(
    (each) => !Predicate.isObject(each) || typeof each.id !== "string" || typeof each.source !== "string" || typeof each.text !== "string",
  );
  if (section !== -1) return `sections[${section}] must be { id, source, text }, all strings`;
  if (!Array.isArray(value.tools)) return "tools must be an array";
  const tool = value.tools.findIndex(
    (each) => !Predicate.isObject(each) || !Predicate.isObject(each.spec) || typeof each.spec.name !== "string" || typeof each.source !== "string",
  );
  if (tool !== -1) return `tools[${tool}] must be a tool contribution: { spec: { name, … }, source }`;
  if (value.providerOptions !== undefined && !Predicate.isObject(value.providerOptions)) return "providerOptions must be an object";
  return undefined;
};

/**
 * Around every new prompt, before the agent places it: rewrite it (`next` with other content or options, such as its
 * model), handle it, or refuse it. A retry of a prompt with the same request id does not run it again: one placed
 * already is known by where it was placed, and one handled or refused answers as it did (while the agent runs; after a
 * restart it is asked again), as does one still being decided. Who rewrote a prompt is logged with the user message
 * (its `credit`); who handled or refused one, in the prompt's outcome (`PromptOutcome`): the outermost handler whose
 * answer differs from the one it was handed.
 *
 * @composition a chain, outermost first: each handler places, rewrites (by calling `next` with other content),
 * handles, or refuses the prompt; one that returns without `next` answers for all after it. A handler that fails
 * fails `Agent.prompt` with `Hook`, and nothing is placed. Checked: what a handler hands on is a prompt, what it
 * returns a `PromptDecision`.
 */
export const AgentInputHook = Hook.make<PromptInput, PromptDecision, AgentError>("lemma/agent.input", {
  check: { input: promptInputProblem, output: decisionProblem },
  summary: {
    input: (input) => ({ parts: input.content.length, whenBusy: input.options.whenBusy ?? "follow-up" }),
    output: (decision) => ({ decision: decision.kind }),
  },
});

/**
 * Runs before every model call. Skills, project context, and prompt plugins contribute here. Its phases are `shape`
 * (where a handler naming no phase goes: it adds and changes sections and tools), `select` (after every `shape` handler:
 * it chooses among what they offered, as a thread's profile keeps the tools and sections it allows), and `fit` (after
 * both, so it sees the request as it will be: compaction sizes it against the model's window).
 *
 * @composition a chain in phase order (`shape`, `select`, then `fit`): each handler changes the draft it hands `next` and sees
 * what later handlers made in what `next` returns; one that returns without `next` sends what it returns. A handler
 * that fails ends the turn in error, logged with its message, and the prompt that started it fails with `Hook`.
 * Checked: what a handler hands on and returns has a model, sections, and tools of the right shape.
 */
export const AgentRequestHook = Hook.make<RequestDraft, RequestPlan, AgentError>("lemma/agent.request", {
  check: { input: planProblem, output: planProblem },
  phases: ["shape", "select", "fit"],
  defaultPhase: "shape",
  summary: {
    input: (draft) => ({ model: draft.model, sections: draft.sections.length, tools: draft.tools.length }),
    output: (plan) => ({ model: plan.model, sections: plan.sections.length, tools: plan.tools.length }),
  },
});

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
/**
 * Whether a turn takes another step after `StepOutcome`.
 *
 * @composition a chain: the terminal is the default decision, and each handler may keep or change what `next`
 * returns, the outermost having the last word. A handler that fails ends the turn in error. Checked: it returns
 * `continue` or `stop`.
 */
export const AgentContinueHook = Hook.make<StepOutcome, "continue" | "stop", AgentError>("lemma/agent.continue", {
  check: { output: (value) => (value === "continue" || value === "stop" ? undefined : `expected "continue" or "stop", got ${JSON.stringify(value)}`) },
  summary: { input: (outcome) => ({ step: outcome.step, results: outcome.results.length }), output: (decision) => ({ decision }) },
});

/** A turn began: with the prompts `requestIds` names (none, for one resumed after a restart). */
export const TurnStarted = Event.make<{ readonly sessionId: string; readonly turnId: string; readonly requestIds: readonly string[] }>(
  "lemma/agent.turn.started",
);
export const TurnEnded = Event.make<{
  readonly sessionId: string;
  readonly turnId: string;
  readonly usage: Usage;
  readonly reason: TurnEndReason;
}>("lemma/agent.turn.ended");
/**
 * The session's queue changed. `revision` grows with every change (across
 * restarts too), so a client
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
   * whose connection drops, or the host making `agent.prompt` again when the
   * agent reloads) reuses the id, and `agent.prompt` requires one; without
   * one, the agent gives the prompt an id of its own.
   */
  readonly requestId?: string;
  /** Default `follow-up`. */
  readonly whenBusy?: WhenBusy;
  /**
   * The plugin sending it, when it is not a person's prompt (a background command's exit, `ModelNotice`): logged as
   * that plugin's `context` event (`@lemma/sessions`), not a user message, so a client shows it as the plugin's, not as
   * something the user typed. With no turn running, it starts one only after a turn that ran to its end (`done`,
   * `max-steps`) with nothing queued: after one the user cancelled, or that failed, it waits, held, and goes with the
   * user's next prompt. Sent again while it waits, it does not start the queue as a person's retry does.
   */
  readonly source?: string;
  /** With `source`: what a transcript shows of it, in place of its content (the `context` event's `display`). */
  readonly display?: string;
}

/**
 * Something for the model that no prompt carries: work it started ended on its own (a background command exited). The
 * agent places it in the session as a `context` event from `source` (`PromptOptions.source`), steering the running
 * turn or starting one after a turn that ran to its end, on that turn's model and thinking; `id` makes it once
 * (published again with the same id, it is not placed twice). A tool that leaves work running publishes it rather
 * than call `Agent`, so it need not require the agent and restart with it. Lost when no agent hears it, as while one
 * reloads. Unlike appending a `context` event itself, it reaches the model now: a turn ends, or never starts, without it.
 */
export const ModelNotice = Event.make<{
  readonly sessionId: string;
  /** Unique for the notice within `source`: a background command's job id. */
  readonly id: string;
  /** The plugin publishing it. */
  readonly source: string;
  /** What the model reads, as a `context` event's content: at least one part, and no blank text. */
  readonly content: PromptContent;
  /** What a transcript shows of it, in place of its content. */
  readonly display?: string;
}>("lemma/agent.notice");

/** The turn loop. Its provider serves it to clients too: it adds `serveAgent` to `Channels`. */
export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Runs the prompt through `AgentInputHook`, then appends the user message
     * and runs steps (model, then tools) until the model stops. One turn per
     * session at a time: while one runs, the prompt steers it, follows it, or
     * fails `Busy` (`whenBusy`). Resolves `placed` when the turn that placed
     * the prompt has ended, progress arriving through events and the log; or
     * at once, `handled` or `refused`, when a plugin answered it instead, with
     * no turn and nothing logged. A turn cut off by a host restart resumes
     * when the agent starts again.
     */
    readonly prompt: (sessionId: string, content: PromptContent, options?: PromptOptions) => Effect.Effect<PromptOutcome, AgentError>;
    /**
     * Cancels the session's turn, if it has one. A running turn stops and
     * closes as cancelled, and this answers once it has ended. A turn a restart
     * cut off that has not resumed yet is recorded as cancelled and closes as
     * cancelled, asking the model nothing, when it resumes: this answers once
     * it has, or, if it cannot resume yet, once the cancellation is recorded.
     */
    readonly cancel: (sessionId: string) => Effect.Effect<void>;
    readonly busy: (sessionId: string) => Effect.Effect<boolean>;
    /** Sessions with a running turn. */
    readonly running: Effect.Effect<readonly string[]>;
    /**
     * Prompts waiting for a turn, oldest first. Fails `Session` when the
     * agent cannot tell them: when it does not know which of them a turn
     * placed before a restart, and the session's log, which says, cannot be
     * read.
     */
    readonly queue: (sessionId: string) => Effect.Effect<readonly QueuedPrompt[], AgentError>;
    /**
     * Takes a queued prompt out; its `prompt` call fails `Retracted`. False
     * when it was not queued (placed already). Fails as `queue` does, rather
     * than take out a prompt that may have been placed; and `Io` (see
     * `AgentError`).
     */
    readonly withdraw: (sessionId: string, requestId: string) => Effect.Effect<boolean, AgentError>;
    /**
     * Makes a queued follow-up a steer, in its place in the queue: the running
     * turn places it after its current step, as if it had been sent to steer.
     * False when it was not a queued follow-up (placed already, withdrawn, or a
     * steer), or no turn runs to place it (the queue held after a failed or
     * cancelled turn, or the turn suspended). Fails as `queue` does, and `Io`
     * (see `AgentError`).
     */
    readonly promote: (sessionId: string, requestId: string) => Effect.Effect<boolean, AgentError>;
    /** The session as a client joining now should show it (see `AgentView`). Fails as `queue` does. */
    readonly view: (sessionId: string) => Effect.Effect<AgentView, AgentError>;
  }
>()("lemma/Agent") {}

/** `AssistantDelta`: model output, numbered by `seq` within its step. */
const DeltaElement = Schema.Struct({
  type: Schema.Literal("delta"),
  sessionId: Schema.String,
  turnId: Schema.String,
  stepId: Schema.String,
  seq: Schema.Number,
  event: StreamEvent,
});
/** `ToolOutput`: a running tool's output, `offset` being how much it had printed before `chunk`. */
const ToolOutputElement = Schema.Struct({
  type: Schema.Literal("tool-output"),
  sessionId: Schema.String,
  toolCallId: Schema.String,
  chunk: Schema.String,
  offset: Schema.Number,
});

/**
 * What `agent.activity` sends: `subscribed` first, then each turn's and queue's change in any session, and the agent's
 * live output (`delta`, `tool-output`) unless it was opened without it.
 */
export const AgentActivity = Schema.Union([
  /** First: from here on the stream hears everything. `running` is the sessions with a turn running as of then (`Agent.running`). */
  Schema.Struct({ type: Schema.Literal("subscribed"), running: Schema.Array(Schema.String) }),
  /** `TurnStarted`: `requestIds` are the prompts it started with, so a client tells its own prompt's turn from another's. */
  Schema.Struct({ type: Schema.Literal("turn-started"), sessionId: Schema.String, turnId: Schema.String, requestIds: Schema.Array(Schema.String) }),
  DeltaElement,
  ToolOutputElement,
  Schema.Struct({ type: Schema.Literal("queue-changed"), sessionId: Schema.String, queue: Schema.Array(QueuedPrompt), revision: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("turn-ended"), sessionId: Schema.String, turnId: Schema.String, usage: Usage, reason: TurnEndReason }),
]);
export type AgentActivity = typeof AgentActivity.Type;

/** What `agent.output` sends of one session: `subscribed` first, then the agent's live output in it. */
export const AgentOutput = Schema.Union([
  /**
   * First: from here on the stream hears the session's output. `view` is what the agent had of the session beyond its
   * log as of then (`Agent.view`), absent when it could not tell (`Agent.view` failed): what follows goes on from it.
   */
  Schema.Struct({ type: Schema.Literal("subscribed"), view: Schema.optional(AgentView) }),
  DeltaElement,
  ToolOutputElement,
]);
export type AgentOutput = typeof AgentOutput.Type;

const sessionField = { sessionId: Schema.String };

/**
 * How clients reach `Agent`, served by its provider (`serveAgent`). A call
 * that fails with an `AgentError` reaches the client with its `reason` as the
 * code and the session as the subject.
 */
export const AgentChannels = {
  /**
   * `Agent.prompt` for a client: answers when the turn that places the prompt
   * ends. Calling again with the same `requestId` waits for the turn that
   * placed the prompt, or places it if it never was (unless it was retracted:
   * see `AgentError`), and never places it twice. So the call is
   * `repeatable`: when the agent reloads while it waits,
   * as it does whenever its configuration or a plugin it requires changes, the
   * host makes it again on the replacement, where a prompt it took stays
   * taken, its turn resuming. A client whose connection drops calls again with
   * the same id. So every call names one, new for each prompt
   * (`PromptOptions.requestId`): a retry without it would place the prompt
   * again.
   *
   * Fails as `Agent.prompt` does: `Busy`, `NoModel`, `Session`, `Hook`,
   * `Io` or `Retracted` (see `AgentError`), each
   * with the session as its subject; `Withdrawn` (its subject `agent.prompt`)
   * only when no agent answers once the change that stopped it has finished,
   * as when the agent is turned off. A client that clears
   * its input once the prompt is taken reads that from `agent.activity`,
   * opened first: the `requestId` in a `turn-started` or a `queue-changed`; or
   * its message on the session's `sessions.log`. A prompt a plugin handled or
   * refused (`AgentInputHook`) is answered at once, with no turn and nothing
   * logged; a retry of it answers the same while the agent runs.
   */
  prompt: defineChannel({
    kind: "call",
    id: "agent.prompt",
    access: "operate",
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
    success: PromptOutcome,
    repeatable: true,
  }),
  /** `Agent.cancel`. */
  cancel: defineChannel({
    kind: "call",
    id: "agent.cancel",
    access: "operate",
    title: "Cancel a turn",
    description:
      "Cancels the session's turn, if any, and answers once it has ended; for a turn a restart cut off that cannot resume yet, once the cancellation is recorded",
    payload: Schema.Struct(sessionField),
    success: Schema.Void,
  }),
  running: defineChannel({
    kind: "call",
    id: "agent.running",
    access: "read",
    title: "Running turns",
    description: "The sessions with a turn running",
    payload: Schema.Void,
    success: Schema.Array(Schema.String),
    repeatable: true,
  }),
  queue: defineChannel({
    kind: "call",
    id: "agent.queue",
    access: "read",
    title: "Queued prompts",
    description: "The session's prompts waiting for a turn, oldest first",
    payload: Schema.Struct(sessionField),
    success: Schema.Array(QueuedPrompt),
    repeatable: true,
  }),
  withdraw: defineChannel({
    kind: "call",
    id: "agent.withdraw",
    access: "operate",
    title: "Withdraw a prompt",
    description: "Takes a queued prompt out, failing its prompt call Retracted; false when it was no longer queued",
    payload: Schema.Struct({ ...sessionField, requestId: Schema.String }),
    success: Schema.Boolean,
  }),
  promote: defineChannel({
    kind: "call",
    id: "agent.promote",
    access: "operate",
    title: "Steer with a queued prompt",
    description:
      "Makes a queued follow-up a steer, which the running turn places after its current step; false when it was no queued follow-up, or no turn runs",
    payload: Schema.Struct({ ...sessionField, requestId: Schema.String }),
    success: Schema.Boolean,
  }),
  view: defineChannel({
    kind: "call",
    id: "agent.view",
    access: "read",
    title: "View a session",
    description: "What a client joining now shows of the session beyond its log: the running turn's model and tool output so far, and the queue",
    payload: Schema.Struct(sessionField),
    success: AgentView,
    repeatable: true,
  }),
  /**
   * The agent's live output and each turn's and queue's change, as
   * `TurnStarted`, `AssistantDelta`, `ToolOutput`, `QueueChanged`, and
   * `TurnEnded` report them, after `subscribed` (see `eventFeed`). Each kind
   * comes in its own order, not across kinds: `turn-ended` can overtake the
   * turn's last `delta`. Losable: a client that falls behind loses the oldest,
   * and one reopening it after a reconnect has missed what came between; it
   * resyncs from `subscribed`'s `running`, `agent.view`, and the log.
   *
   * Opened with `{ output: false }`, it leaves the live output out (`delta`,
   * `tool-output`): a client that shows some sessions hears every session's
   * turns and queue here, and reads the output of those it shows from
   * `agent.output`, one stream each, rather than every session's. With no
   * payload, as before there was one, it sends it all.
   */
  activity: defineChannel({
    kind: "stream",
    id: "agent.activity",
    access: "read",
    title: "Agent activity",
    description:
      "Turns starting and ending, model and tool output, and queue changes in every session, after a subscribed acknowledgement; output: false leaves the model and tool output out",
    payload: Schema.UndefinedOr(Schema.Struct({ output: Schema.optional(Schema.Boolean) })),
    success: AgentActivity,
  }),
  /**
   * One session's live output, as `AssistantDelta` and `ToolOutput` report
   * it, after `subscribed`, which carries what the agent had of the session
   * as it opened (`agent.view`'s): a client showing the session draws the
   * running turn from it and goes on with what follows, which may repeat
   * what the view holds (a delta's `seq`, a chunk's `offset` say). So a
   * thread opened or reconnected midway shows the turn so far, with no call
   * of its own. Losable, as `agent.activity` is: a client that falls behind
   * loses the oldest, and one that reopens it resyncs from its `subscribed`
   * and the log.
   */
  output: defineChannel({
    kind: "stream",
    id: "agent.output",
    access: "read",
    title: "A session's agent output",
    description:
      "The session's model and tool output as it streams, after a subscribed acknowledgement carrying what the agent had of the session then (agent.view's)",
    payload: Schema.Struct(sessionField),
    success: AgentOutput,
  }),
};

/** What each source of a client's `agent.activity` or `agent.output` holds: as much as the client does (see `eventFeed`). */
const FEED = { buffer: 1024 };

/** `AgentChannels` served from `agent`: what a provider of `Agent` adds to `Channels`, each with `PluginContext.add`. */
export const serveAgent = (agent: Context.Service.Shape<typeof Agent>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  // The turn is the agent's, not the call's: when the agent leaves, the call stops waiting, and the turn resumes in
  // the replacement, where the host makes the call again (it is `repeatable`) and the same `requestId` waits for it.
  serveChannel(AgentChannels.prompt, ({ sessionId, content, options, requestId, whenBusy }, { left }) =>
    Effect.raceFirst(agent.prompt(sessionId, content, { ...options, requestId, ...(whenBusy === undefined ? {} : { whenBusy }) }), left),
  ),
  serveChannel(AgentChannels.cancel, ({ sessionId }) => agent.cancel(sessionId)),
  serveChannel(AgentChannels.running, () => agent.running),
  serveChannel(AgentChannels.queue, ({ sessionId }) => agent.queue(sessionId)),
  serveChannel(AgentChannels.withdraw, ({ sessionId, requestId }) => agent.withdraw(sessionId, requestId)),
  serveChannel(AgentChannels.promote, ({ sessionId, requestId }) => agent.promote(sessionId, requestId)),
  serveChannel(AgentChannels.view, ({ sessionId }) => agent.view(sessionId)),
  serveChannel(AgentChannels.activity, (payload) =>
    eventFeed(
      Effect.map(agent.running, (running): AgentActivity => ({ type: "subscribed", running })),
      [
        Stream.map(events.stream(TurnStarted, FEED), ({ sessionId, turnId, requestIds }): AgentActivity => ({
          type: "turn-started",
          sessionId,
          turnId,
          requestIds,
        })),
        ...(payload?.output === false ? [] : liveOutput(events)),
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
  serveChannel(AgentChannels.output, ({ sessionId }) =>
    eventFeed(
      Effect.map(Effect.option(agent.view(sessionId)), (view): AgentOutput => ({
        type: "subscribed",
        ...(Option.isSome(view) ? { view: view.value } : {}),
      })),
      liveOutput(events, sessionId),
    ),
  ),
];

/** `AssistantDelta` and `ToolOutput` as `agent.activity` and `agent.output` send them: every session's, or `only`'s. */
const liveOutput = (
  events: Context.Service.Shape<typeof Events>,
  only?: string,
): readonly Stream.Stream<typeof DeltaElement.Type | typeof ToolOutputElement.Type>[] => {
  const mine = ({ sessionId }: { readonly sessionId: string }) => only === undefined || sessionId === only;
  return [
    events.stream(AssistantDelta, FEED).pipe(
      Stream.filter(mine),
      Stream.map(({ sessionId, turnId, stepId, seq, event }) => ({ type: "delta" as const, sessionId, turnId, stepId, seq, event })),
    ),
    events.stream(ToolOutput, FEED).pipe(
      Stream.filter(mine),
      Stream.map(({ sessionId, toolCallId, chunk, offset }) => ({ type: "tool-output" as const, sessionId, toolCallId, chunk, offset })),
    ),
  ];
};
