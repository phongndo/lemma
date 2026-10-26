import { Effect, Scope } from "effect";
import type { Context, Deferred, Fiber, Semaphore } from "effect";
import type { Events } from "@lemma/core";
import type { HostControl } from "@lemma/contracts";
import type { Llm, ModelInfo } from "@lemma/llm";
import { SessionError } from "@lemma/sessions";
import type { Sessions } from "@lemma/sessions";
import { AgentError, QueueChanged } from "../../agent.ts";
import type { QueuedPrompt, TurnOptions } from "../../agent.ts";
import { failedAs } from "../errors.ts";
import type { makeInputDecisions } from "../input.ts";
import type { LiveTurn } from "../live.ts";
import type { Item, makeQueues, QueuedTurn, SessionState } from "../queue.ts";
import type { makeRequestIndex } from "../requests.ts";
import type { makeSlots, SlotHolder } from "../slots.ts";
import type { StateFiles } from "../state.ts";
import type { Ended, Placed, TurnOutcome, TurnServices, TurnSettings } from "../turn.ts";
import type { KeptBranches } from "./branches.ts";

/*
 * The agent as its parts see it (`makeAgent`): what it runs on, and what it keeps of each session. Each part takes
 * the agent and reads or changes what it says it does; changes to a session's queue and turn are made under `admit`.
 */

/** A turn running in a session, or about to: what the agent keeps of it beside what the journal records. */
export interface Running extends SlotHolder, QueuedTurn {
  readonly controller: AbortController;
  /** Epoch ms the turn started (or resumed), for the inspector. */
  readonly startedAt: number;
  /** Set right after the fork; `cancel` waits for it so an early cancel cannot miss the turn. */
  readonly fiber: Deferred.Deferred<Fiber.Fiber<TurnOutcome, AgentError>>;
  /** Completes on `cancel`: a turn waiting for a slot (or a resumed one for the composition) stops waiting. */
  readonly cancelled: Deferred.Deferred<void>;
  readonly live: LiveTurn;
  readonly items: Map<string, Item>;
  /** It logs an `agent.started` event before running tool calls (every turn this agent starts does; see `Journal`). */
  readonly marked: boolean;
  /**
   * Its body has begun (it had a slot, or was cancelled waiting for one; and a resumed one had the composition): a
   * cancel interrupts it rather than leaving the flag for it to read.
   */
  started: boolean;
  cancelling: boolean;
  /** It resumes only to close so: it had ended, but its `turn-end` had not reached the log. */
  readonly closing: Ended | undefined;
  /** It ended so, but its `turn-end` did not reach the log (`TurnInput.unclosed`): it is kept to be closed so. */
  unclosed: Ended | undefined;
}

export interface AgentContext {
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  readonly llm: Context.Service.Shape<typeof Llm>;
  readonly host: Context.Service.Shape<typeof HostControl>;
  readonly events: Context.Service.Shape<typeof Events>;
  /** `<provider>/<model>` for turns that name none (`AgentConfig.defaultModel`). */
  readonly defaultModel: string | undefined;
  /** Where its journal and live files are. */
  readonly files: StateFiles;
  /** Where this instance's queue revisions start (see `SessionState.revision`): past every earlier instance's. */
  readonly base: number;
  /** A new id for a turn or an unnamed prompt, from the agent's `IdSource`. */
  readonly newId: () => string;
  /** What a turn runs on and with (`runTurn`). */
  readonly services: TurnServices;
  readonly settings: TurnSettings;
  /** The scope turns run in: the plugin's, not their caller's, so they outlive an interrupted `prompt`. */
  readonly turns: Scope.Scope;
  /** Completes when the agent starts stopping: turns waiting to ask the model again suspend at once. */
  readonly stopping: Deferred.Deferred<void>;
  /** Set when the agent starts stopping: a turn interrupted then, or failing, is left open in the log, to resume. */
  suspending: boolean;
  /** Each session's queue and turn, journaled. */
  readonly queues: ReturnType<typeof makeQueues<Running>>;
  /** Serializes queue and turn changes: admission, placement, a turn ending and the next starting. */
  readonly admit: Semaphore.Semaphore;
  /** Turns running at once (`maxRunning`). */
  readonly slots: ReturnType<typeof makeSlots>;
  /** Each session's request ids the log has, for exactly-once prompts. */
  readonly requests: ReturnType<typeof makeRequestIndex>;
  /** Each session's branch as its last turn left it. */
  readonly branches: KeptBranches;
  /** What `AgentInputHook` made of prompts. */
  readonly decisions: ReturnType<typeof makeInputDecisions>;
}

/** Random bytes in a turn's, a step's, or an unnamed prompt's id. */
export const ID_BYTES = 6;

/** The store said the session does not exist. */
export const gone = (error: AgentError): boolean => error.cause instanceof SessionError && error.cause.reason === "NotFound";

export const retractedError = (sessionId: string) => new AgentError({ sessionId, reason: "Retracted", message: "The prompt was withdrawn from the queue" });

/** A queued prompt as a turn places it: what its user message carries, or a plugin's `context` event. */
export const placedOf = ({ requestId, content, credit, source, display }: QueuedPrompt): Placed => ({
  requestId,
  content,
  ...(credit === undefined ? {} : { credit }),
  ...(source === undefined ? {} : { source }),
  ...(display === undefined ? {} : { display }),
});

/** Tells clients the session's queue as it is now, with its revision. */
export const queueChanged = (agent: AgentContext, sessionId: string) =>
  Effect.suspend(() => {
    const state = agent.queues.of(sessionId);
    return agent.events.publish(QueueChanged, { sessionId, queue: state.queue.map((item) => item.prompt), revision: state.revision });
  });

/**
 * The session held (`Sessions.hold`) for a turn about to start, in a scope `start` closes once the turn has
 * stopped: the session cannot be deleted under it. Fails `Session` when the session is gone. Taken under
 * `admit` only while the session is held already (before admission, by `ready`, or by the turn ending), so it
 * never waits there on a deletion, which would hold up every session.
 */
export const holdFor = (agent: AgentContext, sessionId: string) =>
  Effect.flatMap(Scope.make(), (lease) =>
    agent.sessions.hold(sessionId).pipe(Scope.provide(lease), Effect.as(lease), Effect.mapError(failedAs(sessionId, "Session"))),
  );

/** The session has no turn and nothing queued: what is kept for it goes (its queue revision stays, to keep growing). */
export const forget = (agent: AgentContext, sessionId: string, state: SessionState<Running>) => {
  if (state.turn !== undefined || state.suspended !== undefined || state.queue.length > 0) return;
  agent.requests.drop(sessionId);
};

/** The model a turn asks: the one `options` names, else the configured default, else the first available. */
export const resolveModel = (agent: AgentContext, sessionId: string, options?: TurnOptions): Effect.Effect<ModelInfo, AgentError> =>
  Effect.gen(function* () {
    const ref = options?.model ?? agent.defaultModel;
    if (ref !== undefined) {
      return yield* agent.llm.model(ref).pipe(Effect.mapError(failedAs(sessionId, "NoModel")));
    }
    const [first] = yield* agent.llm.models({ available: true });
    if (first === undefined) {
      return yield* new AgentError({
        sessionId,
        reason: "NoModel",
        message: "No model is available. Log in to a provider or set agent.loop's defaultModel.",
      });
    }
    return first;
  });
