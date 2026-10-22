import { Context, Data, Effect, Predicate, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Event, Hook, schemaCheck } from "@lemma/core";
import type { Events } from "@lemma/core";
import { defineRoute } from "@lemma/router";
import { defineChannel, eventFeed, HandlerCredit, mapChunks, optionalPayload, ResultCredit, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { AssistantMessage, IMAGE_TYPES, ImageContent, LlmFailure, MAX_IMAGE_BYTES, Message, TextContent, ThinkingLevel, ToolSpec, Usage } from "@lemma/llm";
import { SessionSearchMatch } from "./search.ts";
import { cacheReport, trajectory } from "./trajectory.ts";
import { recordsOf, RequestView, requestOf, SessionCache, SessionRecords } from "./views.ts";

/**
 * A session is an append-only log of events. Each event names its parent, so
 * the log is a tree: branching appends a child of an older event, and the file
 * is never rewritten. The branch from the root to the current leaf is what the
 * model sees.
 *
 * The log is the only source of truth. **Model-visible means logged**: the
 * request behind any `request` event can be rebuilt from the branch before it
 * (see `rebuildRequest`). Plugins that change what the model sees append
 * events; they never alter a request in flight. Live notifications are losable
 * conveniences; `seq` gaps tell a reader to re-read the log.
 */

export const Timing = Schema.Struct({
  /** Epoch milliseconds. */
  startedAt: Schema.Number,
  /** First streamed token, for time-to-first-token and throughput. */
  firstTokenAt: Schema.optional(Schema.Number),
  endedAt: Schema.Number,
});
export type Timing = typeof Timing.Type;

/** How a provider answered a model call, before its body: its HTTP status, and its request id when it named one. */
export const ProviderAnswer = Schema.Struct({ status: Schema.Number, requestId: Schema.optional(Schema.String) });
export type ProviderAnswer = typeof ProviderAnswer.Type;

/** Who put a piece of the request there. `source` is a plugin id. */
export const Contribution = Schema.Struct({
  source: Schema.String,
  kind: Schema.Literals(["system", "tool"]),
  /** Section id or tool name. */
  label: Schema.String,
  chars: Schema.Number,
});
export type Contribution = typeof Contribution.Type;

/** Why a turn ended: it finished, was cancelled, failed, or ran out of steps. */
export const TurnEndReason = Schema.Literals(["done", "cancelled", "error", "max-steps"]);
export type TurnEndReason = typeof TurnEndReason.Type;

/**
 * What a `context` event, or a `context-edit` replacing an event's content, puts before the model: at least one part,
 * no blank text, and images of a type and size every provider takes. A provider refuses a message with any of these,
 * and the log cannot be edited, so one logged would fail every later request of its session.
 */
const ShownContent = Schema.Array(Schema.Union([TextContent, ImageContent])).check(
  Schema.isMinLength(1),
  Schema.makeFilter((parts) => {
    for (const part of parts) {
      if (part.type === "text" && part.text.trim() === "") return "a text part is blank";
      if (part.type === "image" && !IMAGE_TYPES.has(part.mimeType)) return `an image is ${part.mimeType}, which not every provider takes`;
      // Base64: four characters for every three bytes.
      if (part.type === "image" && part.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return "an image is larger than providers take";
    }
    return undefined;
  }),
);

/**
 * Why a request declares its system prompt and tools afresh rather than continuing the previous request's (see the
 * `request` event): the branch had none (`start`), a compaction replaced the start of the history (`compaction`), a
 * `context-edit` changed what the model sees of earlier events (`edit`), it asks another model (`model`), or it
 * declares a tool the previous one did not, or one that changed (`tools`).
 */
export const RequestRestart = Schema.Literals(["start", "compaction", "edit", "model", "tools"]);
export type RequestRestart = typeof RequestRestart.Type;

/** A system prompt section's new text, told to the model in a `prompt-update` event: "" when the section is gone. */
export const SectionUpdate = Schema.Struct({ id: Schema.String, source: Schema.String, text: Schema.String });
export type SectionUpdate = typeof SectionUpdate.Type;

export const EventData = Schema.Union([
  /** `model` and `thinking` are what the turn was started with, so a turn resumed after a restart runs on with them. */
  Schema.Struct({
    type: Schema.Literal("turn-start"),
    turnId: Schema.String,
    model: Schema.optional(Schema.String),
    thinking: Schema.optional(ThinkingLevel),
    /** The turn's choices for plugins, by plugin id (the agent's `TurnOptions.plugins`). */
    plugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.Struct({
    type: Schema.Literal("turn-end"),
    turnId: Schema.String,
    reason: TurnEndReason,
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("step-start"), turnId: Schema.String, stepId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("step-end"),
    turnId: Schema.String,
    stepId: Schema.String,
    /**
     * Whether the turn takes another step after it, and why: the default's reason (`the model asked for tools`), and
     * `AgentContinueHook`'s handlers, each one's own time and whether it changed the decision. Absent on a step that
     * did not finish (a retry, a cancel).
     */
    decision: Schema.optional(
      Schema.Struct({
        result: Schema.Literals(["continue", "stop"]),
        why: Schema.String,
        handlers: Schema.optional(Schema.Array(HandlerCredit)),
      }),
    ),
  }),
  /**
   * The request header, logged before the model call. `system`, `tools`,
   * `nested`, and `contributions` are omitted when unchanged since the previous
   * `request` on the branch (the nearest among its ancestors, never a sibling
   * branch's), and `requestState` resolves them. `system` is the text of the `system`
   * contributions, in order, with empty ones dropped, joined by a blank line
   * (`"\n\n"`); `chars` is each text's length, so `trajectory` can split it
   * back into sections.
   *
   * A request without `restart` continues the previous one on the branch: the
   * same system prompt and tools, and its history with more appended, so a
   * provider's cache of that prefix serves it. What changed in the prompt's
   * sections since is told in `prompt-update` events instead. One with `restart`
   * declares them afresh, as its sections and tools now are.
   */
  Schema.Struct({
    type: Schema.Literal("request"),
    turnId: Schema.String,
    stepId: Schema.String,
    model: Schema.String,
    thinking: Schema.optional(ThinkingLevel),
    /** `CompositionInfo.id` of the plugin set that built this request. */
    composition: Schema.String,
    system: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Array(ToolSpec)),
    /**
     * The `nested` tools the request offered beside `tools` without declaring them to the model, by name: with
     * `tools`, what its calls may reach (`ToolInvocation.offered`), so a call resumed after a restart is held to it.
     */
    nested: Schema.optional(Schema.Array(Schema.String)),
    /** It declares its system prompt and tools afresh, and why (see above); absent on a request an older agent logged. */
    restart: Schema.optional(RequestRestart),
    /**
     * Who put each section and tool there: logged when they differ from the previous request's on the branch, so always
     * on a branch's first (older logs have them on every request). A request's own, logged or not, are the
     * `contributions` of `requestState` of the branch ending at it.
     */
    contributions: Schema.optional(Schema.Array(Contribution)),
    /** `AgentRequestHook`'s handlers, in the order they ran: each one's own time, and what it changed. */
    handlers: Schema.optional(Schema.Array(HandlerCredit)),
    /** What the provider was told to pass on (`LlmRequest.providerOptions`), as a handler set them. */
    providerOptions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  /** Model-visible history. Assistant messages carry stream timing; tool results carry execution timing and UI details. */
  Schema.Struct({
    type: Schema.Literal("message"),
    message: Message,
    turnId: Schema.optional(Schema.String),
    stepId: Schema.optional(Schema.String),
    timing: Schema.optional(Timing),
    details: Schema.optional(Schema.Unknown),
    /** On a user message: the submission's id (see `Agent.prompt`), so a retried submission is not placed twice. */
    requestId: Schema.optional(Schema.String),
    /**
     * Who shaped it: on a tool result, `ToolExecuteHook`'s handlers, the guards, and the registry's cut; on a user
     * message, `AgentInputHook`'s handlers; on an answer, `LlmProviderHeadersHook`'s (the headers each changed).
     */
    credit: Schema.optional(ResultCredit),
    /** On an answer: the provider's HTTP status, and its request id when it named one. */
    response: Schema.optional(ProviderAnswer),
  }),
  /** A failed, cancelled, or retried model call. Kept for inspection; never model-visible. */
  Schema.Struct({
    type: Schema.Literal("attempt"),
    turnId: Schema.String,
    stepId: Schema.String,
    message: AssistantMessage,
    timing: Timing,
    /** How the call failed (`Llm.stream`'s classification), when it failed rather than being cut off or cancelled. */
    failure: Schema.optional(LlmFailure),
    /**
     * The turn asks again in a new step, from `at` (epoch ms): after a `failure`, the `attempt`th failed call in a row
     * since the model last answered; or because a host `restart` cut the call off (`attempt` is then 1: a restart
     * counts no failure).
     */
    retry: Schema.optional(Schema.Struct({ reason: Schema.Literals(["failure", "restart"]), attempt: Schema.Number, at: Schema.Number })),
    /** The provider's answer, when it gave one before the call failed, and who shaped the headers sent. */
    response: Schema.optional(ProviderAnswer),
    credit: Schema.optional(ResultCredit),
  }),
  /** Replaces the history before `firstKeptId` with `summary` in the model's view; the originals stay in the log. */
  Schema.Struct({
    type: Schema.Literal("compaction"),
    summary: Schema.String,
    firstKeptId: Schema.String,
    tokensBefore: Schema.Number,
    source: Schema.String,
    /** The turn it happened in, whose usage includes writing the summary. */
    turnId: Schema.optional(Schema.String),
    /** What writing the summary cost. */
    usage: Schema.optional(Usage),
    /**
     * The files the history it replaces read and changed (the previous compaction's lists, with the history after it),
     * shown with the summary, so the model knows what to read again rather than trust a summary of it.
     */
    files: Schema.optional(Schema.Struct({ read: Schema.Array(Schema.String), modified: Schema.Array(Schema.String) })),
  }),
  /**
   * What changed in the system prompt since the request that declared it (`restart`), told to the model as a message
   * where this event stands (`promptUpdateText`) rather than by rewriting the prompt. Model-visible until a later
   * request declares the prompt afresh, which says it all again; unlike a `context` event, which stays.
   */
  Schema.Struct({
    type: Schema.Literal("prompt-update"),
    turnId: Schema.optional(Schema.String),
    /** Sections whose text differs from what the model was last told, each with its new text and the plugin that wrote it. */
    sections: Schema.Array(SectionUpdate),
    /** When it changed: every declared tool a call to which is refused now, as the request no longer offers it ([] once each is offered again). */
    unavailable: Schema.optional(Schema.Array(Schema.String)),
  }),
  /**
   * Something a plugin tells the model where it was appended (an email that arrived, a document attached, a reading),
   * which the model reads as a user message with `content`, word for word. `source` is the plugin; `display` is what a
   * transcript shows of it, in place of its content. Logged like any event, so a request with it still rebuilds from
   * the log. One placed among a response's tool results is seen after them, so the calls keep their results next to
   * them. During a turn, append it through `AgentRequestHook`'s `append` (with the turn's id), as the turn's later
   * events follow its own last one; between turns, with `Sessions.append`.
   */
  Schema.Struct({
    type: Schema.Literal("context"),
    source: Schema.String,
    content: ShownContent,
    display: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
    stepId: Schema.optional(Schema.String),
    /** One the agent placed for a plugin (`ModelNotice`): its submission's id, as a prompt's, so it is placed once. */
    requestId: Schema.optional(Schema.String),
  }),
  /**
   * Changes what the model sees of an earlier event on the branch, which stays in the log as it was: `omit` leaves it
   * out (a response with its tool results, so calls keep their results), `replace` puts `content` in its place (a
   * prompt, a tool result, or a `context` event; never a response, whose calls its results answer). Of an event's
   * edits, the latest that applies wins. One that cannot apply (its target not on the branch, or already summarized
   * away by a compaction, or omitting a lone tool result, or replacing a response) changes nothing, and leaves an
   * earlier one in force. Append it as `context` says.
   */
  Schema.Struct({
    type: Schema.Literal("context-edit"),
    target: Schema.String,
    op: Schema.Literals(["omit", "replace"]),
    content: Schema.optional(ShownContent),
    source: Schema.String,
    turnId: Schema.optional(Schema.String),
  }),
  /**
   * The session's title, the latest in the file. `provisional`, present only when true: one a turn made from its first
   * prompt, as the session had none, which a better one may replace (`agent.titles` does) while it is still the title;
   * a title someone chose never is.
   */
  Schema.Struct({ type: Schema.Literal("title"), title: Schema.String, provisional: Schema.optional(Schema.Literal(true)) }),
  /** Plugin-owned data; `kind` is namespaced by the plugin id. Not model-visible. */
  Schema.Struct({ type: Schema.Literal("custom"), kind: Schema.String, data: Schema.Unknown }),
]);
export type EventData = typeof EventData.Type;

export const SessionEvent = Schema.Struct({
  /** 1-based position in the file; strictly increasing per session. */
  seq: Schema.Number,
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  /** Epoch milliseconds. */
  at: Schema.Number,
  data: EventData,
});
export type SessionEvent = typeof SessionEvent.Type;

/**
 * The session that started this one, as an agent of its own (`tools.delegate`): its id, and the tool call that started
 * it. Fixed when the session is made (`Sessions.create`, `Sessions.fork`), so what lists sessions (the sidebar) groups an
 * agent under the thread it works for without reading either log.
 */
export const SessionParent = Schema.Struct({
  sessionId: Schema.String,
  /** The parent's call that started it; a call a script made is `<call>/<n>`. */
  toolCallId: Schema.optional(Schema.String),
});
export type SessionParent = typeof SessionParent.Type;

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  /** Present on an agent's session: the session that started it (see `SessionParent`). */
  parent: Schema.optional(SessionParent),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  title: Schema.optional(Schema.String),
  /** Event the next append follows. Absent in an empty session. */
  leaf: Schema.optional(Schema.String),
  /** `seq` of the last event in the file (0 when empty). */
  lastSeq: Schema.Number,
  /** Set by `mark`; present only when true. How clients file the session, not part of its history. */
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  /** Set by `mark`, present only when true: kept though nothing has gone into it (see `SessionMarks.kept`). */
  kept: Schema.optional(Schema.Boolean),
  /**
   * Its log is damaged from line `line` on (`reason`): it reads up to the event before (`lastSeq` counts what reads),
   * and takes no writes (`ReadOnly`). `fork` copies it, from any event that reads, into a session that does.
   */
  damaged: Schema.optional(Schema.Struct({ line: Schema.Number, reason: Schema.String })),
});
export type SessionInfo = typeof SessionInfo.Type;

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly sessionId?: string;
  /**
   * `Busy`: `remove` or `relocate` refused, as the session is held (`Sessions.hold`) or a `SessionRemoveHook` handler
   * refused it. `NotEmpty`: `relocate` refused, as something has gone into the session. `ReadOnly`: a write refused, as
   * the session's log is damaged (`SessionInfo.damaged`): `fork` it to go on.
   */
  readonly reason: "NotFound" | "Corrupt" | "Io" | "InvalidParent" | "Busy" | "NotEmpty" | "ReadOnly";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * An event appended, published by a provider of `Sessions` after each append,
 * in `seq` order within a session, and followed by `SessionChanged`.
 * `sessions.log` follows a session from it.
 */
export const SessionAppended = Event.make<{ readonly sessionId: string; readonly event: SessionEvent }>("lemma/session.appended");
/** A session created, or its info changed: by an append (its `lastSeq`, `updatedAt` and `leaf`, and `title` for a title event), a checkout (its `leaf`), or its marks. */
export const SessionChanged = Event.make<{ readonly info: SessionInfo }>("lemma/session.changed");
export const SessionRemoved = Event.make<{ readonly sessionId: string }>("lemma/session.removed");

/**
 * Around every `Sessions.remove` of a session nothing holds, whoever calls
 * it; the terminal deletes the session, unless a hold was taken meanwhile, when
 * it fails `Busy`. A handler refuses by failing instead of calling `next`, and
 * cleans up after the session only once `next` has succeeded. A provider of
 * `Sessions` runs each removal through it, so a handler's rule holds for every
 * client and every plugin. Work that writes to the session holds it instead
 * (see `Sessions.hold`).
 *
 * @composition a chain: a handler refuses by failing instead of calling `next`, which fails `remove` with its error
 * and keeps the session; one that calls `next` and then fails reports its failure after the session is gone.
 */
export const SessionRemoveHook = Hook.make<{ readonly sessionId: string }, void, SessionError>("lemma/session.remove");

/** A checkout asked for: the session, the event its leaf moves to, and the leaf it moves from (when it was asked). */
export interface CheckoutRequest {
  readonly sessionId: string;
  readonly eventId: string;
  readonly from: string | undefined;
}

/**
 * Around every `Sessions.checkout`, whoever calls it; the terminal moves the leaf. A handler refuses a checkout by
 * failing instead of calling `next` (a plugin keeping a session on its branch while it works there), or acts on one
 * after `next` succeeded. A provider of `Sessions` runs each checkout through it.
 *
 * @composition a chain: a handler refuses by failing instead of calling `next`, which fails `checkout` with its error
 * and leaves the leaf where it was. Checked: what a handler hands on is a checkout request, what it returns a
 * `SessionInfo`.
 */
export const SessionCheckoutHook = Hook.make<CheckoutRequest, SessionInfo, SessionError>("lemma/session.checkout", {
  check: {
    input: (value) =>
      Predicate.isObject(value) &&
      typeof value.sessionId === "string" &&
      typeof value.eventId === "string" &&
      (value.from === undefined || typeof value.from === "string")
        ? undefined
        : "expected a checkout: { sessionId, eventId, from? }, all strings",
    output: (value) => schemaCheck(SessionInfo)(value),
  },
  summary: { input: (request) => ({ session: request.sessionId, to: request.eventId }) },
});

/**
 * A session's leaf moved (`Sessions.checkout`): later appends branch from `to`. Published by a provider of `Sessions`
 * after the move is durable, before `SessionChanged` for it.
 */
export const SessionCheckedOut = Event.make<{ readonly sessionId: string; readonly from: string | undefined; readonly to: string }>(
  "lemma/session.checked-out",
);

/** A change to how a session is filed; an absent field keeps its value. */
export interface SessionMarks {
  readonly pinned?: boolean;
  readonly archived?: boolean;
  /**
   * Kept though nothing has gone into it yet: a client holds something for it (an unsent prompt, a page in its pane).
   * A provider may delete an empty session that is not kept once it has been empty a while (`sessions.files` does).
   */
  readonly kept?: boolean;
}

/** Sessions, stored as logs. Its provider serves them to clients too: it adds `serveSessions` to `Channels`. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** A new, empty session in `cwd`, the host's (`Paths.cwd`) when absent; with `parent`, an agent of that session. */
    readonly create: (options?: { readonly cwd?: string; readonly parent?: SessionParent }) => Effect.Effect<SessionInfo, SessionError>;
    /** Most recently updated first. */
    readonly list: (options?: { readonly cwd?: string }) => Effect.Effect<readonly SessionInfo[], SessionError>;
    readonly get: (sessionId: string) => Effect.Effect<SessionInfo, SessionError>;
    /**
     * Appends after the current leaf (or `parent`) and moves the leaf to the new
     * event. Durable before it returns; appends to one session are serialized.
     */
    readonly append: (sessionId: string, data: EventData, options?: { readonly parent?: string }) => Effect.Effect<SessionEvent, SessionError>;
    /** Every event in file order, optionally only those after `seq`. */
    readonly events: (sessionId: string, options?: { readonly after?: number }) => Effect.Effect<readonly SessionEvent[], SessionError>;
    /** Root-to-leaf events of the current branch, or of the branch ending at `leaf`. */
    readonly branch: (sessionId: string, options?: { readonly leaf?: string }) => Effect.Effect<readonly SessionEvent[], SessionError>;
    /**
     * Point the leaf at an existing event; later appends branch from there. Runs through `SessionCheckoutHook`, and
     * publishes `SessionCheckedOut` once the leaf has moved.
     */
    readonly checkout: (sessionId: string, eventId: string) => Effect.Effect<SessionInfo, SessionError>;
    /** Pins, archives, or keeps it. None moves the leaf nor `updatedAt`: filing a session is not activity in it. */
    readonly mark: (sessionId: string, marks: SessionMarks) => Effect.Effect<SessionInfo, SessionError>;
    /**
     * What was said in sessions: in each, the newest prompt or reply on its current branch holding every word of
     * `query` (`searchLog`), the most recently updated sessions first, up to `limit` (20 when absent). Reading for it is
     * not a use of a session: one not in memory is read and let go, not kept loaded.
     */
    readonly search: (query: string, options?: { readonly limit?: number }) => Effect.Effect<readonly SessionSearchMatch[], SessionError>;
    /**
     * Moves a session nothing has gone into yet to another directory, as if it had been made there: a new thread whose
     * project is changed before its first prompt keeps its id. Fails `NotEmpty` once it has an event, and `Busy` while
     * it is held.
     */
    readonly relocate: (sessionId: string, cwd: string) => Effect.Effect<SessionInfo, SessionError>;
    /**
     * A new session in the same directory holding the branch that ends at `eventId`, as it reads: the same events,
     * ids, and times, numbered from 1, its leaf at `eventId`, filed as new (no marks). How a session goes on from a
     * point without changing it: one that is damaged (`SessionInfo.damaged`), from its last event that reads. With
     * `parent`, an agent of that session, starting from what it holds (a fork of its finished turns). Fails `NotFound`
     * for an event not in the session.
     */
    readonly fork: (sessionId: string, eventId: string, options?: { readonly parent?: SessionParent }) => Effect.Effect<SessionInfo, SessionError>;
    /**
     * Holds the session while the scope lasts, so it is not removed: work that
     * writes to it holds it from before it starts until it has stopped, as the
     * agent does for each turn. Not a `SessionRemoveHook` handler, since core
     * retires a stopping plugin's handlers before its work has stopped. Fails
     * `NotFound` when it does not exist. Asked for while the session's data is
     * being deleted, it waits for that to end: it fails `NotFound` once the
     * session is gone, and holds it if the deletion failed. Any number of holds
     * may exist at once.
     */
    readonly hold: (sessionId: string) => Effect.Effect<void, SessionError, Scope.Scope>;
    /**
     * Deletes it from disk, for good, through `SessionRemoveHook`, whose
     * handlers may refuse. Fails `Busy` while any hold exists: checked before
     * the handlers run, and again in one step with marking the session as
     * being deleted, after them, so no hold is granted until its data is gone
     * or the deletion has failed.
     */
    readonly remove: (sessionId: string) => Effect.Effect<void, SessionError>;
  }
>()("lemma/Sessions") {}

/** What `sessions.changes` sends: `subscribed` first, then each session created, changed, or removed. */
export const SessionsChange = Schema.Union([
  /** First: from here on the stream hears every change; a client lists what it shows (`sessions.list`) after it. */
  Schema.Struct({ type: Schema.Literal("subscribed") }),
  /** Created, or changed: an append moves its `lastSeq`, `updatedAt` and `leaf` (and `title` for a title event), a checkout its `leaf`, a mark its marks. */
  Schema.Struct({ type: Schema.Literal("session-changed"), info: SessionInfo }),
  Schema.Struct({ type: Schema.Literal("session-removed"), sessionId: Schema.String }),
]);
export type SessionsChange = typeof SessionsChange.Type;

/** What `sessions.log` sends: `subscribed` first, with the log so far, then each event appended to the session. */
export const SessionLogUpdate = Schema.Union([
  /** First: the log after `after`, in file order, read once the stream was hearing appends, so what is appended since follows. */
  Schema.Struct({ type: Schema.Literal("subscribed"), events: Schema.Array(SessionEvent) }),
  /** The event after the last one the stream sent (or after `after`): `seq`s run on without a gap or a repeat. */
  Schema.Struct({ type: Schema.Literal("appended"), event: SessionEvent }),
]);
export type SessionLogUpdate = typeof SessionLogUpdate.Type;

const sessionField = { sessionId: Schema.String };

/**
 * How clients reach `Sessions`, served by its provider (`serveSessions`). A
 * call that fails with a `SessionError` reaches the client with its `reason`
 * as the code (`NotFound`, `Corrupt`, `Io`, `InvalidParent`, `Busy`) and the
 * session as the subject.
 */
export const SessionChannels = {
  list: defineChannel({
    kind: "call",
    id: "sessions.list",
    access: "read",
    title: "List sessions",
    description: "Every session, or those in a directory (cwd), most recently updated first",
    payload: optionalPayload({ cwd: Schema.optional(Schema.String) }),
    success: Schema.Array(SessionInfo),
    repeatable: true,
  }),
  get: defineChannel({
    kind: "call",
    id: "sessions.get",
    access: "read",
    title: "Get a session",
    description: "One session's info",
    payload: Schema.Struct(sessionField),
    success: SessionInfo,
    repeatable: true,
  }),
  create: defineChannel({
    kind: "call",
    id: "sessions.create",
    access: "operate",
    title: "Create a session",
    description: "A new, empty session in a directory (cwd), the host's when absent; with parent, an agent of that session",
    payload: optionalPayload({ cwd: Schema.optional(Schema.String), parent: Schema.optional(SessionParent) }),
    success: SessionInfo,
  }),
  /**
   * One read of the log, for a client that shows it once (`lemma show`, or a
   * log fetched before its thread opens). One that shows the session as it
   * grows follows it with `sessions.log` instead.
   */
  events: defineChannel({
    kind: "call",
    id: "sessions.events",
    access: "read",
    title: "Read a session's log",
    description: "A session's log in file order: every event, or those past a seq (after)",
    payload: Schema.Struct({ ...sessionField, after: Schema.optional(Schema.Number) }),
    success: Schema.Array(SessionEvent),
    repeatable: true,
  }),
  /**
   * Follows one session's log: `subscribed` with the log after `after` (all of
   * it when absent), then each event appended, as `SessionAppended` reports
   * it. In `seq` order, without gaps or repeats: what the stream falls behind
   * on (its client is slow, say) it reads from the log, so a client applies
   * each event as it comes and never repairs. A client reopening it, after a
   * reconnect or when it ends `Withdrawn` as its plugin reloads, passes the
   * last `seq` it has as `after`. A session that does not exist, or is deleted
   * while followed, ends it `NotFound`, the session as its subject; a log it
   * cannot read fails it as `sessions.events` fails.
   */
  log: defineChannel({
    kind: "stream",
    id: "sessions.log",
    access: "read",
    title: "Session log",
    description: "A subscribed acknowledgement carrying a session's log past a seq (after), then each event appended to it, in order and without gaps",
    payload: Schema.Struct({ ...sessionField, after: Schema.optional(Schema.Number) }),
    success: SessionLogUpdate,
  }),
  checkout: defineChannel({
    kind: "call",
    id: "sessions.checkout",
    access: "operate",
    title: "Check out an event",
    description: "Points a session's leaf at one of its events: later turns branch from there",
    payload: Schema.Struct({ ...sessionField, eventId: Schema.String }),
    success: SessionInfo,
  }),
  setTitle: defineChannel({
    kind: "call",
    id: "sessions.set-title",
    access: "operate",
    title: "Rename a session",
    description: "Appends a title event and answers with the session's info",
    payload: Schema.Struct({ ...sessionField, title: Schema.String }),
    success: SessionInfo,
  }),
  mark: defineChannel({
    kind: "call",
    id: "sessions.mark",
    access: "operate",
    title: "Pin, archive, or keep a session",
    description: "Sets how a session is filed; an absent mark keeps its value",
    payload: Schema.Struct({
      ...sessionField,
      pinned: Schema.optional(Schema.Boolean),
      archived: Schema.optional(Schema.Boolean),
      kept: Schema.optional(Schema.Boolean),
    }),
    success: SessionInfo,
  }),
  relocate: defineChannel({
    kind: "call",
    id: "sessions.relocate",
    access: "operate",
    title: "Move an empty session",
    description: "Moves a session nothing has gone into yet to another directory (cwd); fails NotEmpty once it has an event",
    payload: Schema.Struct({ ...sessionField, cwd: Schema.String }),
    success: SessionInfo,
  }),
  fork: defineChannel({
    kind: "call",
    id: "sessions.fork",
    access: "operate",
    title: "Fork a session",
    description:
      "A new session holding the branch that ends at an event (eventId), as it reads; how a damaged session goes on. With parent, an agent of that session",
    payload: Schema.Struct({ ...sessionField, eventId: Schema.String, parent: Schema.optional(SessionParent) }),
    success: SessionInfo,
  }),
  /** `Sessions.search`: what was said in sessions. It reads sessions' logs, so a client asks once the query has settled. */
  search: defineChannel({
    kind: "call",
    id: "sessions.search",
    access: "read",
    title: "Search sessions",
    description: "The newest prompt or reply in each session holding every word of a query, most recently updated sessions first",
    payload: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }),
    success: Schema.Array(SessionSearchMatch),
    repeatable: true,
  }),
  /**
   * The Trajectory view's records of a session's branch, as `lemma sessions inspect --records` lists them: each
   * prompt, change to the system prompt, model call, and tool run, flat, those `filter` keeps as the view's filter box
   * reads it (`parseLedgerFilter`). It reads the branch as `Sessions.branch` does, which loads the session's log, as
   * `sessions.request` and `sessions.cache` do too: a client reads the sessions it needs, not every one.
   */
  records: defineChannel({
    kind: "call",
    id: "sessions.records",
    access: "read",
    title: "A session's records",
    description:
      "Each prompt, system prompt change, model call, and tool run on a session's branch, as its Trajectory view lists them; filter as its filter box does: is:error, is:running, kind:model, tool:bash, turn:2, req:5, text, -term to exclude",
    payload: Schema.Struct({ ...sessionField, filter: Schema.optional(Schema.String) }),
    success: SessionRecords,
    repeatable: true,
  }),
  /**
   * One request a session's branch sent the model, by `request`: its number (`5`), `<turn>.<step>` (`2.1`), a step
   * id, or `last` (the default). Fails `NotFound` when no step there sent one.
   */
  request: defineChannel({
    kind: "call",
    id: "sessions.request",
    access: "read",
    title: "One request",
    description:
      "One request a session sent the model (its number, <turn>.<step>, a step id, or last): each system section and tool with the plugin that contributed it and whether it changed, each plugin's share, and with rebuilt, the exact request",
    payload: Schema.Struct({
      ...sessionField,
      /** A request's number, a whole number from 1; `<turn>.<step>` goes as text (`"2.10"`), which a number cannot keep. */
      request: Schema.optional(Schema.Union([Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)), Schema.String])),
      rebuilt: Schema.optional(Schema.Boolean),
    }),
    success: RequestView,
    repeatable: true,
  }),
  /** How a session's branch kept the provider's prompt cache (`cacheReport`), as `lemma sessions cache` reports it. */
  cache: defineChannel({
    kind: "call",
    id: "sessions.cache",
    access: "read",
    title: "Prompt cache",
    description:
      "How a session's branch kept the provider's prompt cache: its requests, those that changed the system prompt or tools and the plugins that did, and the input read from the cache",
    payload: Schema.Struct(sessionField),
    success: SessionCache,
    repeatable: true,
  }),
  /** `Sessions.remove`: fails `Busy` while the session is held, as it is while a turn runs in it. */
  delete: defineChannel({
    kind: "call",
    id: "sessions.delete",
    access: "operate",
    title: "Delete a session",
    description: "Deletes a session for good; fails Busy while it is in use, as while a turn runs in it",
    payload: Schema.Struct(sessionField),
    success: Schema.Void,
  }),
  /**
   * Every session created, changed, or removed, as `SessionChanged` and
   * `SessionRemoved` report it, after `subscribed` (see `eventFeed`): what a
   * list of sessions shows. An append comes as its session's new `lastSeq`;
   * the event itself only to a client following that session (`sessions.log`),
   * so a client receives the events of the sessions it shows, not of every
   * session. Losable: a client that falls behind loses the oldest, and one
   * reopening it after a reconnect has missed what came between; either way it
   * lists again.
   */
  changes: defineChannel({
    kind: "stream",
    id: "sessions.changes",
    access: "read",
    title: "Session changes",
    description: "Every session created, changed, or removed, after a subscribed acknowledgement",
    payload: Schema.Void,
    success: SessionsChange,
  }),
};

/** What each source of a client's `sessions.changes` or `sessions.log` holds: as much as the client does (see `eventFeed`). */
const FEED = { buffer: 1024 };

/** What `sessions.log` hears before checking it against what it has sent: an update, or that the session was deleted. */
type Heard = SessionLogUpdate | { readonly type: "removed" };

/** `sessions.log` for `sessionId`, from `sessions` and the appends its provider publishes. */
const follow = (
  sessions: Context.Service.Shape<typeof Sessions>,
  events: Context.Service.Shape<typeof Events>,
  sessionId: string,
  after: number,
): Stream.Stream<SessionLogUpdate, SessionError> =>
  Stream.suspend(() => {
    /** The last `seq` sent. */
    let last = after;
    const feed = eventFeed<Heard, SessionError, never>(
      Effect.map(sessions.events(sessionId, { after }), (log) => ({ type: "subscribed", events: log })),
      [
        events.stream(SessionAppended, FEED).pipe(
          Stream.filter((appended) => appended.sessionId === sessionId),
          Stream.map(({ event }): Heard => ({ type: "appended", event })),
        ),
        events.stream(SessionRemoved, FEED).pipe(
          Stream.filter((removed) => removed.sessionId === sessionId),
          Stream.map((): Heard => ({ type: "removed" })),
        ),
      ],
    );
    // A chunk at a time (`mapChunks`), so the events appended together reach a client together.
    return mapChunks(feed, (heard): Effect.Effect<readonly SessionLogUpdate[], SessionError> => {
      if (heard.type === "removed") return Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: `Session ${sessionId} was deleted` }));
      if (heard.type === "subscribed") {
        last = heard.events.at(-1)?.seq ?? last;
        return Effect.succeed([heard]);
      }
      const { seq } = heard.event;
      // Appended while the log was read, or read already to fill a gap.
      if (seq <= last) return Effect.succeed([]);
      if (seq === last + 1) {
        last = seq;
        return Effect.succeed([heard]);
      }
      // Appends dropped on the way, as a slow client's are: the log has them.
      return Effect.map(sessions.events(sessionId, { after: last }), (missed) => {
        last = missed.at(-1)?.seq ?? last;
        return missed.map((event): SessionLogUpdate => ({ type: "appended", event }));
      });
    });
  });

/** `SessionChannels` served from `sessions`: what a provider of `Sessions` adds to `Channels`, each with `PluginContext.add`. */
export const serveSessions = (sessions: Context.Service.Shape<typeof Sessions>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  serveChannel(SessionChannels.list, ({ cwd }) => sessions.list(cwd === undefined ? undefined : { cwd })),
  serveChannel(SessionChannels.get, ({ sessionId }) => sessions.get(sessionId)),
  serveChannel(SessionChannels.create, ({ cwd, parent }) =>
    sessions.create(
      cwd === undefined && parent === undefined ? undefined : { ...(cwd === undefined ? {} : { cwd }), ...(parent === undefined ? {} : { parent }) },
    ),
  ),
  serveChannel(SessionChannels.events, ({ sessionId, after }) => sessions.events(sessionId, after === undefined ? undefined : { after })),
  serveChannel(SessionChannels.log, ({ sessionId, after }) => follow(sessions, events, sessionId, after ?? 0)),
  serveChannel(SessionChannels.checkout, ({ sessionId, eventId }) => sessions.checkout(sessionId, eventId)),
  serveChannel(SessionChannels.setTitle, ({ sessionId, title }) =>
    Effect.andThen(sessions.append(sessionId, { type: "title", title }), sessions.get(sessionId)),
  ),
  serveChannel(SessionChannels.mark, ({ sessionId, pinned, archived, kept }) =>
    sessions.mark(sessionId, {
      ...(pinned === undefined ? {} : { pinned }),
      ...(archived === undefined ? {} : { archived }),
      ...(kept === undefined ? {} : { kept }),
    }),
  ),
  serveChannel(SessionChannels.relocate, ({ sessionId, cwd }) => sessions.relocate(sessionId, cwd)),
  serveChannel(SessionChannels.fork, ({ sessionId, eventId, parent }) =>
    parent === undefined ? sessions.fork(sessionId, eventId) : sessions.fork(sessionId, eventId, { parent }),
  ),
  serveChannel(SessionChannels.search, ({ query, limit }) => sessions.search(query, limit === undefined ? undefined : { limit })),
  serveChannel(SessionChannels.records, ({ sessionId, filter }) => Effect.map(sessions.branch(sessionId), (branch) => recordsOf(trajectory(branch), filter))),
  serveChannel(SessionChannels.request, ({ sessionId, request, rebuilt }) =>
    Effect.flatMap(sessions.branch(sessionId), (branch) => {
      const selector = String(request ?? "last");
      const found = requestOf(branch, trajectory(branch), selector, { sessionId, ...(rebuilt === undefined ? {} : { rebuilt }) });
      return found === undefined
        ? Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: `No request "${selector}" on the current branch of ${sessionId}` }))
        : Effect.succeed(found);
    }),
  ),
  serveChannel(SessionChannels.cache, ({ sessionId }) => Effect.map(sessions.branch(sessionId), (branch) => cacheReport(trajectory(branch)))),
  serveChannel(SessionChannels.delete, ({ sessionId }) => sessions.remove(sessionId)),
  serveChannel(SessionChannels.changes, () =>
    eventFeed(Effect.succeed<SessionsChange>({ type: "subscribed" }), [
      Stream.map(events.stream(SessionChanged, FEED), ({ info }): SessionsChange => ({ type: "session-changed", info })),
      Stream.map(events.stream(SessionRemoved, FEED), ({ sessionId }): SessionsChange => ({ type: "session-removed", sessionId })),
    ]),
  ),
];

/*
 * A session's addresses in the web app, which shows it as a thread: the app
 * knows them whatever plugins run, the desktop app opens them from deep links
 * (`lemma://threads/<id>`), and the CLI prints them (`lemma open`).
 */

/** A new thread. */
export const NewThreadRoute = defineRoute("thread.new", { path: "/" });
/** A thread; with `view` (a web app `Views` item's id), that view opened in the pane beside its chat. */
export const ThreadRoute = defineRoute("thread", { path: "/threads/:id/:view?" });
