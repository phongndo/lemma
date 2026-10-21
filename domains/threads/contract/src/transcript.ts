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
 * expanded/collapsed state) while the log grows. A branch that carries on the
 * last one it was given (the same events, more at the end) costs what was
 * appended, not the branch: it folds again from the earliest turn the new
 * events change, almost always the last.
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

/** What a plugin told the model (a `context` event): its source, and what a transcript shows of it. */
export interface ContextItem {
  readonly kind: "context";
  readonly id: string;
  readonly at: number;
  readonly source: string;
  /** The event's `display`, else its content's text. */
  readonly text: string;
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

interface Cache {
  readonly get: <T>(key: string, signature: string, make: () => T) => T;
  /** From here to `sweep`, what is used is all that is kept. */
  readonly begin: () => void;
  readonly sweep: () => void;
}

/**
 * Objects by key, kept while their signature holds. A projection of the whole branch keeps only what it used
 * (`begin`, `sweep`); one carried on through events appended keeps the rest too, and finds the newest first.
 */
const makeCache = (): Cache => {
  let kept = new Map<string, { signature: string; value: unknown }>();
  let used = new Map<string, { signature: string; value: unknown }>();
  return {
    get: <T>(key: string, signature: string, make: () => T): T => {
      const hit = used.get(key) ?? kept.get(key);
      const entry = hit !== undefined && hit.signature === signature ? hit : { signature, value: make() };
      used.set(key, entry);
      return entry.value as T;
    },
    begin: () => {
      for (const [key, entry] of used) kept.set(key, entry);
      used = new Map();
    },
    sweep: () => {
      kept = used;
      used = new Map();
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
  /** Where in the branch the event that made it is. */
  readonly first: number;
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

const newTurn = (first: number, key: string, at: number, turnId?: string): MutableTurn => ({
  first,
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
 * A projection under way: the branch it read, what it gathered from the whole branch (each call's result, and what a
 * result's stop depends on), and the turns folded so far. Carried on through events appended to the branch, it folds
 * again only from the earliest turn they change, which is almost always the last.
 */
interface Fold {
  readonly branch: readonly SessionEvent[];
  /** How many of its events were folded: a caller may grow the branch it passed in place since. */
  readonly read: number;
  /** Each turn's last step, and the turns the person stopped: what makes a result the stop's (`ToolResultView.stopped`). */
  readonly lastSteps: Map<string, string>;
  readonly stoppedTurns: Set<string>;
  /** Each call's result, the last logged for it, and the event it is. */
  readonly results: Map<string, ToolResultView>;
  readonly resultEvents: Map<string, SessionEvent>;
  /** The calls whose results were logged in each turn, by its id: what its stop or a new step changes. */
  readonly resultsIn: Map<string, string[]>;
  readonly callIds: Set<string>;
  turns: MutableTurn[];
  current: MutableTurn | undefined;
  title: string | undefined;
  /** The first turn, by position, whose item holds each call; and each result shown on its own, its call not on the branch. */
  readonly callTurn: Map<string, number>;
  readonly orphanTurn: Map<string, number>;
  views: TurnView[];
}

const emptyFold = (branch: readonly SessionEvent[]): Fold => ({
  branch,
  read: branch.length,
  lastSteps: new Map(),
  stoppedTurns: new Set(),
  results: new Map(),
  resultEvents: new Map(),
  resultsIn: new Map(),
  callIds: new Set(),
  turns: [],
  current: undefined,
  title: undefined,
  callTurn: new Map(),
  orphanTurn: new Map(),
  views: [],
});

/** Whether a result is the stop's: an error in the last step of a turn the person stopped. */
const isStopped = (fold: Fold, event: SessionEvent): boolean => {
  const data = event.data;
  if (data.type !== "message" || data.message.role !== "toolResult") return false;
  return (
    data.message.isError &&
    data.turnId !== undefined &&
    fold.stoppedTurns.has(data.turnId) &&
    data.stepId !== undefined &&
    data.stepId === fold.lastSteps.get(data.turnId)
  );
};

/** `event`'s result as a call's block shows it, its identity kept while it is the same. */
const resultView = (cache: Cache, fold: Fold, event: SessionEvent): ToolResultView => {
  const data = event.data as Extract<SessionEvent["data"], { type: "message" }>;
  const message = data.message as ToolResultMessage;
  const stopped = isStopped(fold, event);
  return cache.get(`result:${event.id}`, stopped ? "stopped" : "", () => ({
    eventId: event.id,
    content: message.content,
    isError: message.isError,
    ...(data.details === undefined ? {} : { details: data.details }),
    ...(data.timing === undefined ? {} : { timing: data.timing }),
    ...(stopped ? { stopped: true as const } : {}),
  }));
};

/**
 * Gathers from `events` (the branch from `from` on) what a call's block needs from the whole branch: the turns' last
 * steps and stops, then each call's result (the last logged for it wins). Returns the turns, by id, whose stop or
 * last step changed, whose results may now be the stop's or no longer.
 */
const gather = (fold: Fold, from: number): Set<string> => {
  const restopped = new Set<string>();
  const { branch } = fold;
  for (let at = from; at < branch.length; at++) {
    const data = branch[at]!.data;
    if (data.type === "step-start") {
      fold.lastSteps.set(data.turnId, data.stepId);
      restopped.add(data.turnId);
    } else if (data.type === "turn-end" && data.reason === "cancelled") {
      fold.stoppedTurns.add(data.turnId);
      restopped.add(data.turnId);
    }
  }
  for (let at = from; at < branch.length; at++) {
    const event = branch[at]!;
    const data = event.data;
    if (data.type !== "message") continue;
    if (data.message.role === "assistant") {
      for (const part of data.message.content) if (part.type === "toolCall") fold.callIds.add(part.id);
      continue;
    }
    if (data.message.role !== "toolResult") continue;
    const id = data.message.toolCallId;
    fold.resultEvents.set(id, event);
    if (data.turnId !== undefined) fold.resultsIn.set(data.turnId, [...(fold.resultsIn.get(data.turnId) ?? []), id]);
  }
  return restopped;
};

/** Notes that turn `turn` holds `id`: a call's id may be logged in more than one message, and the first is what is kept. */
const earliest = (turns: Map<string, number>, id: string, turn: number) => {
  const known = turns.get(id);
  if (known === undefined || turn < known) turns.set(id, turn);
};

/** Folds the branch from `from` (where a turn starts, or the start) into the turns, from `fold.current` on. */
const foldTurns = (cache: Cache, fold: Fold, from: number): void => {
  const { branch, turns, results, callIds } = fold;
  const ensure = (event: SessionEvent, at: number): MutableTurn => {
    if (fold.current === undefined) {
      fold.current = newTurn(at, event.id, event.at);
      turns.push(fold.current);
    }
    return fold.current;
  };
  const start = (event: SessionEvent, at: number, turnId?: string): MutableTurn => {
    fold.current = newTurn(at, turnId ?? event.id, event.at, turnId);
    turns.push(fold.current);
    return fold.current;
  };
  const recordCall = (turn: MutableTurn, message: AssistantMessage, timing: Timing | undefined) => {
    turn.usage = addUsage(turn.usage, message.usage);
    const model = `${message.provider}/${message.model}`;
    if (!turn.models.includes(model)) turn.models.push(model);
    turn.steps++;
    if (turn.firstTokenMs === undefined && timing?.firstTokenAt !== undefined) turn.firstTokenMs = timing.firstTokenAt - timing.startedAt;
    turn.hasOutput = true;
  };

  for (let at = from; at < branch.length; at++) {
    const event = branch[at]!;
    const data = event.data;
    const current = fold.current;
    switch (data.type) {
      case "turn-start": {
        // The user message may be logged before or after turn-start; attach to a turn holding only that message.
        if (current !== undefined && current.turnId === undefined && current.hasUser && !current.hasOutput) {
          current.turnId = data.turnId;
          current.key = data.turnId;
        } else {
          start(event, at, data.turnId);
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
              // Whether it is a steer is part of what it is: a call logged later can take an earlier result out of the way.
              cache.get(event.id, steer ? "steer" : "", (): UserItem => ({
                kind: "user",
                id: event.id,
                at: event.at,
                content: message.content,
                ...(steer ? { steer } : {}),
              })),
            );
            break;
          }
          const turn =
            current !== undefined &&
            !current.hasUser &&
            !current.hasOutput &&
            (current.turnId === undefined || current.turnId === data.turnId || data.turnId === undefined)
              ? current
              : start(event, at, data.turnId);
          turn.hasUser = true;
          turn.items.push(cache.get(event.id, "", (): UserItem => ({ kind: "user", id: event.id, at: event.at, content: message.content })));
        } else if (message.role === "assistant") {
          const turn = ensure(event, at);
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
          for (const part of message.content) if (part.type === "toolCall") earliest(fold.callTurn, part.id, turns.length - 1);
          recordCall(turn, message, data.timing);
        } else if (!callIds.has(message.toolCallId)) {
          ensure(event, at).items.push(cache.get(event.id, "", (): OrphanResultItem => ({ kind: "orphan-result", id: event.id, at: event.at, message })));
          earliest(fold.orphanTurn, message.toolCallId, turns.length - 1);
        }
        break;
      }
      case "attempt": {
        const turn = ensure(event, at);
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
        const turn = ensure(event, at);
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
      case "context": {
        const turn = ensure(event, at);
        const text = data.display ?? data.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
        turn.items.push(cache.get(event.id, "", (): ContextItem => ({ kind: "context", id: event.id, at: event.at, source: data.source, text })));
        break;
      }
      case "title":
        fold.title = data.title;
        break;
      default:
        break;
    }
  }
};

/** A turn as the transcript shows it, kept while it is the same (its items by identity). */
const viewOf = (cache: Cache, turn: MutableTurn): TurnView => {
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
};

const transcriptOfFold = (fold: Fold): Transcript => ({ turns: fold.views, ...(fold.title === undefined ? {} : { title: fold.title }) });

/** Projects a whole root-to-leaf branch (see `branchOf`), keeping what is unchanged from the cache's last. */
const projectWhole = (branch: readonly SessionEvent[], cache: Cache): Fold => {
  cache.begin();
  const fold = emptyFold(branch);
  gather(fold, 0);
  for (const [id, event] of fold.resultEvents) fold.results.set(id, resultView(cache, fold, event));
  foldTurns(cache, fold, 0);
  fold.views = fold.turns.map((turn) => viewOf(cache, turn));
  cache.sweep();
  return fold;
};

/**
 * Carries `fold` on through the events appended to its branch (`branch` extends it), folding again from the earliest
 * turn they change: the last, unless a result closes a call of an earlier turn, a call answers a result shown on its
 * own, an earlier turn ends, or a stop makes an earlier turn's errors its own.
 */
const projectAppended = (fold: Fold, branch: readonly SessionEvent[], cache: Cache): Fold => {
  const from = fold.read;
  const next: Fold = { ...fold, branch, read: branch.length };
  let earliest = Math.max(0, next.turns.length - 1);
  const touch = (turn: number | undefined) => {
    if (turn !== undefined) earliest = Math.min(earliest, turn);
  };
  const restopped = gather(next, from);
  // The results logged now, and those of each turn whose stop or last step changed, are shown as they now are.
  const changed = new Set<string>();
  for (let at = from; at < branch.length; at++) {
    const data = branch[at]!.data;
    if (data.type === "message" && data.message.role === "toolResult") changed.add(data.message.toolCallId);
    if (data.type === "message" && data.message.role === "assistant")
      for (const part of data.message.content) if (part.type === "toolCall") touch(next.orphanTurn.get(part.id));
    if (data.type === "turn-end") {
      const ended = next.turns.findIndex((turn) => turn.turnId === data.turnId);
      if (ended !== -1) touch(ended);
    }
  }
  for (const turnId of restopped) for (const id of next.resultsIn.get(turnId) ?? []) changed.add(id);
  for (const id of changed) {
    const event = next.resultEvents.get(id)!;
    const view = resultView(cache, next, event);
    if (next.results.get(id) === view) continue;
    next.results.set(id, view);
    touch(next.callTurn.get(id));
  }
  // Fold again from where the earliest changed turn starts, after the turns before it.
  const at = next.turns[earliest]?.first ?? 0;
  next.turns = next.turns.slice(0, earliest);
  next.current = next.turns.at(-1);
  // The title is the last on the branch: what was folded before keeps its last, and the fold goes on from it.
  foldTurns(cache, next, Math.min(at, from));
  next.views = [...fold.views.slice(0, earliest), ...next.turns.slice(earliest).map((turn) => viewOf(cache, turn))];
  return next;
};

/** A stateful projector for one session view; reuses unchanged objects between calls. */
export const createProjector = (): ((branch: readonly SessionEvent[]) => Transcript) => {
  const cache = makeCache();
  let last: { readonly fold: Fold; readonly transcript: Transcript } | undefined;
  return (branch) => {
    const before = last?.fold;
    // The branch shown, grown at its end (a turn appending), whether a new array or the one before grown in place:
    // carried on rather than projected whole.
    const appended =
      before !== undefined &&
      before.read > 0 &&
      branch.length >= before.read &&
      branch[before.read - 1] === before.branch[before.read - 1] &&
      branch[0] === before.branch[0];
    if (appended && branch.length === before.read) return last!.transcript;
    const fold = appended ? projectAppended(last!.fold, branch, cache) : projectWhole(branch, cache);
    last = { fold, transcript: transcriptOfFold(fold) };
    return last.transcript;
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
