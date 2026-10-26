import { addUsage, emptyUsage } from "@lemma/llm";
import type { AssistantMessage, LlmFailure, ThinkingLevel, ToolCall, ToolResultMessage, ToolSpec, Usage, UserMessage } from "@lemma/llm";
import type { HandlerCredit, ResultCredit } from "@lemma/contracts";
import { createMessageCount } from "./derive.ts";
import type { Contribution, EventData, ProviderAnswer, RequestRestart, SectionUpdate, SessionEvent, Timing, TurnEndReason } from "./sessions.ts";
import { createTurnProjector } from "./turns.ts";
import type { TurnFold } from "./turns.ts";

/**
 * The trajectory of a branch: per turn, per step, what the model was sent,
 * which plugin contributed each part, what came back, and what the tools did.
 * A pure projection of the log, shared by the web app's Trajectory view and
 * `lemma sessions inspect`, so both show the same thing.
 */

export interface TrajectorySection {
  readonly id: string;
  /** Plugin id. */
  readonly source: string;
  readonly chars: number;
  /** Absent only when the logged `system` does not split by the recorded sizes. */
  readonly text?: string;
  /** New or different since the previous request on the branch (always true on the first). */
  readonly changed: boolean;
}

export interface TrajectoryTool {
  readonly name: string;
  readonly source: string;
  readonly chars: number;
  readonly spec?: ToolSpec;
  readonly changed: boolean;
}

export interface TrajectoryRequest {
  /** The `request` event; `rebuildRequest(branch, eventId)` gives the exact request sent. */
  readonly eventId: string;
  readonly at: number;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
  /** `CompositionInfo.id` of the plugin set that built the request. */
  readonly composition: string;
  /** Messages in the model's history for this call. */
  readonly messages: number;
  /** It declared its system prompt and tools afresh, and why; absent when it extends the previous request's prefix. */
  readonly restart?: RequestRestart;
  readonly system?: string;
  readonly sections: readonly TrajectorySection[];
  readonly tools: readonly TrajectoryTool[];
  /** Section ids and tool names that were contributed before and are gone now. */
  readonly removed: readonly string[];
  /** `AgentRequestHook`'s handlers, in the order they ran: each one's own time, and what it changed. */
  readonly handlers?: readonly HandlerCredit[];
}

/** A compaction a step's request made before it was sent: who wrote the summary, and what it replaced. */
export interface TrajectoryCompaction {
  readonly eventId: string;
  readonly at: number;
  /** The plugin that wrote it. */
  readonly source: string;
  readonly tokensBefore: number;
  readonly summary: string;
  readonly usage?: Usage;
}

/** What a step told the model had changed in its system prompt before its request (a `prompt-update` event). */
export interface TrajectoryPromptUpdate {
  readonly eventId: string;
  readonly at: number;
  readonly sections: readonly SectionUpdate[];
  readonly unavailable?: readonly string[];
}

/** What `AgentContinueHook` decided after a step, and why (the `step-end` event's `decision`). */
export type StepDecision = NonNullable<Extract<EventData, { readonly type: "step-end" }>["decision"]>;

export interface TrajectoryToolRun {
  readonly call: ToolCall;
  /** Absent while the tool runs, or when the turn ended before it produced one. */
  readonly result?: ToolResultMessage;
  readonly eventId?: string;
  readonly timing?: Timing;
  readonly details?: unknown;
  /** Who shaped its result: the handlers around it, the guards, a cut. */
  readonly credit?: ResultCredit;
}

export interface TrajectoryAttempt {
  readonly eventId: string;
  readonly message: AssistantMessage;
  readonly timing: Timing;
  /** How the call failed, as the provider's answer was classified. */
  readonly failure?: LlmFailure;
  /** Asked again, and when (see the `attempt` event). */
  readonly retry?: { readonly reason: "failure" | "restart"; readonly attempt: number; readonly at: number };
  /** How the provider answered before the call failed. */
  readonly provider?: ProviderAnswer;
}

export interface TrajectoryStep {
  readonly stepId: string;
  readonly turnId: string;
  /** 1-based within the turn. */
  readonly index: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly request?: TrajectoryRequest;
  readonly response?: {
    readonly eventId: string;
    readonly message: AssistantMessage;
    readonly timing?: Timing;
    /** How the provider answered, before its body. */
    readonly provider?: ProviderAnswer;
  };
  readonly attempts: readonly TrajectoryAttempt[];
  /**
   * The failed attempts of the steps that asked this call before it, in order: a call asked again after a failure
   * is a step of its own, with the same number in the agent's count.
   */
  readonly earlier: readonly TrajectoryAttempt[];
  readonly tools: readonly TrajectoryToolRun[];
  /** Compactions its request made, before it was logged. */
  readonly compactions: readonly TrajectoryCompaction[];
  /** What changed in the system prompt that its request told the model, before it was logged. */
  readonly promptUpdates: readonly TrajectoryPromptUpdate[];
  /** What `AgentContinueHook` decided after it; the turn may still have ended at its step limit, or gone on for steers. */
  readonly decision?: StepDecision;
  /** What the turn did after it, as the log goes on: another step, or its end. Absent while the turn runs. */
  readonly after?: { readonly kind: "step" } | { readonly kind: "end"; readonly reason: TurnEndReason };
}

export interface TrajectoryTurn {
  readonly turnId: string;
  /** 1-based on the branch. */
  readonly index: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly prompt?: UserMessage;
  /**
   * Prompts placed in the turn after `prompt`: queued ones it started with
   * (`after` 0), and steers that joined it after the step numbered `after`.
   */
  readonly steers: readonly { readonly eventId: string; readonly message: UserMessage; readonly at: number; readonly after: number }[];
  readonly end?: { readonly reason: TurnEndReason; readonly error?: string };
  readonly steps: readonly TrajectoryStep[];
  /** Summed over the turn's responses and failed attempts. */
  readonly usage: Usage;
}

/** What one plugin put in a request: its sections and tools, their size, and those new or changed since the request before. */
export interface PluginShare {
  /** Plugin id. */
  readonly source: string;
  readonly systemChars: number;
  readonly toolChars: number;
  /** Its section ids and tool names in the request. */
  readonly sections: readonly string[];
  readonly tools: readonly string[];
  /**
   * Those of them new or different since the previous request on the branch (all of them, on the first): a provider's
   * prompt cache holds up to the first change, so a part that changes costs the cache of everything after it.
   */
  readonly changed: readonly string[];
}

/** Each plugin's share of a request, the largest first. */
export function pluginShares(request: TrajectoryRequest): readonly PluginShare[] {
  const shares = new Map<string, { systemChars: number; toolChars: number; sections: string[]; tools: string[]; changed: string[] }>();
  const shareOf = (source: string) =>
    shares.get(source) ?? shares.set(source, { systemChars: 0, toolChars: 0, sections: [], tools: [], changed: [] }).get(source)!;
  for (const section of request.sections) {
    const share = shareOf(section.source);
    share.systemChars += section.chars;
    share.sections.push(section.id);
    if (section.changed) share.changed.push(section.id);
  }
  for (const tool of request.tools) {
    const share = shareOf(tool.source);
    share.toolChars += tool.chars;
    share.tools.push(tool.name);
    if (tool.changed) share.changed.push(tool.name);
  }
  return [...shares]
    .map(([source, share]) => ({ source, ...share }))
    .sort((a, b) => b.systemChars + b.toolChars - (a.systemChars + a.toolChars) || a.source.localeCompare(b.source));
}

/**
 * How a branch's requests kept the provider's prompt cache. A provider caches a request's prefix, and sends the tools
 * and the system prompt ahead of the history: a request that changes either loses the cache of all that follows,
 * the history included.
 */
export interface CacheReport {
  readonly requests: number;
  /** Requests after the branch's first that changed the system prompt or the tools. */
  readonly changed: number;
  /** For each plugin, the requests in which it changed a part of its own; `(removed)` counts those that dropped one. */
  readonly changedBy: Readonly<Record<string, number>>;
  /** Input tokens over the branch's answers and failed calls, and of them those the provider read from its cache. */
  readonly input: number;
  readonly cacheRead: number;
}

/** `turns`' cache report (`CacheReport`). */
export function cacheReport(turns: readonly TrajectoryTurn[]): CacheReport {
  const requests = turns.flatMap((turn) => turn.steps.flatMap((step) => (step.request === undefined ? [] : [step.request])));
  const changedBy: Record<string, number> = {};
  let changed = 0;
  for (const request of requests.slice(1)) {
    const sources = new Set([...request.sections, ...request.tools].filter((part) => part.changed).map((part) => part.source));
    if (request.removed.length > 0) sources.add("(removed)");
    if (sources.size === 0) continue;
    changed++;
    for (const source of sources) changedBy[source] = (changedBy[source] ?? 0) + 1;
  }
  const input = turns.reduce((sum, turn) => sum + turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite, 0);
  return { requests: requests.length, changed, changedBy, input, cacheRead: turns.reduce((sum, turn) => sum + turn.usage.cacheRead, 0) };
}

/** The latest request among `turns`: the last that a step logged. */
export function latestRequest(turns: readonly TrajectoryTurn[]): TrajectoryRequest | undefined {
  for (const turn of [...turns].reverse()) for (const step of [...turn.steps].reverse()) if (step.request !== undefined) return step.request;
  return undefined;
}

/**
 * `system` split back into its sections by the recorded sizes (see the
 * `request` event). Undefined when the sizes do not add up, e.g. a request
 * written by an agent that joins sections differently.
 */
export function splitSystem(system: string | undefined, contributions: readonly Contribution[]): readonly string[] | undefined {
  const sections = contributions.filter((contribution) => contribution.kind === "system");
  const texts: string[] = [];
  let at = 0;
  let first = true;
  for (const section of sections) {
    if (section.chars === 0) {
      texts.push("");
      continue;
    }
    if (!first) {
      if (system?.slice(at, at + 2) !== "\n\n") return undefined;
      at += 2;
    }
    first = false;
    texts.push(system?.slice(at, at + section.chars) ?? "");
    at += section.chars;
  }
  return at === (system?.length ?? 0) ? texts : undefined;
}

interface MutableStep {
  stepId: string;
  turnId: string;
  index: number;
  startedAt: number;
  endedAt?: number;
  request?: TrajectoryRequest;
  response?: NonNullable<TrajectoryStep["response"]>;
  attempts: TrajectoryAttempt[];
  earlier: TrajectoryAttempt[];
  tools: { -readonly [K in keyof TrajectoryToolRun]: TrajectoryToolRun[K] }[];
  compactions: TrajectoryCompaction[];
  promptUpdates: TrajectoryPromptUpdate[];
  decision?: StepDecision;
  after?: NonNullable<TrajectoryStep["after"]>;
}
interface MutableTurn {
  turnId: string;
  index: number;
  startedAt: number;
  endedAt?: number;
  prompt?: UserMessage;
  steers: { readonly eventId: string; readonly message: UserMessage; readonly at: number; readonly after: number }[];
  end?: NonNullable<TrajectoryTurn["end"]>;
  steps: MutableStep[];
  usage: Usage;
}

/** Turns in branch order. Events outside a turn (titles, compactions) are not part of it. */
export function trajectory(branch: readonly SessionEvent[]): TrajectoryTurn[] {
  const fold = foldTrajectory();
  for (let position = 0; position < branch.length; position++) fold.feed(branch, position);
  return fold.turns;
}

/** A branch's trajectory as it is read, an event at a time: `trajectory` reads a branch whole, and a projector as it grows. */
function foldTrajectory(): TurnFold<MutableTurn> & { readonly turns: MutableTurn[] } {
  const turns: MutableTurn[] = [];
  const turnById = new Map<string, MutableTurn>();
  const stepById = new Map<string, MutableStep>();
  /** The turn each step is in, by its id: an event names a step by its id alone. */
  const turnOfStep = new Map<string, MutableTurn>();
  // Resolved header state, as `requestState` folds it, plus what the previous request contributed.
  let system: string | undefined;
  let contributions: readonly Contribution[] = [];
  let specByName = new Map<string, ToolSpec>();
  // Each spec's JSON, which says whether its tool changed: made once a spec, as requests that declare no tools keep the
  // last ones (stringifying every spec of every request was most of a long branch's time).
  const signatures = new Map<ToolSpec, string>();
  const signatureOf = (spec: ToolSpec): string => {
    let signature = signatures.get(spec);
    if (signature === undefined) {
      signature = JSON.stringify(spec);
      signatures.set(spec, signature);
    }
    return signature;
  };
  let previousSections = new Map<string, string | number>();
  let previousTools = new Map<string, string>();
  // How many messages each request carried, as `deriveMessages` of the branch before it counts them.
  const history = createMessageCount();

  const stepFor = (turnId: string, stepId: string, at: number): MutableStep | undefined => {
    const existing = stepById.get(stepId);
    if (existing !== undefined) return existing;
    const turn = turnById.get(turnId);
    if (turn === undefined) return undefined;
    // A step after one whose call failed and was asked again asks it again: it carries the attempts that failed.
    const previous = turn.steps.at(-1);
    const retried = previous !== undefined && previous.response === undefined && previous.attempts.at(-1)?.retry !== undefined;
    const earlier = retried ? [...previous.earlier, ...previous.attempts] : [];
    const step: MutableStep = {
      stepId,
      turnId,
      index: turn.steps.length + 1,
      startedAt: at,
      attempts: [],
      earlier,
      tools: [],
      compactions: [],
      promptUpdates: [],
    };
    if (previous !== undefined) previous.after = { kind: "step" };
    turn.steps.push(step);
    stepById.set(stepId, step);
    turnOfStep.set(stepId, turn);
    return step;
  };

  const feed = (branch: readonly SessionEvent[], position: number): MutableTurn[] => {
    const event = branch[position]!;
    history.note(branch, position);
    const data = event.data;
    // The turn it names, and the one whose step it names: what it may change.
    const named = (data as { readonly turnId?: string }).turnId;
    const stepId = (data as { readonly stepId?: string }).stepId;
    const changes = [named === undefined ? undefined : turnById.get(named), stepId === undefined ? undefined : turnOfStep.get(stepId)];
    apply(event, data);
    return changes.filter((turn) => turn !== undefined);
  };
  const apply = (event: SessionEvent, data: EventData): void => {
    switch (data.type) {
      case "turn-start": {
        const turn: MutableTurn = { turnId: data.turnId, index: turns.length + 1, startedAt: event.at, steps: [], steers: [], usage: emptyUsage };
        turns.push(turn);
        turnById.set(data.turnId, turn);
        return;
      }
      case "turn-end": {
        const turn = turnById.get(data.turnId);
        if (turn === undefined) return;
        turn.endedAt = event.at;
        turn.end = { reason: data.reason, ...(data.error === undefined ? {} : { error: data.error }) };
        const last = turn.steps.at(-1);
        if (last !== undefined) last.after = { kind: "end", reason: data.reason };
        return;
      }
      case "step-start":
        stepFor(data.turnId, data.stepId, event.at);
        return;
      case "step-end": {
        const step = stepById.get(data.stepId);
        if (step === undefined) return;
        step.endedAt = event.at;
        if (data.decision !== undefined) step.decision = data.decision;
        return;
      }
      case "request": {
        if (data.system !== undefined) system = data.system;
        if (data.tools !== undefined) specByName = new Map(data.tools.map((spec) => [spec.name, spec]));
        if (data.contributions !== undefined) contributions = data.contributions;
        const texts = splitSystem(system, contributions);
        const sectionContributions = contributions.filter((contribution) => contribution.kind === "system");
        const sections = sectionContributions.map((contribution, i): TrajectorySection => {
          const text = texts?.[i];
          const previous = previousSections.get(contribution.label);
          return {
            id: contribution.label,
            source: contribution.source,
            chars: contribution.chars,
            ...(text === undefined ? {} : { text }),
            changed: previous === undefined || previous !== (text ?? contribution.chars),
          };
        });
        const tools = contributions
          .filter((contribution) => contribution.kind === "tool")
          .map((contribution): TrajectoryTool => {
            const spec = specByName.get(contribution.label);
            const signature = spec === undefined ? String(contribution.chars) : signatureOf(spec);
            return {
              name: contribution.label,
              source: contribution.source,
              chars: contribution.chars,
              ...(spec === undefined ? {} : { spec }),
              changed: previousTools.get(contribution.label) !== signature,
            };
          });
        const removed = [
          ...[...previousSections.keys()].filter((id) => !sections.some((section) => section.id === id)),
          ...[...previousTools.keys()].filter((name) => !tools.some((tool) => tool.name === name)),
        ];
        previousSections = new Map(sections.map((section) => [section.id, section.text ?? section.chars]));
        previousTools = new Map(tools.map((tool) => [tool.name, tool.spec === undefined ? String(tool.chars) : signatureOf(tool.spec)]));
        const step = stepFor(data.turnId, data.stepId, event.at);
        if (step === undefined) return;
        step.request = {
          eventId: event.id,
          at: event.at,
          model: data.model,
          ...(data.thinking === undefined ? {} : { thinking: data.thinking }),
          composition: data.composition,
          messages: history.count({ restart: data.restart !== undefined }),
          ...(data.restart === undefined ? {} : { restart: data.restart }),
          ...(system === undefined ? {} : { system }),
          sections,
          tools,
          removed,
          ...(data.handlers === undefined ? {} : { handlers: data.handlers }),
        };
        return;
      }
      case "compaction": {
        // Writing the summary is part of what the turn cost.
        const turn = data.turnId === undefined ? undefined : turnById.get(data.turnId);
        if (turn !== undefined && data.usage !== undefined) turn.usage = addUsage(turn.usage, data.usage);
        // Made by the request of the step open in its turn.
        const open = turn?.steps.at(-1);
        if (open !== undefined && open.endedAt === undefined) {
          open.compactions.push({
            eventId: event.id,
            at: event.at,
            source: data.source,
            tokensBefore: data.tokensBefore,
            summary: data.summary,
            ...(data.usage === undefined ? {} : { usage: data.usage }),
          });
        }
        return;
      }
      case "prompt-update": {
        // Told by the request of the step open in its turn.
        const open = data.turnId === undefined ? undefined : turnById.get(data.turnId)?.steps.at(-1);
        if (open !== undefined && open.endedAt === undefined) {
          open.promptUpdates.push({
            eventId: event.id,
            at: event.at,
            sections: data.sections,
            ...(data.unavailable === undefined ? {} : { unavailable: data.unavailable }),
          });
        }
        return;
      }
      case "attempt": {
        const turn = turnById.get(data.turnId);
        const step = stepFor(data.turnId, data.stepId, event.at);
        if (turn === undefined || step === undefined) return;
        step.attempts.push({
          eventId: event.id,
          message: data.message,
          timing: data.timing,
          ...(data.failure === undefined ? {} : { failure: data.failure }),
          ...(data.retry === undefined ? {} : { retry: data.retry }),
          ...(data.response === undefined ? {} : { provider: data.response }),
        });
        turn.usage = addUsage(turn.usage, data.message.usage);
        return;
      }
      case "message": {
        const message = data.message;
        const turn = data.turnId === undefined ? undefined : turnById.get(data.turnId);
        if (turn === undefined) return;
        if (message.role === "user") {
          if (turn.prompt === undefined) turn.prompt = message;
          else turn.steers.push({ eventId: event.id, message, at: event.at, after: turn.steps.length });
          return;
        }
        if (message.role === "assistant") {
          const step = data.stepId === undefined ? undefined : stepFor(turn.turnId, data.stepId, event.at);
          if (step === undefined) return;
          step.response = {
            eventId: event.id,
            message,
            ...(data.timing === undefined ? {} : { timing: data.timing }),
            ...(data.response === undefined ? {} : { provider: data.response }),
          };
          step.tools = message.content.filter((block): block is ToolCall => block.type === "toolCall").map((call) => ({ call }));
          turn.usage = addUsage(turn.usage, message.usage);
          return;
        }
        // A tool result closes the call with its id, whichever step logged it (a closing turn may log it without one).
        for (const step of turn.steps) {
          const run = step.tools.find((candidate) => candidate.call.id === message.toolCallId);
          if (run === undefined) continue;
          run.result = message;
          run.eventId = event.id;
          if (data.timing !== undefined) run.timing = data.timing;
          if (data.details !== undefined) run.details = data.details;
          if (data.credit !== undefined) run.credit = data.credit;
          return;
        }
        return;
      }
      default:
        return;
    }
  };
  return { turns, feed };
}

/** A turn as it stands, in objects of its own: the fold goes on changing its turns in place. */
const settledTurn = (turn: MutableTurn): TrajectoryTurn => ({
  ...turn,
  steers: [...turn.steers],
  steps: turn.steps.map((step) => ({
    ...step,
    attempts: [...step.attempts],
    earlier: [...step.earlier],
    tools: step.tools.map((run) => ({ ...run })),
    compactions: [...step.compactions],
    promptUpdates: [...step.promptUpdates],
  })),
});

/**
 * `trajectory` for one branch as it grows, as a view following a thread reads it (`createTurnProjector`): given the
 * branch it had with more at the end, it folds in only the events appended, and the turns they did not touch are the
 * objects it returned before (`createLedgerProjector` keeps their records). Unlike `trajectory`'s, the turns it returns
 * never change.
 */
export function createTrajectoryProjector(): (branch: readonly SessionEvent[]) => readonly TrajectoryTurn[] {
  return createTurnProjector(foldTrajectory, settledTurn);
}
