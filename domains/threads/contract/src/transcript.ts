import { addUsage, emptyUsage } from "@lemma/llm";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage, Usage } from "@lemma/llm";
import { createTurnProjector } from "@lemma/sessions";
import type { SessionEvent, Timing, TurnEndReason, TurnFold } from "@lemma/sessions";
import { endingText } from "./fold.ts";

/**
 * Projection of a session branch into what the chat transcript renders: its turns, folded as the trajectory's are
 * (`createTurnProjector` in `@lemma/sessions`).
 *
 * Object identity is part of the contract: as the log grows, `createProjector` keeps each turn, item, and block the
 * events appended did not change, so keyed lists in the UI keep their DOM (and expanded/collapsed state). A branch that
 * carries on the last one it was given (the same events, more at the end) costs what was appended, not the branch.
 */

export interface ToolResultView {
  readonly eventId: string;
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError: boolean;
  readonly details?: unknown;
  readonly timing?: Timing;
  /**
   * The person stopped the turn while the call ran or before it ran: an error in the last step of a turn that ended
   * cancelled, which the stop cut short or answered unrun. Not a failure of the tool's.
   */
  readonly stopped?: true;
}

export type Block =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | {
      readonly kind: "thinking";
      readonly key: string;
      /** Where in the message's content it starts: one thought may join several adjacent parts. */
      readonly index: number;
      readonly text: string;
      readonly redacted: boolean;
    }
  | { readonly kind: "tool"; readonly key: string; readonly call: ToolCall; readonly result?: ToolResultView };

export interface UserItem {
  readonly kind: "user";
  readonly id: string;
  readonly at: number;
  readonly content: readonly (TextContent | ImageContent)[];
  /** A steer: placed in its turn after the work began, between two steps. */
  readonly steer?: true;
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly id: string;
  readonly at: number;
  readonly stepId?: string;
  readonly message: AssistantMessage;
  readonly blocks: readonly Block[];
  readonly timing?: Timing;
}

/** A failed, cancelled, or retried model call; never model-visible. */
export interface AttemptItem {
  readonly kind: "attempt";
  readonly id: string;
  readonly at: number;
  readonly stepId: string;
  readonly message: AssistantMessage;
  readonly blocks: readonly Block[];
  readonly timing: Timing;
}

/** A tool result whose call is not on the branch (should not happen; shown rather than hidden). */
export interface OrphanResultItem {
  readonly kind: "orphan-result";
  readonly id: string;
  readonly at: number;
  readonly message: ToolResultMessage;
}

export interface CompactionItem {
  readonly kind: "compaction";
  readonly id: string;
  readonly at: number;
  readonly summary: string;
  readonly tokensBefore: number;
}

/** What a plugin told the model (a `context` event): its source, and what a transcript shows of it. */
export interface ContextItem {
  readonly kind: "context";
  readonly id: string;
  readonly at: number;
  readonly source: string;
  /** The event's `display`, else its content's text. */
  readonly text: string;
  /** Its content's text: what the model read. */
  readonly content: string;
  readonly display?: string | undefined;
  /** Its submission's id, when the agent placed it for the plugin (`ModelNotice`). */
  readonly requestId?: string | undefined;
}

export type Item = UserItem | AssistantItem | AttemptItem | OrphanResultItem | CompactionItem | ContextItem;

export interface TurnView {
  /** `turnId`, or the first event id for history outside a turn. */
  readonly key: string;
  readonly turnId?: string;
  readonly items: readonly Item[];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly end?: { readonly reason: TurnEndReason; readonly error?: string };
  /** Summed over assistant messages and failed attempts (both cost tokens). */
  readonly usage: Usage;
  /** Distinct `provider/model` used by the turn's model calls, in order. */
  readonly models: readonly string[];
  readonly steps: number;
  readonly firstTokenMs?: number;
}

interface Transcript {
  readonly turns: readonly TurnView[];
  readonly title?: string;
}

/** A turn as it is folded: its view's fields, and what the fold reads of it. */
interface MutableTurn {
  key: string;
  turnId: string | undefined;
  items: Item[];
  startedAt: number;
  endedAt: number | undefined;
  end: { reason: TurnEndReason; error?: string } | undefined;
  usage: Usage;
  models: string[];
  steps: number;
  firstTokenMs: number | undefined;
  hasUser: boolean;
  hasOutput: boolean;
}

const newTurn = (key: string, at: number, turnId?: string): MutableTurn => ({
  key,
  turnId,
  items: [],
  startedAt: at,
  endedAt: undefined,
  end: undefined,
  usage: emptyUsage,
  models: [],
  steps: 0,
  firstTokenMs: undefined,
  hasUser: false,
  hasOutput: false,
});

const toolBlock = (key: string, call: ToolCall, result: ToolResultView | undefined): Block =>
  result === undefined ? { kind: "tool", key, call } : { kind: "tool", key, call, result };

/**
 * A message's content as blocks. Adjacent thinking parts read as one thought:
 * a model may return its reasoning as several items in a row (each kept in
 * the log, as each is replayed on its own), which say one thing to a reader.
 */
const blocksOf = (eventId: string, message: AssistantMessage, results: ReadonlyMap<string, ToolResultView>): Block[] => {
  const blocks: Block[] = [];
  const content = message.content;
  for (let index = 0; index < content.length; index++) {
    const part = content[index]!;
    const key = `${eventId}:${index}`;
    switch (part.type) {
      case "text":
        blocks.push({ kind: "text", key, text: part.text });
        break;
      case "thinking": {
        let end = index + 1;
        while (content[end]?.type === "thinking") end++;
        const run = content.slice(index, end) as Extract<AssistantMessage["content"][number], { type: "thinking" }>[];
        blocks.push({
          kind: "thinking",
          key,
          index,
          text: run
            .map((thought) => thought.thinking.trim())
            .filter(Boolean)
            .join("\n\n"),
          redacted: run.every((thought) => thought.redacted === true),
        });
        index = end - 1;
        break;
      }
      case "toolCall":
        blocks.push(toolBlock(key, part, results.get(part.id)));
        break;
    }
  }
  return blocks;
};

/** The transcript's fold of a branch, and the title it ends with. */
interface TranscriptFold extends TurnFold<MutableTurn> {
  readonly title: string | undefined;
}

/**
 * Folds a branch (`whole`, then what is appended to it) into the transcript's turns. A call shows its result, the last
 * logged for it, whether logged before or after it; and an error in the last step of a turn the person stopped shows as
 * the stop's. A result logged, a step started, or a stop changes the items that show the results it concerns, in place;
 * a result whose call is not on the branch shows on its own, and the call made after it has the branch folded afresh.
 */
const foldTranscript = (whole: readonly SessionEvent[]): TranscriptFold => {
  const turns: MutableTurn[] = [];
  let current: MutableTurn | undefined;
  let title: string | undefined;
  /** The calls made on the branch: those of `whole`, then each made as the fold is fed. */
  const callIds = new Set<string>();
  for (const { data } of whole)
    if (data.type === "message" && data.message.role === "assistant")
      for (const part of data.message.content) if (part.type === "toolCall") callIds.add(part.id);
  /** Calls whose result shows on its own: one made later is folded afresh, without it. */
  const orphans = new Set<string>();
  /** Each turn's last step, and the turns the person stopped: what makes a result the stop's (`ToolResultView.stopped`). */
  const lastSteps = new Map<string, string>();
  const stoppedTurns = new Set<string>();
  /** Each call's result as shown, the last logged for it, and the event it is. */
  const results = new Map<string, ToolResultView>();
  const resultEvents = new Map<string, SessionEvent>();
  /** The calls whose results were logged in each turn, by its id: what its stop or a new step changes. */
  const resultsIn = new Map<string, string[]>();
  /** Where each call shows: the turns, and the place in each, of the responses that made it. */
  const holders = new Map<string, { readonly turn: MutableTurn; readonly index: number }[]>();

  /** Whether a result is the stop's: an error in the last step of a turn the person stopped. */
  const isStopped = (event: SessionEvent): boolean => {
    const data = event.data;
    if (data.type !== "message" || data.message.role !== "toolResult") return false;
    return (
      data.message.isError &&
      data.turnId !== undefined &&
      stoppedTurns.has(data.turnId) &&
      data.stepId !== undefined &&
      data.stepId === lastSteps.get(data.turnId)
    );
  };

  /** Shows `id`'s result as it now is, in each response that made the call, unless it shows so already. */
  const showResult = (id: string, changed: Set<MutableTurn>): void => {
    const event = resultEvents.get(id)!;
    const data = event.data as Extract<SessionEvent["data"], { type: "message" }>;
    const message = data.message as ToolResultMessage;
    const stopped = isStopped(event);
    const shown = results.get(id);
    if (shown !== undefined && shown.eventId === event.id && (shown.stopped === true) === stopped) return;
    const result: ToolResultView = {
      eventId: event.id,
      content: message.content,
      isError: message.isError,
      ...(data.details === undefined ? {} : { details: data.details }),
      ...(data.timing === undefined ? {} : { timing: data.timing }),
      ...(stopped ? { stopped: true as const } : {}),
    };
    results.set(id, result);
    for (const { turn, index } of holders.get(id) ?? []) {
      const item = turn.items[index] as AssistantItem;
      turn.items[index] = {
        ...item,
        blocks: item.blocks.map((block) => (block.kind === "tool" && block.call.id === id ? toolBlock(block.key, block.call, result) : block)),
      };
      changed.add(turn);
    }
  };
  /** A stop or a new step in `turnId`: its results show as they now are. */
  const restop = (turnId: string, changed: Set<MutableTurn>): void => {
    for (const id of resultsIn.get(turnId) ?? []) showResult(id, changed);
  };

  const ensure = (event: SessionEvent): MutableTurn => {
    if (current === undefined) {
      current = newTurn(event.id, event.at);
      turns.push(current);
    }
    return current;
  };
  const start = (event: SessionEvent, turnId?: string): MutableTurn => {
    current = newTurn(turnId ?? event.id, event.at, turnId);
    turns.push(current);
    return current;
  };
  const recordCall = (turn: MutableTurn, message: AssistantMessage, timing: Timing | undefined) => {
    turn.usage = addUsage(turn.usage, message.usage);
    const model = `${message.provider}/${message.model}`;
    if (!turn.models.includes(model)) turn.models.push(model);
    turn.steps++;
    if (turn.firstTokenMs === undefined && timing?.firstTokenAt !== undefined) turn.firstTokenMs = timing.firstTokenAt - timing.startedAt;
    turn.hasOutput = true;
  };

  const feed = (branch: readonly SessionEvent[], position: number): Set<MutableTurn> | "afresh" => {
    const event = branch[position]!;
    const data = event.data;
    const changed = new Set<MutableTurn>();
    switch (data.type) {
      case "turn-start": {
        // The user message may be logged before or after turn-start; attach to a turn holding only that message.
        if (current !== undefined && current.turnId === undefined && current.hasUser && !current.hasOutput) {
          current.turnId = data.turnId;
          current.key = data.turnId;
          changed.add(current);
        } else {
          start(event, data.turnId);
        }
        break;
      }
      case "turn-end": {
        const turn = current !== undefined && current.turnId === data.turnId ? current : turns.find((t) => t.turnId === data.turnId);
        if (turn !== undefined) {
          turn.end = { reason: data.reason, ...(data.error === undefined ? {} : { error: data.error }) };
          turn.endedAt = event.at;
          changed.add(turn);
        }
        if (data.reason === "cancelled") {
          stoppedTurns.add(data.turnId);
          restop(data.turnId, changed);
        }
        break;
      }
      case "step-start":
        lastSteps.set(data.turnId, data.stepId);
        restop(data.turnId, changed);
        break;
      case "message": {
        const message = data.message;
        if (message.role === "user") {
          // A steer: a prompt placed in the running turn between its steps, shown where it joined.
          if (current !== undefined && current.hasUser && data.turnId !== undefined && current.turnId === data.turnId) {
            const steer = current.hasOutput;
            current.items.push({ kind: "user", id: event.id, at: event.at, content: message.content, ...(steer ? { steer } : {}) });
            changed.add(current);
            break;
          }
          const turn =
            current !== undefined &&
            !current.hasUser &&
            !current.hasOutput &&
            (current.turnId === undefined || current.turnId === data.turnId || data.turnId === undefined)
              ? current
              : start(event, data.turnId);
          turn.hasUser = true;
          turn.items.push({ kind: "user", id: event.id, at: event.at, content: message.content });
          changed.add(turn);
        } else if (message.role === "assistant") {
          const calls = new Set(message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])));
          if ([...calls].some((id) => orphans.has(id))) return "afresh";
          const turn = ensure(event);
          for (const id of calls) {
            callIds.add(id);
            holders.set(id, [...(holders.get(id) ?? []), { turn, index: turn.items.length }]);
          }
          turn.items.push({
            kind: "assistant",
            id: event.id,
            at: event.at,
            message,
            blocks: blocksOf(event.id, message, results),
            ...(data.stepId === undefined ? {} : { stepId: data.stepId }),
            ...(data.timing === undefined ? {} : { timing: data.timing }),
          });
          recordCall(turn, message, data.timing);
          changed.add(turn);
        } else {
          const id = message.toolCallId;
          resultEvents.set(id, event);
          if (data.turnId !== undefined) resultsIn.set(data.turnId, [...(resultsIn.get(data.turnId) ?? []), id]);
          if (!callIds.has(id)) {
            const turn = ensure(event);
            turn.items.push({ kind: "orphan-result", id: event.id, at: event.at, message });
            orphans.add(id);
            changed.add(turn);
          }
          showResult(id, changed);
        }
        break;
      }
      case "attempt": {
        const turn = ensure(event);
        turn.items.push({
          kind: "attempt",
          id: event.id,
          at: event.at,
          stepId: data.stepId,
          message: data.message,
          blocks: blocksOf(event.id, data.message, new Map()),
          timing: data.timing,
        });
        recordCall(turn, data.message, data.timing);
        turn.steps--; // A retried call is not a step of its own.
        changed.add(turn);
        break;
      }
      case "compaction": {
        const turn = ensure(event);
        // Writing the summary is part of what the turn cost.
        if (data.usage !== undefined) turn.usage = addUsage(turn.usage, data.usage);
        turn.items.push({ kind: "compaction", id: event.id, at: event.at, summary: data.summary, tokensBefore: data.tokensBefore });
        changed.add(turn);
        break;
      }
      case "context": {
        const turn = ensure(event);
        const content = data.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
        turn.items.push({
          kind: "context",
          id: event.id,
          at: event.at,
          source: data.source,
          text: data.display ?? content,
          content,
          ...(data.display === undefined ? {} : { display: data.display }),
          ...(data.requestId === undefined ? {} : { requestId: data.requestId }),
        });
        changed.add(turn);
        break;
      }
      case "title":
        title = data.title;
        break;
      default:
        break;
    }
    return changed;
  };
  return {
    turns,
    feed,
    get title() {
      return title;
    },
  };
};

/** A turn as the transcript shows it: the view it had while it shows the same (its items by identity). */
const viewOf = (turn: MutableTurn, before: TurnView | undefined): TurnView =>
  before !== undefined &&
  before.key === turn.key &&
  before.turnId === turn.turnId &&
  before.endedAt === turn.endedAt &&
  before.end?.reason === turn.end?.reason &&
  before.end?.error === turn.end?.error &&
  before.steps === turn.steps &&
  before.items.length === turn.items.length &&
  turn.items.every((item, at) => item === before.items[at])
    ? before
    : {
        key: turn.key,
        ...(turn.turnId === undefined ? {} : { turnId: turn.turnId }),
        items: [...turn.items],
        startedAt: turn.startedAt,
        ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
        ...(turn.end === undefined ? {} : { end: turn.end }),
        usage: turn.usage,
        models: [...turn.models],
        steps: turn.steps,
        ...(turn.firstTokenMs === undefined ? {} : { firstTokenMs: turn.firstTokenMs }),
      };

/** A stateful projector for one session view; keeps what is unchanged between calls (above). */
export const createProjector = (): ((branch: readonly SessionEvent[]) => Transcript) => {
  let fold: TranscriptFold | undefined;
  const project = createTurnProjector((branch) => (fold = foldTranscript(branch)), viewOf);
  let last: Transcript | undefined;
  return (branch) => {
    const turns = project(branch);
    const title = fold!.title;
    if (last?.turns !== turns || last.title !== title) last = { turns, ...(title === undefined ? {} : { title }) };
    return last;
  };
};

/**
 * Where the thread goes back to for each prompt to be written again ("Edit from here", `Threads.checkout`): the event
 * before the turn the prompt opened, by the prompt's event id. A steer, a prompt placed with the one that opened its
 * turn, and the thread's first prompt (nothing comes before it) have none.
 */
export const promptBases = (branch: readonly SessionEvent[]): ReadonlyMap<string, string> => {
  const bases = new Map<string, string>();
  branch.forEach((event, index) => {
    const data = event.data;
    if (data.type !== "message" || data.message.role !== "user") return;
    const previous = branch[index - 1]?.data;
    const opens = previous?.type === "turn-start" && previous.turnId === data.turnId;
    // A prompt in an older log has no turn id, and comes before its turn's start.
    const start = opens ? index - 1 : data.turnId === undefined ? index : 0;
    if (start > 0) bases.set(event.id, branch[start - 1]!.id);
  });
  return bases;
};

/** Tool calls in a transcript that have no result yet. */
export const pendingToolCalls = (transcript: Transcript): Set<string> => {
  const pending = new Set<string>();
  for (const turn of transcript.turns) {
    for (const item of turn.items) {
      if (item.kind !== "assistant") continue;
      for (const block of item.blocks) if (block.kind === "tool" && block.result === undefined) pending.add(block.call.id);
    }
  }
  return pending;
};

/** A prompt on the chat's prompt rail: every one the chat shows, a turn's first and each steer, alike. */
export interface PromptMark {
  /**
   * Where it is (`data-mark` in the transcript): the turn's key for the prompt that starts it, `<turn key>:<item id>`
   * for a steer, `steer:<request id>` for one not yet placed.
   */
  readonly key: string;
  /** The prompt's text, whitespace collapsed; a stand-in when it is only images. */
  readonly prompt: string;
  /**
   * What answered it: the text the turn's assistant ends with before the next prompt of the turn (after the last, the
   * turn's answer, `answerText`), markdown as written; empty until there is one.
   */
  readonly reply: string;
}

const flatten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One mark per turn that starts with a prompt: what the chat's prompt rail shows and jumps to. */
export const promptMarks = (turns: readonly TurnView[]): PromptMark[] =>
  turns.flatMap((turn) => {
    const at = turn.items.flatMap((item, index) => (item.kind === "user" ? [index] : []));
    return at.map((start, nth): PromptMark => {
      const user = turn.items[start] as UserItem;
      const reply = endingText(turn.items.slice(start + 1, at[nth + 1]));
      return { key: nth === 0 ? turn.key : markKey(turn, user), prompt: promptText(user.content), reply };
    });
  });

/** A prompt as the rail says it: its text, whitespace collapsed; a stand-in when it is only images. */
export const promptText = (content: readonly (TextContent | ImageContent)[]): string => {
  const text = content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  const images = content.filter((part) => part.type === "image").length;
  return flatten(text, 200) || (images === 1 ? "Image" : `${images} images`);
};

/** A steer's mark key (`PromptMark.key`): the turn's, and the steer's id. */
export const markKey = (turn: TurnView, steer: UserItem): string => `${turn.key}:${steer.id}`;
