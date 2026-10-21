import { Schema } from "effect";
import { LlmRequest, ThinkingLevel, Usage } from "@lemma/llm";
import { rebuildRequest } from "./derive.ts";
import { ledger, parseLedgerFilter, recordSummary } from "./ledger.ts";
import type { SessionEvent } from "./sessions.ts";
import { pluginShares } from "./trajectory.ts";
import type { TrajectoryRequest, TrajectoryStep, TrajectoryTurn } from "./trajectory.ts";

/*
 * What `sessions.records`, `sessions.request`, and `sessions.cache` answer: the Trajectory view's projections of a
 * branch (`trajectory`, `ledger`, `pluginShares`, `cacheReport`) as plain data, so a client reads them as the view
 * and `lemma sessions inspect` show them, without the log's events.
 */

const recordBase = {
  /** The event behind the record. */
  id: Schema.String,
  /** 1-based on the branch. */
  turn: Schema.Number,
  /** Epoch ms when it began. */
  start: Schema.Number,
  /** A word for how it went: `sent`, `initial`, `changed`, the model's stop reason, `ok`, `error`, `running`, `no result`. */
  status: Schema.String,
  /** The record in a line. */
  name: Schema.String,
  /** A failed model call, or a tool run whose result is an error. */
  error: Schema.Boolean,
};

/** A record as the Trajectory view lists it (`recordSummary`): a prompt, a change to the system prompt, a model call, or a tool run. */
export const SessionRecord = Schema.Union([
  Schema.Struct({ ...recordBase, kind: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("system"),
    /** The request's number on the branch, 1-based. */
    request: Schema.Number,
    requestEvent: Schema.String,
    sections: Schema.Array(Schema.Struct({ id: Schema.String, source: Schema.String, chars: Schema.Number, changed: Schema.Boolean })),
    /** Section ids and tool names the request before had and this one has not. */
    removed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("assistant"),
    step: Schema.Number,
    request: Schema.Number,
    requestEvent: Schema.optional(Schema.String),
    /** `<provider>/<model>`. */
    model: Schema.String,
    usage: Usage,
    /** Milliseconds, once it ended. */
    duration: Schema.optional(Schema.Number),
    /** Milliseconds to the first token. */
    ttft: Schema.optional(Schema.Number),
    text: Schema.String,
    toolCalls: Schema.Array(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("tool"),
    step: Schema.Number,
    tool: Schema.String,
    callId: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    duration: Schema.optional(Schema.Number),
    /** Its result as text; absent while it runs, or when its turn ended before it gave one. */
    result: Schema.optional(Schema.String),
  }),
]);
export type SessionRecord = typeof SessionRecord.Type;

/** What `sessions.records` answers: the records, and whether the branch's last turn is still running. */
export const SessionRecords = Schema.Struct({ running: Schema.Boolean, records: Schema.Array(SessionRecord) });
export type SessionRecords = typeof SessionRecords.Type;

/** One request a branch sent the model, by part and by plugin; with `rebuilt`, the request itself (`rebuildRequest`). */
export const RequestView = Schema.Struct({
  /** Its number on the branch, 1-based, as `sessions.records` and `lemma sessions inspect --request` count. */
  number: Schema.Number,
  turn: Schema.Number,
  step: Schema.Number,
  stepId: Schema.String,
  /** The `request` event. */
  eventId: Schema.String,
  at: Schema.Number,
  model: Schema.String,
  thinking: Schema.optional(ThinkingLevel),
  /** `CompositionInfo.id` of the plugin set that built it. */
  composition: Schema.String,
  /** Messages in the model's history for it. */
  messages: Schema.Number,
  /** It declared its system prompt and tools afresh, and why. */
  restart: Schema.optional(Schema.String),
  /** Its system prompt, section by section, each with the plugin that contributed it and whether it changed since the request before. */
  sections: Schema.Array(
    Schema.Struct({ id: Schema.String, source: Schema.String, chars: Schema.Number, changed: Schema.Boolean, text: Schema.optional(Schema.String) }),
  ),
  tools: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String, chars: Schema.Number, changed: Schema.Boolean })),
  /** Section ids and tool names the request before had and this one has not. */
  removed: Schema.Array(Schema.String),
  /** Each plugin's share, the largest first (`pluginShares`). */
  plugins: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      systemChars: Schema.Number,
      toolChars: Schema.Number,
      sections: Schema.Array(Schema.String),
      tools: Schema.Array(Schema.String),
      changed: Schema.Array(Schema.String),
    }),
  ),
  /** The request before it on the branch, by its `request` event. */
  previous: Schema.optional(Schema.String),
  /** The exact request sent, rebuilt from the log. */
  rebuilt: Schema.optional(Schema.Struct(LlmRequest.fields)),
});
export type RequestView = typeof RequestView.Type;

/** What `sessions.cache` answers (`CacheReport`). */
export const SessionCache = Schema.Struct({
  requests: Schema.Number,
  /** Requests after the first that changed the system prompt or the tools. */
  changed: Schema.Number,
  /** For each plugin, the requests in which it changed a part of its own; `(removed)` counts those that dropped one. */
  changedBy: Schema.Record(Schema.String, Schema.Number),
  /** Input tokens over the branch's answers and failed calls, and of them those the provider read from its cache. */
  input: Schema.Number,
  cacheRead: Schema.Number,
});
export type SessionCache = typeof SessionCache.Type;

/** `value` without its `undefined` fields, which JSON cannot carry. */
const defined = <T extends object>(value: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (field !== undefined) out[key] = field;
  return out as T;
};

/** Whether a branch's last turn is still running: one with no turn is not. */
export const lastTurnRunning = (turns: readonly TrajectoryTurn[]): boolean => turns.length > 0 && turns.at(-1)!.end === undefined;

/** The request a branch sent before `request`, if any. */
export const previousRequest = (turns: readonly TrajectoryTurn[], request: TrajectoryRequest): TrajectoryRequest | undefined => {
  const requests = turns.flatMap((turn) => turn.steps.flatMap((step) => (step.request === undefined ? [] : [step.request])));
  return requests[requests.indexOf(request) - 1];
};

/** `turns`' records, those `filter` keeps (the Trajectory view's filter box: `is:error tool:bash -term`). */
export const recordsOf = (turns: readonly TrajectoryTurn[], filter = ""): SessionRecords => {
  const running = lastTurnRunning(turns);
  return {
    running,
    records: ledger(turns)
      .filter(parseLedgerFilter(filter))
      .map((record) => defined(recordSummary(record, running)) as SessionRecord),
  };
};

/** A step by request number, by `<turn>.<step>` (1-based), by step id, or the last step that sent a request. */
export const findStep = (turns: readonly TrajectoryTurn[], selector: string): { turn: TrajectoryTurn; step: TrajectoryStep } | undefined => {
  const all = turns.flatMap((turn) => turn.steps.map((step) => ({ turn, step })));
  const requests = all.filter(({ step }) => step.request !== undefined);
  if (selector === "last") return requests.at(-1);
  if (/^\d+$/.test(selector)) return requests[Number(selector) - 1];
  const position = /^(\d+)\.(\d+)$/.exec(selector);
  if (position !== null) {
    const turn = turns[Number(position[1]) - 1];
    const step = turn?.steps[Number(position[2]) - 1];
    return turn === undefined || step === undefined ? undefined : { turn, step };
  }
  return all.find(({ step }) => step.stepId === selector);
};

/** The request `selector` names on `branch` (see `findStep`), as `sessions.request` answers it; undefined when no step there sent one. */
export const requestOf = (
  branch: readonly SessionEvent[],
  turns: readonly TrajectoryTurn[],
  selector: string,
  options: { readonly rebuilt?: boolean; readonly sessionId?: string } = {},
): RequestView | undefined => {
  const found = findStep(turns, selector);
  const request = found?.step.request;
  if (found === undefined || request === undefined) return undefined;
  const requests = turns.flatMap((turn) => turn.steps.flatMap((step) => (step.request === undefined ? [] : [step.request])));
  const number = requests.indexOf(request) + 1;
  const rebuilt = options.rebuilt === true ? rebuildRequest(branch, request.eventId, options.sessionId) : undefined;
  return defined({
    number,
    turn: found.turn.index,
    step: found.step.index,
    stepId: found.step.stepId,
    eventId: request.eventId,
    at: request.at,
    model: request.model,
    thinking: request.thinking,
    composition: request.composition,
    messages: request.messages,
    restart: request.restart,
    sections: request.sections.map((section) =>
      defined({ id: section.id, source: section.source, chars: section.chars, changed: section.changed, text: section.text }),
    ),
    tools: request.tools.map((tool) => ({ name: tool.name, source: tool.source, chars: tool.chars, changed: tool.changed })),
    removed: request.removed,
    plugins: pluginShares(request),
    previous: previousRequest(turns, request)?.eventId,
    rebuilt,
  });
};
