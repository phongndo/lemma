import { Effect } from "effect";
import type { Context } from "effect";
import type { Events, Hooks, PluginContext } from "@lemma/core";
import type { HostControl, ResultCredit } from "@lemma/contracts";
import type { Llm, ModelInfo, ThinkingLevel } from "@lemma/llm";
import type { RequestState, SessionEvent, Sessions, TurnEndReason } from "@lemma/sessions";
import type { ToolRunner } from "@lemma/tools";
import { TurnStarted } from "../agent.ts";
import type { AgentError, PromptContent, SectionRequest, SystemSection } from "../agent.ts";
import type { LiveTurn } from "./live.ts";
import { titleFrom } from "./prompt.ts";
import type { ResumePlan } from "./resume.ts";
import type { RetrySettings } from "./retry.ts";
import type { LiveFile } from "./state.ts";
import { finish } from "./turn/close.ts";
import { asked, makeTurn, userMessage } from "./turn/context.ts";
import type { Turn } from "./turn/context.ts";
import { openBranch } from "./turn/log.ts";
import { resumed } from "./turn/resumed.ts";
import { steps } from "./turn/steps.ts";

/*
 * One turn over the session log (`runTurn`), and what it runs on. Its parts are in `turn/`: the log it appends to
 * (`log.ts`), each step's request (`request.ts`), model call (`model.ts`), and tool calls (`tools.ts`), the steps
 * themselves (`steps.ts`), a turn continued after a restart (`resumed.ts`), and how it ends (`close.ts`).
 */

export interface TurnServices {
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  readonly llm: Context.Service.Shape<typeof Llm>;
  readonly tools: Context.Service.Shape<typeof ToolRunner>;
  readonly host: Context.Service.Shape<typeof HostControl>;
  readonly hooks: Context.Service.Shape<typeof Hooks>;
  readonly events: Context.Service.Shape<typeof Events>;
  /** The system prompt's sections for a request, in order (`PromptSections`), each attributed to the plugin that added it. */
  readonly sections: (request: SectionRequest) => Effect.Effect<readonly SystemSection[], AgentError>;
  /** A span of the agent's own work, named for its plugin (`PluginContext.trace`). */
  readonly trace: Context.Service.Shape<typeof PluginContext>["trace"];
  /** A new id for a step, from the agent's `IdSource`. */
  readonly newId: () => string;
}

export interface TurnSettings extends RetrySettings {
  readonly maxSteps: number;
  /** A reply the user stopped is logged as a `message` of what it had written, which the model then sees (`stopped`). */
  readonly keepCancelled: boolean;
  /** Calls of one response that run at once, at most, when their tools may run together. */
  readonly parallelTools: number;
}

/**
 * A session's branch as a turn left it, with the request state at its end (`requestState(events)`), for the next turn:
 * its `events` belong to whoever holds it, and the turn that takes it appends to them as it goes.
 */
export interface KeptBranch {
  readonly events: SessionEvent[];
  readonly request: RequestState;
}

/** A prompt as a turn places it: a user message carrying the submission's id. */
export interface Placed {
  readonly requestId: string;
  readonly content: PromptContent;
  /** Who shaped it (`AgentInputHook`'s handlers), logged with it. */
  readonly credit?: ResultCredit;
  /** The plugin that sent it, when no person did (`PromptOptions.source`): it is logged as that plugin's `context`. */
  readonly source?: string;
  /** For a plugin's: what a transcript shows of it (`PromptOptions.display`). */
  readonly display?: string;
}

/** The session's queue as the turn sees it: steers join the turn between steps. */
export interface TurnInbox {
  /** Queued steers, oldest first. They stay queued until `placed`, so one is never lost between the queue and the log. */
  readonly steers: Effect.Effect<readonly Placed[]>;
  /** These steers' messages are in the log: take them out of the queue. */
  readonly placed: (requestIds: readonly string[]) => Effect.Effect<void>;
}

/** A turn that a host restart cut off: where it stopped, and what its cut-off calls had produced then. */
export interface TurnResume {
  readonly plan: ResumePlan;
  readonly restored?: LiveFile;
  /** `cancel` had been asked for: the turn closes as cancelled. */
  readonly cancelling: boolean;
  /** It had ended so, but its `turn-end` did not reach the log (`TurnInput.unclosed`): it closes so, asking nothing. */
  readonly closing?: Ended;
}

export interface TurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** Session title before the turn; a missing title is set from the first prompt, provisionally (`EventData`'s `title`). */
  readonly title?: string;
  /** The model it asks. Only a resumed turn that closes as cancelled may have none: it asks nothing. */
  readonly model?: ModelInfo;
  readonly thinking?: ThinkingLevel;
  /** The turn's choices for plugins (`TurnOptions.plugins`), logged with `turn-start` and handed to each request. */
  readonly plugins?: Readonly<Record<string, unknown>>;
  /** Placed first, in order: a new turn's prompts, or those a resumed turn had not placed yet. */
  readonly prompts: readonly Placed[];
  /** Present when the turn continues one a restart cut off. */
  readonly resume?: TurnResume;
  /** Aborted by `cancel`; handed to every tool execution. */
  readonly signal: AbortSignal;
  readonly inbox: TurnInbox;
  readonly live: LiveTurn;
  /** A prompt's message is in the log. */
  readonly logged: (requestId: string) => void;
  /**
   * True once the agent is closing (the host stopping, or the agent
   * reloading): a turn interrupted then, or failing, is left open in the log,
   * to resume when the agent starts again, rather than closed as cancelled or
   * failed. The turn suspends itself at its next step or tool call, or when
   * `stopping` completes while it waits to ask again. (A host stopping shuts
   * the core's hooks before it closes the agent; a turn that finds them shut
   * is left open the same way.)
   */
  readonly suspended: () => boolean;
  readonly stopping: Effect.Effect<void>;
  /** Runs a wait (before a failed call is asked again) during which the turn holds no slot, then waits for one. */
  readonly idle: <A, E, R>(wait: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * The session's branch as the last turn left it, which a new turn takes, and starts from rather than read it again
   * when the session's leaf is still its end; and where the turn leaves its own when it ends.
   */
  readonly kept?: { readonly take: () => KeptBranch | undefined; readonly keep: (kept: KeptBranch) => void };
  /**
   * The turn ended so, but closing it in the log failed (a full disk): it is left open there, `TurnEnded` unpublished,
   * for the agent to close as it ended when the session is next taken up (`TurnResume.closing`).
   */
  readonly unclosed?: (ended: Ended) => void;
}

/** How `runTurn` returns: the reason it ended, or `suspended` when it was left open in the log to resume. */
export type TurnOutcome = TurnEndReason | "suspended";
/** How a turn ended, as its `turn-end` says. */
export interface Ended {
  readonly reason: TurnEndReason;
  readonly error?: string;
}

/** A new turn: its prompts placed, and a provisional title from the first when the session has none, then its steps. */
const fresh = (turn: Turn) =>
  Effect.gen(function* () {
    const { input, log } = turn;
    for (const prompt of input.prompts) yield* userMessage(turn, prompt);
    const first = input.prompts[0];
    const title = input.title === undefined && first !== undefined ? titleFrom(first.content) : undefined;
    if (title !== undefined) yield* log.append({ type: "title", title, provisional: true });
    return yield* steps(turn, 1);
  });

/**
 * One turn. The log is written as the turn goes: `turn-start`, the user
 * messages, then per step `step-start`, `request`, the assistant `message` (or
 * an `attempt`), tool results, and `step-end`, with steers placed between
 * steps; `turn-end` closes it, unless the agent suspends it to resume later.
 * Every append names the previous one as its parent, so a checkout elsewhere
 * during the turn cannot splice the turn into another branch.
 */
export function runTurn(services: TurnServices, settings: TurnSettings, input: TurnInput): Effect.Effect<TurnOutcome, AgentError> {
  const turn = makeTurn(services, settings, input);
  const { sessionId, turnId } = input;
  return Effect.gen(function* () {
    const resume = input.resume;
    if (resume === undefined) {
      yield* openBranch(turn.log, services.sessions, sessionId, input.kept);
      yield* turn.log.append({
        type: "turn-start",
        turnId,
        model: (yield* asked(turn)).ref,
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
        ...(input.plugins === undefined ? {} : { plugins: input.plugins }),
      });
    }
    yield* services.events.publish(TurnStarted, { sessionId, turnId, requestIds: resume === undefined ? input.prompts.map((prompt) => prompt.requestId) : [] });
    const body = resume !== undefined ? resumed(turn, resume) : fresh(turn);
    return yield* body.pipe(
      Effect.onExit((exit) => finish(turn, exit)),
      Effect.map((ended): TurnOutcome => ended.reason),
      Effect.catchCause((cause) => (turn.state.open ? Effect.succeed("suspended" as const) : Effect.failCause(cause))),
    );
  }).pipe(
    (run) => services.trace("agent.turn", Effect.andThen(Effect.annotateCurrentSpan("turn.resumed", input.resume !== undefined), run)),
    // Every span of its work, the plugins' included, says whose turn it was.
    Effect.annotateSpans({ "session.id": sessionId, "turn.id": turnId }),
  );
}
