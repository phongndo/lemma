import { addUsage, emptyUsage } from "@lemma/llm";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage, Usage } from "@lemma/llm";
import type { SessionEvent, Timing, TurnEndReason } from "@lemma/sessions";
import { endingText } from "./fold.ts";

/**
 * Projection of a session branch into what the chat transcript renders.
 * Pure and view-agnostic, so a future Trajectory view can reuse the turns.
 *
 * Object identity is part of the contract: `createProjector` reuses unchanged
 * items and blocks across calls so keyed lists in the UI keep their DOM (and
 * expanded/collapsed state) while the log grows.
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

/** What a cached block or item holding `result` changes with: which result it is, and whether the stop caused it. */
const resultSignature = (result: ToolResultView | undefined): string => (result === undefined ? "" : `${result.eventId}${result.stopped ? ":stopped" : ""}`);

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

export type Item = UserItem | AssistantItem | AttemptItem | OrphanResultItem | CompactionItem;

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

interface Cache {
  readonly get: <T>(key: string, signature: string, make: () => T) => T;
  readonly sweep: () => void;
}

const makeCache = (): Cache => {
  let current = new Map<string, { signature: string; value: unknown }>();
  let next = new Map<string, { signature: string; value: unknown }>();
  return {
    get: <T>(key: string, signature: string, make: () => T): T => {
      const hit = current.get(key) ?? next.get(key);
      const entry = hit !== undefined && hit.signature === signature ? hit : { signature, value: make() };
      next.set(key, entry);
      return entry.value as T;
    },
    sweep: () => {
      current = next;
      next = new Map();
    },
  };
};

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
/** A number unique to `value` for as long as it lives; lets signatures compare identities. */
const identity = (value: object): number => {
  let id = identities.get(value);
  if (id === undefined) identities.set(value, (id = ++nextIdentity));
  return id;
};

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

/**
 * A message's content as blocks. Adjacent thinking parts read as one thought:
 * a model may return its reasoning as several items in a row (each kept in
 * the log, as each is replayed on its own), which say one thing to a reader.
 */
const blocksOf = (cache: Cache, eventId: string, message: AssistantMessage, results: ReadonlyMap<string, ToolResultView>): Block[] => {
  const blocks: Block[] = [];
  const content = message.content;
  for (let index = 0; index < content.length; index++) {
    const part = content[index]!;
    const key = `${eventId}:${index}`;
    switch (part.type) {
      case "text":
        blocks.push(cache.get(key, "", () => ({ kind: "text", key, text: part.text })));
        break;
      case "thinking": {
        let end = index + 1;
        while (content[end]?.type === "thinking") end++;
        const run = content.slice(index, end) as Extract<AssistantMessage["content"][number], { type: "thinking" }>[];
        blocks.push(
          cache.get(key, String(run.length), () => ({
            kind: "thinking",
            key,
            index,
            text: run
              .map((thought) => thought.thinking.trim())
              .filter(Boolean)
              .join("\n\n"),
            redacted: run.every((thought) => thought.redacted === true),
          })),
        );
        index = end - 1;
        break;
      }
      case "toolCall": {
        const result = results.get(part.id);
        blocks.push(
          cache.get(key, resultSignature(result), () => (result === undefined ? { kind: "tool", key, call: part } : { kind: "tool", key, call: part, result })),
        );
        break;
      }
    }
  }
  return blocks;
};

/**
 * Projects a root-to-leaf branch (see `branchOf`). Pass a projector's cache
 * to keep identities stable; the plain function builds everything fresh.
 */
const project = (branch: readonly SessionEvent[], cache: Cache): Transcript => {
  // A turn the person stopped was cut short in its last step: the errors there are the stop's (`ToolResultView.stopped`).
  const lastSteps = new Map<string, string>();
  const stoppedTurns = new Set<string>();
  for (const event of branch) {
    const data = event.data;
    if (data.type === "step-start") lastSteps.set(data.turnId, data.stepId);
    else if (data.type === "turn-end" && data.reason === "cancelled") stoppedTurns.add(data.turnId);
  }
  // Tool results pair with calls by id; the last result for an id wins.
  const results = new Map<string, ToolResultView>();
  const callIds = new Set<string>();
  for (const event of branch) {
    const data = event.data;
    if (data.type === "message" && data.message.role === "toolResult") {
      const message = data.message;
      const stopped =
        message.isError &&
        data.turnId !== undefined &&
        stoppedTurns.has(data.turnId) &&
        data.stepId !== undefined &&
        data.stepId === lastSteps.get(data.turnId);
      results.set(
        message.toolCallId,
        cache.get(`result:${event.id}`, stopped ? "stopped" : "", () => ({
          eventId: event.id,
          content: message.content,
          isError: message.isError,
          ...(data.details === undefined ? {} : { details: data.details }),
          ...(data.timing === undefined ? {} : { timing: data.timing }),
          ...(stopped ? { stopped: true as const } : {}),
        })),
      );
    }
    if (data.type === "message" && data.message.role === "assistant") {
      for (const part of data.message.content) if (part.type === "toolCall") callIds.add(part.id);
    }
  }

  const turns: MutableTurn[] = [];
  let title: string | undefined;
  let current: MutableTurn | undefined;
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

  for (const event of branch) {
    const data = event.data;
    switch (data.type) {
      case "turn-start": {
        // The user message may be logged before or after turn-start; attach to a turn holding only that message.
        if (current !== undefined && current.turnId === undefined && current.hasUser && !current.hasOutput) {
          current.turnId = data.turnId;
          current.key = data.turnId;
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
        }
        break;
      }
      case "message": {
        const message = data.message;
        if (message.role === "user") {
          // A steer: a prompt placed in the running turn between its steps, shown where it joined.
          if (current !== undefined && current.hasUser && data.turnId !== undefined && current.turnId === data.turnId) {
            const steer = current.hasOutput;
            current.items.push(
              cache.get(event.id, "", (): UserItem => ({ kind: "user", id: event.id, at: event.at, content: message.content, ...(steer ? { steer } : {}) })),
            );
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
          turn.items.push(cache.get(event.id, "", (): UserItem => ({ kind: "user", id: event.id, at: event.at, content: message.content })));
        } else if (message.role === "assistant") {
          const turn = ensure(event);
          const resultIds = message.content.map((part) => (part.type === "toolCall" ? resultSignature(results.get(part.id)) : "")).join(",");
          turn.items.push(
            cache.get(event.id, resultIds, (): AssistantItem => ({
              kind: "assistant",
              id: event.id,
              at: event.at,
              message,
              blocks: blocksOf(cache, event.id, message, results),
              ...(data.stepId === undefined ? {} : { stepId: data.stepId }),
              ...(data.timing === undefined ? {} : { timing: data.timing }),
            })),
          );
          recordCall(turn, message, data.timing);
        } else if (!callIds.has(message.toolCallId)) {
          ensure(event).items.push(cache.get(event.id, "", (): OrphanResultItem => ({ kind: "orphan-result", id: event.id, at: event.at, message })));
        }
        break;
      }
      case "attempt": {
        const turn = ensure(event);
        turn.items.push(
          cache.get(event.id, "", (): AttemptItem => ({
            kind: "attempt",
            id: event.id,
            at: event.at,
            stepId: data.stepId,
            message: data.message,
            blocks: blocksOf(cache, event.id, data.message, new Map()),
            timing: data.timing,
          })),
        );
        recordCall(turn, data.message, data.timing);
        turn.steps--; // A retried call is not a step of its own.
        break;
      }
      case "compaction": {
        const turn = ensure(event);
        // Writing the summary is part of what the turn cost.
        if (data.usage !== undefined) turn.usage = addUsage(turn.usage, data.usage);
        turn.items.push(
          cache.get(event.id, "", (): CompactionItem => ({
            kind: "compaction",
            id: event.id,
            at: event.at,
            summary: data.summary,
            tokensBefore: data.tokensBefore,
          })),
        );
        break;
      }
      case "title":
        title = data.title;
        break;
      default:
        break;
    }
  }

  const views = turns.map((turn): TurnView => {
    const signature = [
      turn.key,
      turn.turnId ?? "",
      turn.endedAt ?? "",
      turn.end?.reason ?? "",
      turn.end?.error ?? "",
      turn.steps,
      ...turn.items.map(identity),
    ].join("|");
    return cache.get(`turn:${turn.key}`, signature, () => ({
      key: turn.key,
      ...(turn.turnId === undefined ? {} : { turnId: turn.turnId }),
      items: turn.items,
      startedAt: turn.startedAt,
      ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
      ...(turn.end === undefined ? {} : { end: turn.end }),
      usage: turn.usage,
      models: turn.models,
      steps: turn.steps,
      ...(turn.firstTokenMs === undefined ? {} : { firstTokenMs: turn.firstTokenMs }),
    }));
  });

  cache.sweep();
  return { turns: views, ...(title === undefined ? {} : { title }) };
};

/** A stateful projector for one session view; reuses unchanged objects between calls. */
export const createProjector = (): ((branch: readonly SessionEvent[]) => Transcript) => {
  const cache = makeCache();
  return (branch) => project(branch, cache);
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
