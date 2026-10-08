import { Context, Data, Effect, Schema, Stream } from "effect";
import { Event, Hook } from "@lemma/core";
import type { Events } from "@lemma/core";
import { defineRoute } from "@lemma/router";
import { defineChannel, eventFeed, serveChannel } from "./channels.ts";
import type { Channel } from "./channels.ts";
import { AssistantMessage, LlmFailure, Message, ThinkingLevel, ToolSpec, Usage } from "./llm.ts";

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
  Schema.Struct({ type: Schema.Literal("step-end"), turnId: Schema.String, stepId: Schema.String }),
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
});
export type SessionInfo = typeof SessionInfo.Type;

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly sessionId?: string;
  /** `Busy`: a `SessionRemoveHook` handler refused to remove the session while it is in use. */
  readonly reason: "NotFound" | "Corrupt" | "Io" | "InvalidParent" | "Busy";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const SessionAppended = Event.make<{ readonly sessionId: string; readonly event: SessionEvent }>("lemma/session.appended");
export const SessionChanged = Event.make<{ readonly info: SessionInfo }>("lemma/session.changed");
export const SessionRemoved = Event.make<{ readonly sessionId: string }>("lemma/session.removed");

/**
 * Around every `Sessions.remove`, whoever calls it; the terminal deletes the
 * session. A handler that must not see a session go while it uses it refuses
 * by failing instead of calling `next`: the agent fails `Busy` while a turn
 * runs in the session. A provider of `Sessions` runs each removal through it,
 * so the rule holds for every client and every plugin.
 */
export const SessionRemoveHook = Hook.make<{ readonly sessionId: string }, void, SessionError>("lemma/session.remove");

/** A change to how a session is filed; an absent field keeps its value. */
export interface SessionMarks {
  readonly pinned?: boolean;
  readonly archived?: boolean;
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
    /** Point the leaf at an existing event; later appends branch from there. */
    readonly checkout: (sessionId: string, eventId: string) => Effect.Effect<SessionInfo, SessionError>;
    /** Pins or archives it. Neither moves the leaf nor `updatedAt`: filing a session is not activity in it. */
    readonly mark: (sessionId: string, marks: SessionMarks) => Effect.Effect<SessionInfo, SessionError>;
    /** Deletes it from disk, for good, unless a `SessionRemoveHook` handler refuses. */
    readonly remove: (sessionId: string) => Effect.Effect<void, SessionError>;
  }
>()("lemma/Sessions") {}

/** What `sessions.changes` sends: `subscribed` first, then each change to any session. */
export const SessionsChange = Schema.Union([
  /** First: from here on the stream hears every change; a client reads what it shows (`sessions.list`, `sessions.events`) after it. */
  Schema.Struct({ type: Schema.Literal("subscribed") }),
  Schema.Struct({ type: Schema.Literal("session-appended"), sessionId: Schema.String, event: SessionEvent }),
  Schema.Struct({ type: Schema.Literal("session-changed"), info: SessionInfo }),
  Schema.Struct({ type: Schema.Literal("session-removed"), sessionId: Schema.String }),
]);
export type SessionsChange = typeof SessionsChange.Type;

const sessionField = { sessionId: Schema.String };

/**
 * How clients reach `Sessions`, served by its provider (`serveSessions`). A
 * call that fails with a `SessionError` reaches the client with its `reason`
 * as the code (`NotFound`, `Corrupt`, `Io`, `InvalidParent`, `Busy`) and the
 * session as the subject.
 */
export const SessionsChannels = {
  list: defineChannel({
    kind: "call",
    id: "sessions.list",
    title: "List sessions",
    description: "Every session, or those in a directory (cwd), most recently updated first",
    payload: Schema.Struct({ cwd: Schema.optional(Schema.String) }),
    success: Schema.Array(SessionInfo),
  }),
  get: defineChannel({
    kind: "call",
    id: "sessions.get",
    title: "Get a session",
    description: "One session's info",
    payload: Schema.Struct(sessionField),
    success: SessionInfo,
  }),
  create: defineChannel({
    kind: "call",
    id: "sessions.create",
    title: "Create a session",
    description: "A new, empty session in a directory (cwd), the host's when absent",
    payload: Schema.Struct({ cwd: Schema.optional(Schema.String) }),
    success: SessionInfo,
  }),
  /** Losable notifications leave gaps (`sessions.changes`); a client repairs them from here, by `seq`. */
  events: defineChannel({
    kind: "call",
    id: "sessions.events",
    title: "Read a session's log",
    description: "A session's log in file order: every event, or those past a seq (after)",
    payload: Schema.Struct({ ...sessionField, after: Schema.optional(Schema.Number) }),
    success: Schema.Array(SessionEvent),
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
    title: "Pin or archive a session",
    description: "Sets how a session is filed; an absent mark keeps its value",
    payload: Schema.Struct({ ...sessionField, pinned: Schema.optional(Schema.Boolean), archived: Schema.optional(Schema.Boolean) }),
    success: SessionInfo,
  }),
  /** Through `SessionRemoveHook`: fails `Busy` while a turn runs in the session. */
  delete: defineChannel({
    kind: "call",
    id: "sessions.delete",
    title: "Delete a session",
    description: "Deletes a session for good; fails Busy while a turn runs in it",
    payload: Schema.Struct(sessionField),
    success: Schema.Void,
  }),
  /**
   * Every change to any session, as `SessionAppended`, `SessionChanged`, and
   * `SessionRemoved` report it, after `subscribed` (see `eventFeed`). Losable:
   * a client that falls behind loses the oldest, and one reopening it after a
   * reconnect has missed what came between; either way it rereads, by `seq`,
   * from `sessions.events`, and lists again.
   */
  changes: defineChannel({
    kind: "stream",
    id: "sessions.changes",
    title: "Session changes",
    description: "Every session appended to, changed, or removed, after a subscribed acknowledgement",
    payload: Schema.Void,
    success: SessionsChange,
  }),
};

/** What each source of a client's `sessions.changes` holds: as much as the client does (see `eventFeed`). */
const FEED = { buffer: 1024 };

/** `SessionsChannels` served from `sessions`: what a provider of `Sessions` adds to `Channels`, each with `PluginContext.add`. */
export const serveSessions = (sessions: Context.Service.Shape<typeof Sessions>, events: Context.Service.Shape<typeof Events>): readonly Channel[] => [
  serveChannel(SessionsChannels.list, ({ cwd }) => sessions.list(cwd === undefined ? undefined : { cwd })),
  serveChannel(SessionsChannels.get, ({ sessionId }) => sessions.get(sessionId)),
  serveChannel(SessionsChannels.create, ({ cwd }) => sessions.create(cwd === undefined ? undefined : { cwd })),
  serveChannel(SessionsChannels.events, ({ sessionId, after }) => sessions.events(sessionId, after === undefined ? undefined : { after })),
  serveChannel(SessionsChannels.checkout, ({ sessionId, eventId }) => sessions.checkout(sessionId, eventId)),
  serveChannel(SessionsChannels.setTitle, ({ sessionId, title }) =>
    Effect.andThen(sessions.append(sessionId, { type: "title", title }), sessions.get(sessionId)),
  ),
  serveChannel(SessionsChannels.mark, ({ sessionId, pinned, archived }) =>
    sessions.mark(sessionId, { ...(pinned === undefined ? {} : { pinned }), ...(archived === undefined ? {} : { archived }) }),
  ),
  serveChannel(SessionsChannels.delete, ({ sessionId }) => sessions.remove(sessionId)),
  serveChannel(SessionsChannels.changes, () =>
    eventFeed(Effect.succeed<SessionsChange>({ type: "subscribed" }), [
      Stream.map(events.stream(SessionAppended, FEED), ({ sessionId, event }): SessionsChange => ({ type: "session-appended", sessionId, event })),
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
/** A thread, in one of its views (the web app's `Views` item ids; the first when absent). */
export const ThreadRoute = defineRoute("thread", { path: "/threads/:id/:view?" });
