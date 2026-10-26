import { Clock, Effect } from "effect";
import { CoreClosed } from "@lemma/core";
import { emptyUsage } from "@lemma/llm";
import type { ModelInfo, ToolCall, ToolSpec, Usage } from "@lemma/llm";
import { AgentError } from "../../agent.ts";
import type { ModelIdentity, PartialMessage } from "../live.ts";
import { longestWait, noRetries } from "../retry.ts";
import type { RetryStreak } from "../retry.ts";
import type { Placed, TurnInput, TurnServices, TurnSettings } from "../turn.ts";
import { TurnLog } from "./log.ts";

/*
 * One turn as its parts see it (`runTurn`): what it runs on, what it was given, what it has logged, and what it keeps
 * as it goes. Each part takes the turn and reads or changes what it says it does.
 */

/** What a turn keeps as it goes, besides its branch (`TurnLog`). */
export interface TurnState {
  usage: Usage;
  /** Open step, closed by `step-end`, and the model it asks (none in a turn closing as cancelled after a restart). */
  step: { readonly id: string; readonly model: ModelIdentity | undefined } | undefined;
  /** Output of a model call in flight. */
  partial: PartialMessage | undefined;
  partialStartedAt: number;
  /** Tool calls of the logged assistant message that have no result yet. */
  pending: ToolCall[];
  /** Tool calls a `TOOLS_STARTED` event names: they may have run, whatever becomes of the turn. */
  started: Set<string>;
  /** Failed calls asked again since the model last answered. */
  streak: RetryStreak;
  /** The tool specs the turn last logged (or found logged): unchanged by identity, they need no comparing. */
  loggedSpecs: readonly ToolSpec[] | undefined;
  /** Set as the turn ends (`finish`): it was left open in the log, to resume. */
  open: boolean;
  /** Set by `close`: the turn's `turn-end` is in the log. */
  closed: boolean;
  /** Set as the turn ends: it ended, but not in the log (`TurnInput.unclosed`). */
  unclosed: boolean;
}

export interface Turn {
  readonly services: TurnServices;
  readonly settings: TurnSettings;
  readonly input: TurnInput;
  readonly log: TurnLog;
  readonly state: TurnState;
}

export const makeTurn = (services: TurnServices, settings: TurnSettings, input: TurnInput): Turn => ({
  services,
  settings,
  input,
  log: new TurnLog(services.sessions, input.sessionId),
  state: {
    usage: emptyUsage,
    step: undefined,
    partial: undefined,
    partialStartedAt: 0,
    pending: [],
    started: new Set(),
    streak: noRetries,
    loggedSpecs: undefined,
    open: false,
    closed: false,
    unclosed: false,
  },
});

/**
 * Stops the turn, to be left open, when the core is shutting down. It refuses every hook call from the moment it
 * begins (`Hooks.closed`: hooks fail closed, so that no guard is skipped), before it stops the agent: a turn can go no
 * further, and is not over either.
 */
export const unlessClosing = (turn: Turn): Effect.Effect<void> =>
  Effect.flatMap(turn.services.hooks.closed, (closing) => (closing ? Effect.die(new CoreClosed()) : Effect.void));

/** Where a stopping agent suspends the turn: before a step or a tool call, never inside one. */
export const boundary = (turn: Turn): Effect.Effect<void> => Effect.suspend(() => (turn.input.suspended() ? Effect.interrupt : Effect.void));

/**
 * Waits until epoch `at`, without a slot; a stopping agent suspends the turn instead, and the rest of the wait comes
 * when it resumes. Times in a turn come from Effect's `Clock`, as its waits do, so a test's clock drives both. `at` is
 * wall-clock time, logged: a wall clock set back since (a correction) never makes the wait longer than a retry's
 * could be.
 */
export const waitUntil = (turn: Turn, at: number) =>
  Effect.andThen(
    turn.input.idle(
      Effect.raceFirst(
        Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sleep(Math.min(Math.max(0, at - now), longestWait(turn.settings)))),
        turn.input.stopping,
      ),
    ),
    boundary(turn),
  );

/** A hook's failure as the turn reports it. */
export const hookError = (turn: Turn, hook: string) => (error: { readonly message: string }) =>
  new AgentError({ sessionId: turn.input.sessionId, reason: "Hook", message: `${hook}: ${error.message}`, cause: error });

/** The model a turn that runs steps asks: it has one (see `TurnInput.model`). */
export const asked = (turn: Turn): Effect.Effect<ModelInfo> =>
  Effect.suspend(() =>
    turn.input.model === undefined ? Effect.die(new Error(`Turn ${turn.input.turnId} has no model to ask`)) : Effect.succeed(turn.input.model),
  );

/**
 * Logs a placed prompt and records it placed (`input.logged`, and `also`) in one step a cancel cannot split: a prompt
 * logged but not recorded would be answered as never placed. A person's is a user message; a plugin's (a notice) is
 * a `context` event from it, which a transcript shows as the plugin's, not as something the user typed.
 */
export const userMessage = (turn: Turn, placed: Placed, also: () => void = () => {}) => {
  const { turnId } = turn.input;
  return Effect.uninterruptible(
    Effect.flatMap(Clock.currentTimeMillis, (timestamp) =>
      turn.log.append(
        placed.source === undefined
          ? {
              type: "message",
              message: { role: "user", content: placed.content, timestamp },
              turnId,
              requestId: placed.requestId,
              ...(placed.credit === undefined ? {} : { credit: placed.credit }),
            }
          : {
              type: "context",
              source: placed.source,
              content: placed.content,
              ...(placed.display === undefined ? {} : { display: placed.display }),
              turnId,
              requestId: placed.requestId,
            },
      ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          turn.input.logged(placed.requestId);
          also();
        }),
      ),
    ),
  );
};
