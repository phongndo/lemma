import { deriveMessages } from "./derive.ts";
import { addUsage, emptyUsage } from "./llm.ts";
import type { AssistantMessage, ThinkingLevel, ToolCall, ToolResultMessage, ToolSpec, Usage, UserMessage } from "./llm.ts";
import type { Contribution, SessionEvent, Timing } from "./sessions.ts";

/**
 * The trajectory of a branch: per turn, per step, what the model was sent,
 * which plugin contributed each part, what came back, and what the tools did.
 * A pure projection of the log, shared by the web app's Trajectory view and
 * `lemma inspect`, so both show the same thing.
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
  readonly system?: string;
  readonly sections: readonly TrajectorySection[];
  readonly tools: readonly TrajectoryTool[];
  /** Section ids and tool names that were contributed before and are gone now. */
  readonly removed: readonly string[];
}

export interface TrajectoryToolRun {
  readonly call: ToolCall;
  /** Absent while the tool runs, or when the turn ended before it produced one. */
  readonly result?: ToolResultMessage;
  readonly eventId?: string;
  readonly timing?: Timing;
  readonly details?: unknown;
}

export interface TrajectoryAttempt {
  readonly eventId: string;
  readonly message: AssistantMessage;
  readonly timing: Timing;
}

export interface TrajectoryStep {
  readonly stepId: string;
  readonly turnId: string;
  /** 1-based within the turn. */
  readonly index: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly request?: TrajectoryRequest;
  readonly response?: { readonly eventId: string; readonly message: AssistantMessage; readonly timing?: Timing };
  readonly attempts: readonly TrajectoryAttempt[];
  readonly tools: readonly TrajectoryToolRun[];
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
  readonly end?: { readonly reason: "done" | "cancelled" | "error" | "max-steps"; readonly error?: string };
  readonly steps: readonly TrajectoryStep[];
  /** Summed over the turn's responses and failed attempts. */
  readonly usage: Usage;
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
  tools: { -readonly [K in keyof TrajectoryToolRun]: TrajectoryToolRun[K] }[];
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
  const turns: MutableTurn[] = [];
  const turnById = new Map<string, MutableTurn>();
  const stepById = new Map<string, MutableStep>();
  // Resolved header state, as `requestState` folds it, plus what the previous request contributed.
  let system: string | undefined;
  let specs: readonly ToolSpec[] = [];
  let previousSections = new Map<string, string | number>();
  let previousTools = new Map<string, string>();

  const stepFor = (turnId: string, stepId: string, at: number): MutableStep | undefined => {
    const existing = stepById.get(stepId);
    if (existing !== undefined) return existing;
    const turn = turnById.get(turnId);
    if (turn === undefined) return undefined;
    const step: MutableStep = { stepId, turnId, index: turn.steps.length + 1, startedAt: at, attempts: [], tools: [] };
    turn.steps.push(step);
    stepById.set(stepId, step);
    return step;
  };

  branch.forEach((event, position) => {
    const data = event.data;
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
        return;
      }
      case "step-start":
        stepFor(data.turnId, data.stepId, event.at);
        return;
      case "step-end": {
        const step = stepById.get(data.stepId);
        if (step !== undefined) step.endedAt = event.at;
        return;
      }
      case "request": {
        if (data.system !== undefined) system = data.system;
        if (data.tools !== undefined) specs = data.tools;
        const texts = splitSystem(system, data.contributions);
        const sectionContributions = data.contributions.filter((contribution) => contribution.kind === "system");
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
        const specByName = new Map(specs.map((spec) => [spec.name, spec]));
        const tools = data.contributions
          .filter((contribution) => contribution.kind === "tool")
          .map((contribution): TrajectoryTool => {
            const spec = specByName.get(contribution.label);
            const signature = spec === undefined ? String(contribution.chars) : JSON.stringify(spec);
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
        previousTools = new Map(tools.map((tool) => [tool.name, tool.spec === undefined ? String(tool.chars) : JSON.stringify(tool.spec)]));
        const step = stepFor(data.turnId, data.stepId, event.at);
        if (step === undefined) return;
        step.request = {
          eventId: event.id,
          at: event.at,
          model: data.model,
          ...(data.thinking === undefined ? {} : { thinking: data.thinking }),
          composition: data.composition,
          messages: deriveMessages(branch.slice(0, position)).length,
          ...(system === undefined ? {} : { system }),
          sections,
          tools,
          removed,
        };
        return;
      }
      case "compaction": {
        // Writing the summary is part of what the turn cost.
        const turn = data.turnId === undefined ? undefined : turnById.get(data.turnId);
        if (turn !== undefined && data.usage !== undefined) turn.usage = addUsage(turn.usage, data.usage);
        return;
      }
      case "attempt": {
        const turn = turnById.get(data.turnId);
        const step = stepFor(data.turnId, data.stepId, event.at);
        if (turn === undefined || step === undefined) return;
        step.attempts.push({ eventId: event.id, message: data.message, timing: data.timing });
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
          step.response = { eventId: event.id, message, ...(data.timing === undefined ? {} : { timing: data.timing }) };
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
          return;
        }
        return;
      }
      default:
        return;
    }
  });
  return turns;
}
