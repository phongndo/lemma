import { addUsage, emptyUsage } from "@lemma/contracts";
import type { AssistantMessage, EventData, SessionEvent, ThinkingLevel, ToolCall, ToolResultMessage, Usage } from "@lemma/contracts";

/** The error of an `attempt` logged for a model call that a host restart cut off; a resumed turn retries it. */
export const INTERRUPTED_CALL = "Interrupted: the host stopped during this model call";

/**
 * The `custom` event a turn logs (synced) before it runs tool calls, naming
 * them: a call a restart cut off without a result was running only if one
 * names it, so the rest run when the turn resumes rather than being reported
 * as interrupted.
 */
export const TOOLS_STARTED = "agent.started";
/** The `custom` event a resumed turn logs first. */
export const RESUMED = "agent.resumed";

type Attempt = Extract<EventData, { type: "attempt" }>;

/** The call is asked again: a failure the turn retries, or one a restart cut off (logs from before `retry` carry only its error). */
const retried = (attempt: Attempt): boolean => attempt.retry !== undefined || attempt.message.errorMessage === INTERRUPTED_CALL;

/** The outcome of a step: what the model said, and the results of the tools it called. */
export interface StepOutcome {
  readonly message: AssistantMessage;
  readonly results: readonly ToolResultMessage[];
}

/** Where an open turn stopped. */
export type ResumePoint =
  /**
   * Between steps: after the last closed step's `outcome` (with `steered`, prompts placed after it, which the model
   * has yet to answer), or ready for a step (before the first, or after one whose call is to be asked again).
   */
  | { readonly kind: "between"; readonly outcome?: StepOutcome; readonly steered: boolean }
  /** A step was begun but nothing was asked of the model yet. */
  | { readonly kind: "before-request"; readonly stepId: string }
  /** The request is logged but its answer is not: the call was cut off, or failed to be asked again (`logged` as an attempt already). */
  | { readonly kind: "model"; readonly stepId: string; readonly logged: boolean }
  /**
   * The answer is logged; `pending` are its tool calls without a result, and `started` those of them that may have
   * begun running (all of them, in a log that does not say).
   */
  | {
      readonly kind: "tools";
      readonly stepId: string;
      readonly message: AssistantMessage;
      readonly results: readonly ToolResultMessage[];
      readonly pending: readonly ToolCall[];
      readonly started: ReadonlySet<string>;
    }
  /** The call failed and the turn was closing (its step `closed` already, or not): it ends the way it was ending. */
  | { readonly kind: "failed"; readonly stepId: string; readonly attempt: AssistantMessage; readonly closed: boolean };

export interface ResumePlan {
  /** The turn's last event: appends continue from it. */
  readonly lastId: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  /** What the turn has cost so far. */
  readonly usage: Usage;
  /** Steps counted so far: those begun, but for those whose failed call is asked again (they do not count). */
  readonly steps: number;
  /** `requestId`s of the prompts placed in the turn. */
  readonly placed: ReadonlySet<string>;
  /**
   * The failures asked again since the model last answered: how many in a row, whether the last was an `overflow`
   * (the next request is shortened), whether any was (it is not asked again twice), and `at`, when the next call was due.
   */
  readonly retry?: { readonly attempts: number; readonly overflow: boolean; readonly overflowed: boolean; readonly at: number };
  readonly at: ResumePoint;
}

export type Resume = { readonly kind: "not-started" } | { readonly kind: "ended" } | { readonly kind: "open"; readonly plan: ResumePlan };

/** Whether the turn logged `event`: it names the turn (an agent's `custom` event, in its data). */
const ownedBy = (event: SessionEvent, turnId: string): boolean => {
  const data = event.data;
  if ("turnId" in data && data.turnId === turnId) return true;
  return data.type === "custom" && data.kind.startsWith("agent.") && (data.data as { readonly turnId?: unknown } | null)?.turnId === turnId;
};

/**
 * The turn's own events: from its `turn-start` to the last event that names
 * the turn, by parents. Every append in a turn names the previous one as its
 * parent, so these lead back to the start past anything hung off the turn
 * meanwhile, however long: a rename appends its `title` at the session's
 * leaf, and several make a chain. Only a `title` the turn logs itself after
 * its first prompt names no turn; continuing past it leaves it on a side
 * branch, which is harmless, as titles are not model-visible.
 */
const turnPath = (events: readonly SessionEvent[], start: SessionEvent, turnId: string): readonly SessionEvent[] => {
  const byId = new Map(events.map((event) => [event.id, event]));
  let last = start;
  for (const event of events) if (event.seq > last.seq && ownedBy(event, turnId)) last = event;
  const path: SessionEvent[] = [];
  for (let at: SessionEvent | undefined = last; at !== undefined; at = at.parent === null ? undefined : byId.get(at.parent)) {
    path.push(at);
    if (at === start) return path.reverse();
  }
  // Not reached from the start (a log written otherwise): the start alone is what is known.
  return [start];
};

/**
 * Where the turn `turnId` stopped, read from the session's events (file
 * order). `marked`: the turn logs `TOOLS_STARTED` before it runs tool calls,
 * so a call none names never ran.
 */
export function planResume(events: readonly SessionEvent[], turnId: string, marked = true): Resume {
  const start = events.find((event) => event.data.type === "turn-start" && event.data.turnId === turnId);
  if (start === undefined) return { kind: "not-started" };
  if (events.some((event) => event.data.type === "turn-end" && event.data.turnId === turnId)) return { kind: "ended" };

  let usage = emptyUsage;
  let steps = 0;
  let model = start.data.type === "turn-start" ? start.data.model : undefined;
  let thinking = start.data.type === "turn-start" ? start.data.thinking : undefined;
  let requestModel: string | undefined;
  let requestThinking: ThinkingLevel | undefined;
  const placed = new Set<string>();
  type Open = {
    stepId: string;
    requested: boolean;
    message?: AssistantMessage;
    results: ToolResultMessage[];
    attempt?: Attempt;
    /** Tool calls a `TOOLS_STARTED` event names; undefined while none does. */
    started?: Set<string>;
  };
  let open: Open | undefined;
  /** The last step closed, and whether prompts were placed after it. */
  let closed: Open | undefined;
  let steered = false;
  let retry: { attempts: number; overflow: boolean; overflowed: boolean; at: number } | undefined;

  const path = turnPath(events, start, turnId);
  for (const event of path) {
    const data = event.data;
    switch (data.type) {
      case "step-start":
        steps++;
        open = { stepId: data.stepId, requested: false, results: [] };
        break;
      case "request":
        requestModel = data.model;
        requestThinking = data.thinking;
        if (open !== undefined) open.requested = true;
        break;
      case "message":
        if (data.message.role === "user") {
          if (data.requestId !== undefined) placed.add(data.requestId);
          if (closed !== undefined && open === undefined) steered = true;
        } else if (data.message.role === "assistant") {
          usage = addUsage(usage, data.message.usage);
          retry = undefined;
          if (open !== undefined) open.message = data.message;
        } else if (open !== undefined) {
          open.results.push(data.message);
        }
        break;
      case "attempt":
        usage = addUsage(usage, data.message.usage);
        if (open !== undefined) open.attempt = data;
        if (data.retry?.reason === "failure") {
          // A call asked again after a failure takes no step of its own.
          steps--;
          const overflow = data.failure?.kind === "overflow";
          retry = { attempts: data.retry.attempt, overflow, overflowed: overflow || retry?.overflowed === true, at: data.retry.at };
        }
        break;
      case "custom":
        if (data.kind === TOOLS_STARTED && open !== undefined) {
          const ids = (data.data as { readonly toolCallIds?: unknown } | null)?.toolCallIds;
          open.started ??= new Set();
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") open.started.add(id);
        }
        break;
      case "step-end":
        if (open !== undefined) closed = open;
        open = undefined;
        steered = false;
        break;
      case "compaction":
        if (data.turnId === turnId && data.usage !== undefined) usage = addUsage(usage, data.usage);
        break;
    }
  }

  const at = ((): ResumePoint => {
    if (open === undefined) {
      if (closed?.message !== undefined) return { kind: "between", outcome: { message: closed.message, results: closed.results }, steered };
      // A step closed on a failed call: the turn was closing, unless the call is to be asked again.
      if (closed?.attempt !== undefined && !retried(closed.attempt)) {
        return { kind: "failed", stepId: closed.stepId, attempt: closed.attempt.message, closed: true };
      }
      return { kind: "between", steered: false };
    }
    const { stepId } = open;
    // A call whose attempt is logged already, to be asked again, is retried like one that was never answered.
    if (open.attempt !== undefined && open.message === undefined) {
      return retried(open.attempt) ? { kind: "model", stepId, logged: true } : { kind: "failed", stepId, attempt: open.attempt.message, closed: false };
    }
    if (open.message !== undefined) {
      const answered = new Set(open.results.map((result) => result.toolCallId));
      const pending = open.message.content.filter((block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id));
      // In a turn that does not log `TOOLS_STARTED` (an older agent's), any of its calls may have run.
      const started = open.started ?? new Set(marked ? [] : pending.map((call) => call.id));
      return { kind: "tools", stepId, message: open.message, results: open.results, pending, started };
    }
    return open.requested ? { kind: "model", stepId, logged: false } : { kind: "before-request", stepId };
  })();

  model ??= requestModel;
  thinking ??= requestThinking;
  return {
    kind: "open",
    plan: {
      lastId: path[path.length - 1]!.id,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      usage,
      steps,
      placed,
      ...(retry === undefined ? {} : { retry }),
      at,
    },
  };
}
