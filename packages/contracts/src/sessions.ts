import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event } from "@lemma/core";
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
  kind: Schema.Literal("system", "tool"),
  /** Section id or tool name. */
  label: Schema.String,
  chars: Schema.Number,
});
export type Contribution = typeof Contribution.Type;

export const EventData = Schema.Union(
  /** `model` and `thinking` are what the turn was started with, so a turn resumed after a restart runs on with them. */
  Schema.Struct({ type: Schema.Literal("turn-start"), turnId: Schema.String, model: Schema.optional(Schema.String), thinking: Schema.optional(ThinkingLevel) }),
  Schema.Struct({
    type: Schema.Literal("turn-end"),
    turnId: Schema.String,
    reason: Schema.Literal("done", "cancelled", "error", "max-steps"),
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
    retry: Schema.optional(Schema.Struct({ reason: Schema.Literal("failure", "restart"), attempt: Schema.Number, at: Schema.Number })),
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
);
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
  readonly reason: "NotFound" | "Corrupt" | "Io" | "InvalidParent";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const SessionAppended = Event.make<{ readonly sessionId: string; readonly event: SessionEvent }>("lemma/session.appended");
export const SessionChanged = Event.make<{ readonly info: SessionInfo }>("lemma/session.changed");
export const SessionRemoved = Event.make<{ readonly sessionId: string }>("lemma/session.removed");

/** A change to how a session is filed; an absent field keeps its value. */
export interface SessionMarks {
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export class Sessions extends Context.Tag("lemma/Sessions")<
  Sessions,
  {
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
    /** Deletes it from disk, for good. */
    readonly remove: (sessionId: string) => Effect.Effect<void, SessionError>;
  }
>() {}
