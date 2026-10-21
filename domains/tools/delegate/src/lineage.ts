import { contentText, ThinkingLevel } from "@lemma/llm";
import { Schema } from "effect";
import { branchOf, trajectory } from "@lemma/sessions";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";

/**
 * What the delegate tool reads of logs, pure so it is tested alone: a turn's answer, a thread's model, and where a
 * fork of its finished turns ends.
 */

/** The plugin's id: the source of its notices, and what its choice for an agent's turn is logged under (`depthOf`). */
export const SOURCE = "tools.delegate";

/** The request id an agent's prompt is sent with: its delegating call's, so a call run again places nothing twice. */
export const requestIdOf = (toolCallId: string): string => `tools.delegate/${toolCallId}`;

/** The id of the notice telling a thread an agent finished (`ModelNotice.id`): its delegating call's, once per call. */
export const noticeIdOf = (toolCallId: string): string => toolCallId;

/** A title from a prompt: its first line, cut to 60 characters. */
export const firstLine = (text: string): string => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
};

/** How a turn ended, and its answer: the last reply of the turn that placed `requestId`, on that turn's own branch. */
export const summarize = (info: SessionInfo, events: readonly SessionEvent[], requestId: string) => {
  const placed = events.find((event) => event.data.type === "message" && event.data.requestId === requestId);
  const turnId = placed?.data.type === "message" ? placed.data.turnId : undefined;
  // On that turn's own branch, through its last event: a checkout since may have left it off the session's.
  const last = turnId === undefined ? undefined : events.filter((event) => "turnId" in event.data && event.data.turnId === turnId).at(-1);
  const turns = trajectory(branchOf(events, last?.id ?? info.leaf));
  const turn = turnId === undefined ? undefined : turns.find((candidate) => candidate.turnId === turnId);
  const response = turn?.steps.filter((step) => step.response !== undefined).at(-1)?.response;
  return {
    reason: turn?.end?.reason,
    error: turn?.end?.error,
    answer: response === undefined ? "" : contentText(response.message.content),
  };
};

const isThinking = Schema.is(ThinkingLevel);

/**
 * The model and thinking a thread's last turn ran on (its `turn-start`): what an agent it starts inherits, so it works
 * as the thread does unless its mode or the call says otherwise. Nothing before its first turn.
 */
export const lastTurnOptions = (branch: readonly SessionEvent[]): { readonly model?: string; readonly thinking?: ThinkingLevel } => {
  for (let at = branch.length - 1; at >= 0; at--) {
    const data = branch[at]!.data;
    if (data.type !== "turn-start") continue;
    return { ...(data.model === undefined ? {} : { model: data.model }), ...(data.thinking === undefined ? {} : { thinking: data.thinking }) };
  }
  return {};
};

const isChoice = Schema.is(Schema.Struct({ depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)) }));

/** What an agent's first turn is started with for this plugin (`TurnOptions.plugins`): how deep it is, logged with it. */
export const choiceOf = (depth: number) => ({ depth });

/**
 * How deep a thread is in delegations, from its own log: what its latest turn an agent's prompt started logged
 * (`choiceOf`), 0 when none did. Its own log alone, so a thread above it deleted or unreadable counts it no shallower;
 * a fork's copy of its thread's turns is earlier than its own first turn.
 */
export const depthOf = (branch: readonly SessionEvent[]): number => {
  for (let at = branch.length - 1; at >= 0; at--) {
    const data = branch[at]!.data;
    const choice = data.type === "turn-start" ? data.plugins?.[SOURCE] : undefined;
    if (isChoice(choice)) return choice.depth;
  }
  return 0;
};

/** A mode's thinking, as a turn takes it: one it does not name is none. */
export const thinkingOf = (value: string | undefined): ThinkingLevel | undefined => (isThinking(value) ? value : undefined);

/**
 * Where a fork of a thread's finished turns ends: its last `turn-end` on the branch, so the agent sees every turn that
 * finished and none of the one delegating (still running). Undefined before any turn finished: the agent starts fresh.
 */
export const forkPoint = (branch: readonly SessionEvent[]): string | undefined => {
  for (let at = branch.length - 1; at >= 0; at--) if (branch[at]!.data.type === "turn-end") return branch[at]!.id;
  return undefined;
};

/** An answer cut to `budget` characters, for a notice the model reads: the rest stays in the agent's thread. */
export const bounded = (answer: string, budget: number, sessionId: string): string =>
  answer.length <= budget
    ? answer
    : `${answer.slice(0, budget)}\n\n[${answer.length - budget} characters more: read the rest in the agent's thread, session ${sessionId}]`;
