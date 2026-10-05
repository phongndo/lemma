import { Context, Data, Schema } from "effect";
import type { Effect, Scope } from "effect";
import { Event } from "@lemma/core";
import type { PluginContext } from "@lemma/core";
import type { AgentError, PromptContent, TurnOptions } from "./agent.ts";
import type { StreamEvent } from "./llm.ts";

/*
 * A harness runs turns: it takes the prompts the agent places and produces the
 * session's events until the turn ends. The agent owns everything around a turn
 * (queueing, steering, exactly-once submission, the journal that resumes a turn
 * after a restart, the live view), so every harness gets those whatever it is:
 * the native loop, or another coding agent driven through its protocol.
 *
 * Every harness logs the same events (see `SessionEvent`), so clients show any
 * session one way. Only the native harness also logs its model requests
 * (`requests`): another agent keeps its own context, and the log is a record of
 * what it did, not what it was sent.
 */

/** The native harness's id: turns whose `turn-start` names no harness ran on it. */
export const NATIVE_HARNESS = "lemma";

/**
 * What a harness can do. The agent and clients branch on these, never on a
 * harness id, and each missing one has a fallback.
 */
export const HarnessCapabilities = Schema.Struct({
  /** Places steers in its running turn. Without: a steer waits, and starts the next turn. */
  steer: Schema.Boolean,
  /** Runs a turn on the model `TurnOptions.model` names (an `Llm.models` ref). Without: on a model of its own choosing. */
  models: Schema.Boolean,
  /** Continues a turn a host restart cut off. Without: the turn closes as interrupted, and the next prompt starts afresh. */
  resume: Schema.Boolean,
  /** Logs every model request (`request` events), so `rebuildRequest` reproduces it. Without: the log records what it did. */
  requests: Schema.Boolean,
});
export type HarnessCapabilities = typeof HarnessCapabilities.Type;

export const HarnessStatus = Schema.Struct({
  /** `unavailable`: it cannot run turns now (not installed, say); `detail` says why and how to fix it. */
  state: Schema.Literal("ready", "unavailable"),
  detail: Schema.optional(Schema.String),
});
export type HarnessStatus = typeof HarnessStatus.Type;

/** A registered harness as clients list it. */
export const HarnessInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  /** The plugin that registered it. */
  source: Schema.String,
  capabilities: HarnessCapabilities,
  status: HarnessStatus,
});
export type HarnessInfo = typeof HarnessInfo.Type;

/** A prompt as a turn places it: a user message carrying the submission's id. */
export interface PlacedPrompt {
  readonly requestId: string;
  readonly content: PromptContent;
}

/** The session's queue as a running turn sees it: steers join the turn between its steps. */
export interface TurnInbox {
  /** Queued steers, oldest first. They stay queued until `placed`, so one is never lost between the queue and the log. */
  readonly steers: Effect.Effect<readonly PlacedPrompt[]>;
  /** These steers' messages are in the log: take them out of the queue. */
  readonly placed: (requestIds: readonly string[]) => Effect.Effect<void>;
}

/**
 * The running turn's output that the log does not have yet, which clients
 * joining midway are shown (`Agent.view`). A harness reports each model
 * call's stream here as it publishes it (`AssistantDelta`).
 */
export interface TurnLive {
  /** A model call begins; its stream events follow. */
  readonly startStep: (stepId: string, startedAt: number) => void;
  /** Applies a stream event of the call in flight; returns its number in the step, from 1, for `AssistantDelta.seq`. */
  readonly apply: (event: StreamEvent) => number;
  /** The call's message (or attempt) is logged. */
  readonly endStep: () => void;
  /** The tool's result is logged. */
  readonly toolEnded: (toolCallId: string) => void;
}

/** One turn, as the agent hands it to a harness. */
export interface HarnessTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** Session title before the turn; a harness sets a missing one from the first prompt. */
  readonly title?: string;
  /** The options of the prompt that started the turn (the last, when it started with several). */
  readonly options: TurnOptions;
  /** Placed first, in order: a new turn's prompts, or those a resumed turn had not placed yet. */
  readonly prompts: readonly PlacedPrompt[];
  /**
   * Present when the turn continues one a host restart cut off: its `turn-start` is in the log, its `turn-end` is not.
   * `cancelling`: `cancel` had been asked for, so it closes as cancelled.
   */
  readonly resume?: { readonly cancelling: boolean };
  /** Aborted by `cancel`, before the turn's fiber is interrupted. */
  readonly signal: AbortSignal;
  readonly inbox: TurnInbox;
  readonly live: TurnLive;
  /** A prompt's message is in the log. */
  readonly logged: (requestId: string) => void;
  /**
   * True once the agent is closing (the host stopping, or the agent
   * reloading): a turn interrupted then is left open in the log, to resume
   * when the agent starts again, rather than closed as cancelled.
   */
  readonly suspended: () => boolean;
}

export type TurnReason = "done" | "cancelled" | "error" | "max-steps";

/**
 * Runs turns. `run` logs the turn from its `turn-start` (naming the harness)
 * to its `turn-end` and publishes `TurnStarted` and `TurnEnded`. A turn
 * interrupted while the agent is `suspended` is left open by a harness that
 * can `resume` it, and closed by one that cannot. A failure before anything
 * is logged (no model, not installed) fails `run`; anything later ends the
 * turn with reason `error`.
 */
export interface Harness {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly capabilities: HarnessCapabilities;
  readonly status: Effect.Effect<HarnessStatus>;
  readonly run: (turn: HarnessTurn) => Effect.Effect<TurnReason, AgentError>;
}

export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly harness: string;
  /** `Duplicate`: another plugin registered the id. `Failed`: the registry could not take it. */
  readonly reason: "Duplicate" | "Failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Published whenever a harness is registered or removed, or a registered one's status changes. */
export const HarnessesChanged = Event.make<{ readonly harnesses: readonly HarnessInfo[] }>("lemma/harnesses.changed");

export class Harnesses extends Context.Tag("lemma/Harnesses")<
  Harnesses,
  {
    /**
     * Call during activation: the registering plugin's `PluginContext` supplies
     * `source`. Removed when that plugin's scope closes. A duplicate id fails
     * `Duplicate`.
     */
    readonly register: (harness: Harness) => Effect.Effect<void, HarnessError, Scope.Scope | PluginContext>;
    /** The native harness first, then by title. */
    readonly list: Effect.Effect<readonly HarnessInfo[]>;
    readonly get: (id: string) => Effect.Effect<Harness | undefined>;
    /** Asks every harness its status again and publishes `HarnessesChanged`: after installing one, say. */
    readonly refresh: Effect.Effect<readonly HarnessInfo[]>;
  }
>() {}
