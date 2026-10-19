import type { Message, ThinkingLevel, ToolSpec } from "@lemma/llm";
import { LlmRequest } from "@lemma/llm";
import type { SessionEvent } from "./sessions.ts";

/**
 * Pure projections over session events. Every reader (the agent loop, the
 * `lemma sessions inspect` command, the web client) uses these, so they agree on what the model
 * saw.
 */

/** Root-to-leaf path through `events` ending at `leaf`. Unknown leaves yield an empty path. */
export function branchOf(events: readonly SessionEvent[], leaf: string | undefined): SessionEvent[] {
  if (leaf === undefined) return [];
  const byId = new Map(events.map((event) => [event.id, event]));
  const path: SessionEvent[] = [];
  for (let at = byId.get(leaf); at !== undefined; at = at.parent === null ? undefined : byId.get(at.parent)) {
    path.push(at);
  }
  return path.reverse();
}

/**
 * Where the model's view of a branch starts: the latest `compaction` (its
 * index on the branch) replaces everything before the event it keeps first,
 * `start`. Events from `start` on are seen as they are, including kept ones
 * logged before the compaction itself.
 */
export function modelView(branch: readonly SessionEvent[]): { readonly start: number; readonly compaction?: number } {
  for (let i = branch.length - 1; i >= 0; i--) {
    const data = branch[i]!.data;
    if (data.type !== "compaction") continue;
    const kept = branch.findIndex((event) => event.id === data.firstKeptId);
    return { start: kept === -1 ? i + 1 : kept, compaction: i };
  }
  return { start: 0 };
}

/**
 * The message an event puts in the model's view, before a compaction or an edit changes the view: a `message` event's
 * own; none for the rest. Every reader of what the model sees (the agent, compaction's estimates and cut, the
 * trajectory, the inspector) goes through this and `modelEntries`, so an event type added later is seen the same way
 * by all of them, and the switch below fails to compile until it is decided what the new type shows the model.
 */
export function messageOf(event: SessionEvent): Message | undefined {
  const data = event.data;
  switch (data.type) {
    case "message":
      return data.message;
    case "context":
      return { role: "user", content: data.content, timestamp: event.at };
    case "turn-start":
    case "turn-end":
    case "step-start":
    case "step-end":
    case "request":
    case "attempt":
    case "compaction":
    case "title":
    case "custom":
      return undefined;
    default:
      return unknownEvent(data);
  }
}

const unknownEvent = (data: never): undefined => {
  throw new Error(`An event of a type the model view does not know: ${JSON.stringify((data as { readonly type?: unknown }).type)}`);
};

/**
 * One message of the model's view of a branch, and where it comes from: `index`, the event's place on the branch; for
 * the summary a compaction put in place of what came before, the compaction's (`summary`).
 */
export interface ModelEntry {
  readonly message: Message;
  readonly index: number;
  readonly summary?: true;
  /** From a `context` event: a plugin's, which a response's tool results go before. */
  readonly context?: true;
}

/**
 * The model's view of a branch, message by message, each with the event it comes from: the latest `compaction`'s
 * summary in place of everything before its `firstKeptId`, then each event's message (`messageOf`) from there, tool
 * results in the order the model made their calls. `deriveMessages` is its messages.
 */
export function modelEntries(branch: readonly SessionEvent[]): ModelEntry[] {
  const { start, compaction } = modelView(branch);
  const summary = compaction === undefined ? undefined : branch[compaction]!;
  const entries: ModelEntry[] =
    summary?.data.type !== "compaction"
      ? []
      : [
          {
            message: {
              role: "user",
              content: [{ type: "text", text: `<summary>\nThe conversation so far, summarized:\n\n${summary.data.summary}\n</summary>` }],
              timestamp: summary.at,
            },
            index: compaction!,
            summary: true,
          },
        ];
  for (let index = start; index < branch.length; index++) {
    const event = branch[index]!;
    const message = messageOf(event);
    if (message !== undefined) entries.push(event.data.type === "context" ? { message, index, context: true } : { message, index });
  }
  return inCallOrder(afterResults(entries));
}

/**
 * Moves each `context` entry that lands among a response's tool results to after them: a provider wants a response's
 * results right after it. The results a response waits for are those of its calls; the run ends at the first entry
 * that is neither one of them nor context.
 */
function afterResults(entries: ModelEntry[]): ModelEntry[] {
  if (!entries.some((entry) => entry.context === true)) return entries;
  for (let i = 0; i < entries.length; i++) {
    const message = entries[i]!.message;
    if (message.role !== "assistant") continue;
    const calls = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
    if (calls.size === 0) continue;
    let end = i + 1;
    while (end < entries.length) {
      const entry = entries[end]!;
      if (entry.context === true || (entry.message.role === "toolResult" && calls.has(entry.message.toolCallId))) end++;
      else break;
    }
    const run = entries.slice(i + 1, end);
    const context = run.filter((entry) => entry.context === true);
    if (context.length === 0) continue;
    // Context after the last result is in place already; only context before one moves.
    let lastResult = run.length - 1;
    while (lastResult >= 0 && run[lastResult]!.context === true) lastResult--;
    if (lastResult === -1 || run.slice(0, lastResult).every((entry) => entry.context !== true)) continue;
    entries.splice(i + 1, run.length, ...run.filter((entry) => entry.context !== true), ...context);
    i = end - 1;
  }
  return entries;
}

/**
 * Model history for a branch: `modelEntries`' messages. The latest `compaction` replaces everything before its
 * `firstKeptId` with a summary message.
 */
export function deriveMessages(branch: readonly SessionEvent[]): Message[] {
  return modelEntries(branch).map((entry) => entry.message);
}

/**
 * Tool results that ran together are logged as each finished; the model reads
 * them in the order it made the calls. Reorders, in place, each run of results
 * that follows an assistant message; a result for a call it did not make keeps
 * its place after the others.
 */
function inCallOrder(entries: ModelEntry[]): ModelEntry[] {
  for (let i = 0; i < entries.length; i++) {
    const message = entries[i]!.message;
    if (message.role !== "assistant") continue;
    let end = i + 1;
    while (end < entries.length && entries[end]!.message.role === "toolResult") end++;
    if (end - i <= 2) continue;
    const order = new Map<string, number>();
    for (const block of message.content) if (block.type === "toolCall") order.set(block.id, order.size);
    const rank = (entry: ModelEntry) => (entry.message.role === "toolResult" ? (order.get(entry.message.toolCallId) ?? order.size) : order.size);
    const results = entries.slice(i + 1, end);
    if (results.every((result, index) => index === 0 || rank(results[index - 1]!) <= rank(result))) continue;
    results.sort((a, b) => rank(a) - rank(b));
    entries.splice(i + 1, results.length, ...results);
    i = end - 1;
  }
  return entries;
}

export interface RequestState {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly system?: string;
  readonly tools?: readonly ToolSpec[];
}

/** The request state after `event`: a `request` event's header, its omitted fields kept from `state`; any other, `state`. */
export function nextRequestState(state: RequestState, event: SessionEvent): RequestState {
  const data = event.data;
  if (data.type !== "request") return state;
  return {
    model: data.model,
    ...(data.thinking === undefined ? {} : { thinking: data.thinking }),
    ...(data.system !== undefined ? { system: data.system } : state.system === undefined ? {} : { system: state.system }),
    ...(data.tools !== undefined ? { tools: data.tools } : state.tools === undefined ? {} : { tools: state.tools }),
  };
}

/** System prompt and tools in effect after the last `request` on the branch, resolving omitted (unchanged) fields. */
export function requestState(branch: readonly SessionEvent[]): RequestState {
  let state: RequestState = {};
  for (const event of branch) state = nextRequestState(state, event);
  return state;
}

/**
 * The request a `request` event sent: its header resolved (`state`, after the event), the model's history before it
 * (`messages`, `deriveMessages` of the branch before it), and what the event logged beside them. What
 * `rebuildRequest` returns, for a caller that keeps `state` and `messages` as it goes rather than deriving them anew.
 * Built from logged events, which were checked as they were logged and as they are read, so not checked again: a
 * long history's messages would be, on every request.
 */
export function requestFrom(state: RequestState, messages: readonly Message[], logged: SessionEvent, sessionId?: string): LlmRequest {
  const providerOptions = logged.data.type === "request" ? logged.data.providerOptions : undefined;
  return new LlmRequest(
    {
      model: state.model!,
      messages,
      ...(state.system === undefined ? {} : { system: state.system }),
      ...(state.tools === undefined || state.tools.length === 0 ? {} : { tools: state.tools }),
      ...(state.thinking === undefined ? {} : { thinking: state.thinking }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(providerOptions === undefined ? {} : { providerOptions }),
    },
    { disableChecks: true },
  );
}

/**
 * The exact request sent for the `request` event `requestId`: its resolved
 * header plus the history on the branch before it. Returns undefined when the
 * id is not a request on this branch.
 */
export function rebuildRequest(branch: readonly SessionEvent[], requestId: string, sessionId?: string): LlmRequest | undefined {
  const index = branch.findIndex((event) => event.id === requestId);
  if (index === -1 || branch[index]!.data.type !== "request") return undefined;
  return requestFrom(requestState(branch.slice(0, index + 1)), deriveMessages(branch.slice(0, index)), branch[index]!, sessionId);
}
