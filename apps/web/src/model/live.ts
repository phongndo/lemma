import { Predicate } from "effect";
import type { AgentView, AssistantMessage, SessionEvent, StreamEvent, ToolCall } from "@lemma/contracts";

/**
 * Streaming state for one session: what the model is producing right now,
 * built from `delta` events until the durable `message`/`attempt` event for
 * the step lands in the log. Pure; the store holds the current value.
 */

export type DraftBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly args: string; readonly call?: ToolCall };

export interface StepDraft {
  readonly turnId: string;
  readonly stepId: string;
  /** Indexed by content block index; holes stay undefined until their first delta. */
  readonly blocks: readonly (DraftBlock | undefined)[];
  /** The stream finished (done or error); waiting for the durable event. */
  readonly finished: boolean;
  readonly error?: string;
  /** The last stream event applied, by its number in the step (0: none numbered yet). */
  readonly seq: number;
}

export interface LiveState {
  readonly drafts: readonly StepDraft[];
  /** Steps whose durable event arrived; late deltas for them are ignored. */
  readonly settled: ReadonlySet<string>;
  /** Output of tools still running, by tool call id: the tail, until the result is logged. */
  readonly output: ReadonlyMap<string, string>;
  /** How much each running tool has printed in all, so a chunk the output already holds is not added twice. */
  readonly printed: ReadonlyMap<string, number>;
  /**
   * While a view of the running turn is on its way (`beginJoin`): the deltas
   * and output that arrived meanwhile, held to be replayed over the view.
   */
  readonly joining?: readonly Held[];
}

/** An update held while joining. */
type Held =
  | { readonly kind: "delta"; readonly turnId: string; readonly stepId: string; readonly event: StreamEvent; readonly seq?: number }
  | { readonly kind: "output"; readonly toolCallId: string; readonly chunk: string; readonly offset?: number };

export const emptyLive: LiveState = { drafts: [], settled: new Set(), output: new Map(), printed: new Map() };

/** Live output kept per running tool: more than a view shows, bounded however long the tool runs. */
export const OUTPUT_TAIL_CHARS = 16 * 1024;

/** A running tool printed `chunk`, after `offset` characters in all when known; the part the output already holds is skipped. */
export const appendOutput = (state: LiveState, toolCallId: string, chunk: string, offset?: number): LiveState => {
  if (state.joining !== undefined)
    return { ...state, joining: [...state.joining, { kind: "output", toolCallId, chunk, ...(offset === undefined ? {} : { offset }) }] };
  const seen = state.printed.get(toolCallId) ?? 0;
  const start = offset ?? seen;
  const end = start + chunk.length;
  if (end <= seen) return state;
  const fresh = start >= seen ? chunk : chunk.slice(seen - start);
  const text = (state.output.get(toolCallId) ?? "") + fresh;
  const output = new Map(state.output);
  output.set(toolCallId, text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text);
  const printed = new Map(state.printed);
  printed.set(toolCallId, end);
  return { ...state, output, printed };
};

/** The tool's result is logged: its live output is no longer shown. */
export const dropOutput = (state: LiveState, toolCallId: string): LiveState => {
  if (!state.output.has(toolCallId) && !state.printed.has(toolCallId)) return state;
  const output = new Map(state.output);
  output.delete(toolCallId);
  const printed = new Map(state.printed);
  printed.delete(toolCallId);
  return { ...state, output, printed };
};

const setBlock = (blocks: readonly (DraftBlock | undefined)[], index: number, block: DraftBlock) => {
  const next = blocks.slice();
  next[index] = block;
  return next;
};

const applyToDraft = (draft: StepDraft, event: StreamEvent): StepDraft => {
  switch (event.type) {
    case "start":
      return draft;
    case "text-delta":
    case "thinking-delta": {
      const kind = event.type === "text-delta" ? "text" : "thinking";
      const existing = draft.blocks[event.index];
      const text = existing !== undefined && existing.kind === kind ? existing.text + event.delta : event.delta;
      return { ...draft, blocks: setBlock(draft.blocks, event.index, { kind, text }) };
    }
    case "toolcall-start":
      return { ...draft, blocks: setBlock(draft.blocks, event.index, { kind: "tool", id: event.id, name: event.name, args: "" }) };
    case "toolcall-delta": {
      const existing = draft.blocks[event.index];
      const block: DraftBlock =
        existing?.kind === "tool" ? { ...existing, args: existing.args + event.delta } : { kind: "tool", id: "", name: "", args: event.delta };
      return { ...draft, blocks: setBlock(draft.blocks, event.index, block) };
    }
    case "toolcall-end":
      return {
        ...draft,
        blocks: setBlock(draft.blocks, event.index, {
          kind: "tool",
          id: event.toolCall.id,
          name: event.toolCall.name,
          args: JSON.stringify(event.toolCall.arguments),
          call: event.toolCall,
        }),
      };
    case "done":
      return { ...draft, finished: true };
    case "error":
      return { ...draft, finished: true, ...(event.message.errorMessage === undefined ? {} : { error: event.message.errorMessage }) };
  }
};

/** Applies a stream event; one numbered at or below what the draft holds (it was seeded from a view) is skipped. */
export const applyDelta = (state: LiveState, turnId: string, stepId: string, event: StreamEvent, seq?: number): LiveState => {
  if (state.settled.has(stepId)) return state;
  if (state.joining !== undefined)
    return { ...state, joining: [...state.joining, { kind: "delta", turnId, stepId, event, ...(seq === undefined ? {} : { seq }) }] };
  const index = state.drafts.findIndex((draft) => draft.stepId === stepId);
  const draft: StepDraft = index === -1 ? { turnId, stepId, blocks: [], finished: false, seq: 0 } : state.drafts[index]!;
  if (seq !== undefined && seq <= draft.seq) return state;
  const applied = applyToDraft(draft, event);
  const next = seq === undefined || applied === draft ? applied : { ...applied, seq };
  if (next === draft && index !== -1) return state;
  const drafts = state.drafts.slice();
  if (index === -1) drafts.push(next);
  else drafts[index] = next;
  return { ...state, drafts };
};

/** The durable event for `stepId` arrived: drop its draft and ignore stragglers. */
export const settleStep = (state: LiveState, stepId: string): LiveState => {
  if (state.settled.has(stepId) && !state.drafts.some((draft) => draft.stepId === stepId)) return state;
  const settled = new Set(state.settled);
  settled.add(stepId);
  return { ...state, drafts: state.drafts.filter((draft) => draft.stepId !== stepId), settled };
};

/** Nothing more will stream for `turnId`: drops its drafts and ignores stragglers. */
const settleTurn = (state: LiveState, turnId: string): LiveState => {
  if (!state.drafts.some((draft) => draft.turnId === turnId)) return state;
  const settled = new Set(state.settled);
  for (const draft of state.drafts) if (draft.turnId === turnId) settled.add(draft.stepId);
  return { ...state, drafts: state.drafts.filter((draft) => draft.turnId !== turnId), settled };
};

/** The session's running turn ended: nothing more streams for it, and, as a session runs one turn at a time, no tool of it is running. */
export const endTurn = (state: LiveState, turnId: string): LiveState => {
  const next = settleTurn(state, turnId);
  return next.output.size === 0 && next.printed.size === 0 ? next : { ...next, output: new Map(), printed: new Map() };
};

const blockOf = (part: AssistantMessage["content"][number]): DraftBlock => {
  if (part.type === "text") return { kind: "text", text: part.text };
  if (part.type === "thinking") return { kind: "thinking", text: part.thinking };
  // Held from its start, a call's arguments may still be streaming: it is whole once it has some.
  const whole = Object.keys(part.arguments).length > 0;
  return { kind: "tool", id: part.id, name: part.name, args: whole ? JSON.stringify(part.arguments) : "", ...(whole ? { call: part } : {}) };
};

/**
 * What the agent says the running turn has produced so far (`agent.view`),
 * for a session opened or reconnected mid-turn: it replaces the draft of
 * that step and the running tools' output. Updates that arrived while it was
 * on its way are held (`beginJoin`) and replayed over it (`joinLive`), their
 * numbers and offsets skipping what it covers: a newer update alone says
 * nothing of what came before it, so it never stands in for the view.
 */
export const seedLive = (state: LiveState, view: AgentView): LiveState => {
  const turnId = view.turnId;
  if (turnId === undefined) return state;
  let next = state;
  const draft = view.draft;
  if (draft !== undefined && !next.settled.has(draft.stepId)) {
    // Each block at its index in the stream, which the deltas that follow name.
    const blocks: (DraftBlock | undefined)[] = [];
    for (const { index, block } of draft.blocks) blocks[index] = blockOf(block);
    const seeded: StepDraft = { turnId, stepId: draft.stepId, blocks, finished: false, seq: draft.seq };
    next = { ...next, drafts: [...next.drafts.filter((existing) => existing.stepId !== draft.stepId), seeded] };
  }
  if (view.output.length > 0) {
    const output = new Map(next.output);
    const printed = new Map(next.printed);
    for (const entry of view.output) {
      output.set(entry.toolCallId, entry.output);
      printed.set(entry.toolCallId, entry.length);
    }
    next = { ...next, output, printed };
  }
  return next;
};

/**
 * Settles drafts the durable log already covers. Deltas and turn events can be
 * lost while disconnected; the log fetched on reconnect is authoritative. A
 * logged `turn-end` drops the output of that turn's own tool calls only: the
 * log holds every earlier turn's end too.
 */
export const reconcileLive = (state: LiveState, events: readonly SessionEvent[]): LiveState => {
  if (state.drafts.length === 0 && state.output.size === 0 && state.printed.size === 0) return state;
  let next = state;
  const calls = new Map<string, string[]>();
  for (const { data } of events) {
    if (data.type === "message" && data.message.role === "toolResult") next = dropOutput(next, data.message.toolCallId);
    else if (data.type === "message" && data.message.role === "assistant") {
      if (data.turnId !== undefined) {
        const ids = calls.get(data.turnId) ?? [];
        for (const part of data.message.content) if (part.type === "toolCall") ids.push(part.id);
        calls.set(data.turnId, ids);
      }
      if (data.stepId !== undefined) next = settleStep(next, data.stepId);
    } else if (data.type === "attempt") next = settleStep(next, data.stepId);
    else if (data.type === "turn-end") {
      next = settleTurn(next, data.turnId);
      for (const id of calls.get(data.turnId) ?? []) next = dropOutput(next, id);
    }
  }
  return next;
};

/** A view of the running turn has been asked for: deltas and output from now on are held until it arrives (`joinLive`). */
export const beginJoin = (state: LiveState): LiveState => (state.joining !== undefined ? state : { ...state, joining: [] });

/**
 * The view arrived (or, `undefined`, could not be had): it is applied
 * (`seedLive`), the updates held meanwhile replayed over it, and the result
 * checked against the session's log as it stands now, since the view and the
 * log are fetched side by side and a view older than the log must not bring
 * back drafts or output the log already settled.
 */
export const joinLive = (state: LiveState, view: AgentView | undefined, log: readonly SessionEvent[]): LiveState => {
  const { joining = [], ...rest } = state;
  let next: LiveState = view === undefined ? rest : seedLive(rest, view);
  for (const held of joining) {
    next =
      held.kind === "delta" ? applyDelta(next, held.turnId, held.stepId, held.event, held.seq) : appendOutput(next, held.toolCallId, held.chunk, held.offset);
  }
  return reconcileLive(next, log);
};

/** A draft's block as shown: where it starts in the stream, and whether it is the one being written now. */
export interface DraftEntry {
  readonly index: number;
  readonly block: DraftBlock;
  readonly live: boolean;
}

/**
 * A draft's blocks as shown: adjacent thoughts joined into one, as the logged
 * message shows them, and only the last block live while the step streams.
 */
export const draftEntries = (draft: StepDraft): DraftEntry[] => {
  const entries: { index: number; block: DraftBlock; live: boolean }[] = [];
  draft.blocks.forEach((block, index) => {
    if (block === undefined) return;
    const last = entries.at(-1);
    if (block.kind === "thinking" && last?.block.kind === "thinking") {
      const text = [last.block.text.trim(), block.text.trim()].filter(Boolean).join("\n\n");
      last.block = { kind: "thinking", text };
      return;
    }
    entries.push({ index, block, live: false });
  });
  const last = entries.at(-1);
  if (last !== undefined && !draft.finished) last.live = true;
  return entries;
};

/** Best-effort parse of streamed tool arguments (partial JSON while streaming). */
export const parseDraftArgs = (block: Extract<DraftBlock, { kind: "tool" }>): Record<string, unknown> | undefined => {
  if (block.call !== undefined) return block.call.arguments;
  try {
    const value: unknown = JSON.parse(block.args);
    return Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
