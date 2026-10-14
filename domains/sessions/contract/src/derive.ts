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
 * Model history for a branch. The latest `compaction` replaces everything
 * before its `firstKeptId` with a summary message.
 */
export function deriveMessages(branch: readonly SessionEvent[]): Message[] {
  const { start, compaction } = modelView(branch);
  const summary = compaction === undefined ? undefined : branch[compaction]!;
  const messages: Message[] =
    summary?.data.type !== "compaction"
      ? []
      : [
          {
            role: "user",
            content: [{ type: "text", text: `<summary>\nThe conversation so far, summarized:\n\n${summary.data.summary}\n</summary>` }],
            timestamp: summary.at,
          },
        ];
  for (const event of branch.slice(start)) {
    if (event.data.type === "message") messages.push(event.data.message);
  }
  return inCallOrder(messages);
}

/**
 * Tool results that ran together are logged as each finished; the model reads
 * them in the order it made the calls. Reorders, in place, each run of results
 * that follows an assistant message; a result for a call it did not make keeps
 * its place after the others.
 */
function inCallOrder(messages: Message[]): Message[] {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    let end = i + 1;
    while (end < messages.length && messages[end]!.role === "toolResult") end++;
    if (end - i <= 2) continue;
    const order = new Map<string, number>();
    for (const block of message.content) if (block.type === "toolCall") order.set(block.id, order.size);
    const rank = (result: Message) => (result.role === "toolResult" ? (order.get(result.toolCallId) ?? order.size) : order.size);
    const results = messages.slice(i + 1, end);
    if (results.every((result, index) => index === 0 || rank(results[index - 1]!) <= rank(result))) continue;
    results.sort((a, b) => rank(a) - rank(b));
    messages.splice(i + 1, results.length, ...results);
    i = end - 1;
  }
  return messages;
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
