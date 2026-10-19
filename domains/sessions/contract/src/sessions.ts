import { Context, Data, Effect, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Event, Hook } from "@lemma/core";
import type { Events } from "@lemma/core";
import { defineRoute } from "@lemma/router";
import { defineChannel, eventFeed, HandlerCredit, optionalPayload, ResultCredit, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { AssistantMessage, LlmFailure, Message, ThinkingLevel, ToolSpec, Usage } from "@lemma/llm";
import { SessionSearchMatch } from "./search.ts";

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

export const EventData = Schema.Union([
  /** `model` and `thinking` are what the turn was started with, so a turn resumed after a restart runs on with them. */
  Schema.Struct({ type: Schema.Literal("turn-start"), turnId: Schema.String, model: Schema.optional(Schema.String), thinking: Schema.optional(ThinkingLevel) }),
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
   * The request header, logged before the model call. `system` and `tools` are
   * omitted when unchanged since the previous `request` on the branch.
   * `system` is the text of the `system` contributions, in order, with empty
   * ones dropped, joined by a blank line (`"\n\n"`); `chars` is each text's
   * length, so `trajectory` can split it back into sections.
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
    contributions: Schema.Array(Contribution),
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
  }),
  Schema.Struct({ type: Schema.Literal("title"), title: Schema.String }),
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

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
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
});
export type SessionInfo = typeof SessionInfo.Type;

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly sessionId?: string;
  /**
   * `Busy`: `remove` or `relocate` refused, as the session is held (`Sessions.hold`) or a `SessionRemoveHook` handler
   * refused it. `NotEmpty`: `relocate` refused, as something has gone into the session.
   */
  readonly reason: "NotFound" | "Corrupt" | "Io" | "InvalidParent" | "Busy" | "NotEmpty";
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
 */
export const SessionCheckoutHook = Hook.make<CheckoutRequest, SessionInfo, SessionError>("lemma/session.checkout", {
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
    /** A new, empty session in `cwd`, the host's (`Paths.cwd`) when absent. */
    readonly create: (options?: { readonly cwd?: string }) => Effect.Effect<SessionInfo, SessionError>;
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
    title: "List sessions",
    description: "Every session, or those in a directory (cwd), most recently updated first",
    payload: optionalPayload({ cwd: Schema.optional(Schema.String) }),
    success: Schema.Array(SessionInfo),
    repeatable: true,
  }),
  get: defineChannel({
    kind: "call",
    id: "sessions.get",
    title: "Get a session",
    description: "One session's info",
    payload: Schema.Struct(sessionField),
    success: SessionInfo,
    repeatable: true,
  }),
  create: defineChannel({
    kind: "call",
    id: "sessions.create",
    title: "Create a session",
    description: "A new, empty session in a directory (cwd), the host's when absent",
    payload: optionalPayload({ cwd: Schema.optional(Schema.String) }),
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
    title: "Session log",
    description: "A subscribed acknowledgement carrying a session's log past a seq (after), then each event appended to it, in order and without gaps",
    payload: Schema.Struct({ ...sessionField, after: Schema.optional(Schema.Number) }),
    success: SessionLogUpdate,
  }),
  checkout: defineChannel({
    kind: "call",
    id: "sessions.checkout",
    title: "Check out an event",
    description: "Points a session's leaf at one of its events: later turns branch from there",
    payload: Schema.Struct({ ...sessionField, eventId: Schema.String }),
    success: SessionInfo,
  }),
  setTitle: defineChannel({
    kind: "call",
    id: "sessions.set-title",
    title: "Rename a session",
    description: "Appends a title event and answers with the session's info",
    payload: Schema.Struct({ ...sessionField, title: Schema.String }),
    success: SessionInfo,
  }),
  mark: defineChannel({
    kind: "call",
    id: "sessions.mark",
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
    title: "Move an empty session",
    description: "Moves a session nothing has gone into yet to another directory (cwd); fails NotEmpty once it has an event",
    payload: Schema.Struct({ ...sessionField, cwd: Schema.String }),
    success: SessionInfo,
  }),
  /** `Sessions.search`: what was said in sessions. It reads sessions' logs, so a client asks once the query has settled. */
  search: defineChannel({
    kind: "call",
    id: "sessions.search",
    title: "Search sessions",
    description: "The newest prompt or reply in each session holding every word of a query, most recently updated sessions first",
    payload: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }),
    success: Schema.Array(SessionSearchMatch),
    repeatable: true,
  }),
  /** `Sessions.remove`: fails `Busy` while the session is held, as it is while a turn runs in it. */
  delete: defineChannel({
    kind: "call",
    id: "sessions.delete",
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
  eventFeed<Heard, SessionError, never>(
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
  ).pipe(
    // The state is the last `seq` sent.
    Stream.mapAccumEffect(
      () => after,
      (last, heard): Effect.Effect<readonly [number, readonly SessionLogUpdate[]], SessionError> => {
        if (heard.type === "removed") return Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: `Session ${sessionId} was deleted` }));
        if (heard.type === "subscribed") return Effect.succeed([heard.events.at(-1)?.seq ?? last, [heard]]);
        const { seq } = heard.event;
        // Appended while the log was read, or read already to fill a gap.
        if (seq <= last) return Effect.succeed([last, []]);
        if (seq === last + 1) return Effect.succeed([seq, [heard]]);
        // Appends dropped on the way, as a slow client's are: the log has them.
        return Effect.map(sessions.events(sessionId, { after: last }), (missed) => [
          missed.at(-1)?.seq ?? last,
          missed.map((event): SessionLogUpdate => ({ type: "appended", event })),
        ]);
      },
    ),
  );

/** `SessionChannels` served from `sessions`: what a provider of `Sessions` adds to `Channels`, each with `PluginContext.add`. */
export const serveSessions = (sessions: Context.Service.Shape<typeof Sessions>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  serveChannel(SessionChannels.list, ({ cwd }) => sessions.list(cwd === undefined ? undefined : { cwd })),
  serveChannel(SessionChannels.get, ({ sessionId }) => sessions.get(sessionId)),
  serveChannel(SessionChannels.create, ({ cwd }) => sessions.create(cwd === undefined ? undefined : { cwd })),
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
  serveChannel(SessionChannels.search, ({ query, limit }) => sessions.search(query, limit === undefined ? undefined : { limit })),
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
