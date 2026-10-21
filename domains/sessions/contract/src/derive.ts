import type { Message, ThinkingLevel, ToolSpec } from "@lemma/llm";
import { LlmRequest } from "@lemma/llm";
import type { Contribution, EventData, SectionUpdate, SessionEvent } from "./sessions.ts";
import { splitSystem } from "./trajectory.ts";

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
    // The event it keeps first comes before it, usually shortly: looked for from there back, not from the root.
    let kept = i - 1;
    while (kept >= 0 && branch[kept]!.id !== data.firstKeptId) kept--;
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
      // A reply the user stopped, logged as far as it got: the model sees it as a reply that ended there, as the user
      // read it (a provider drops a reply marked aborted).
      return data.message.role === "assistant" && data.message.stopReason === "aborted" ? { ...data.message, stopReason: "stop" } : data.message;
    case "context":
      return { role: "user", content: data.content, timestamp: event.at };
    case "prompt-update":
      return { role: "user", content: [{ type: "text", text: promptUpdateText(data) }], timestamp: event.at };
    case "context-edit":
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

/** A `prompt-update` event as the model reads it: a user message, from the harness. */
export function promptUpdateText(data: Extract<EventData, { readonly type: "prompt-update" }>): string {
  const lines = ["<system-update>", "From Lemma, the harness, not from the user."];
  if (data.sections.length > 0) lines.push("Each section below replaces the part of your system prompt it corresponds to.");
  for (const section of data.sections) {
    lines.push(section.text === "" ? `<section id="${section.id}" removed="true"/>` : `<section id="${section.id}">\n${section.text}\n</section>`);
  }
  if (data.unavailable !== undefined) {
    lines.push(
      data.unavailable.length === 0
        ? "Every tool declared to you is available again."
        : `These tools are not available now, and calls to them are refused: ${data.unavailable.join(", ")}.`,
    );
  }
  lines.push("</system-update>");
  return lines.join("\n");
}

/** A `compaction` event as the model reads it, in place of the history it replaces: its summary, and the files it names. */
export function summaryText(data: Extract<EventData, { readonly type: "compaction" }>): string {
  const files = data.files;
  const listed = (label: string, paths: readonly string[]) => (paths.length === 0 ? [] : [`${label}:`, ...paths.map((path) => `- ${path}`)]);
  const named =
    files === undefined || files.read.length + files.modified.length === 0
      ? ""
      : `\n\n<files>\n${[...listed("Changed", files.modified), ...listed("Read", files.read)].join("\n")}\nRead a file again before relying on what the summary says of it.\n</files>`;
  return `<summary>\nThe conversation so far, summarized:\n\n${data.summary}${named}\n</summary>`;
}

/**
 * The index on `branch` of the latest request in the model's view that declared the prompt afresh (`restart`), or -1
 * for none: a `prompt-update` event at or before it is no longer sent, as that request said it all again.
 */
export function restartedAt(branch: readonly SessionEvent[]): number {
  const { start } = modelView(branch);
  for (let i = branch.length - 1; i >= start; i--) {
    const data = branch[i]!.data;
    if (data.type === "request" && data.restart !== undefined) return i;
  }
  return -1;
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

/** What the model's view is derived for (`modelEntries`). */
export interface ViewOptions {
  /**
   * For a request that declares its system prompt afresh (`restart`), not yet on the branch: it says every section
   * again, so no `prompt-update` before it is sent.
   */
  readonly restart?: boolean;
}

/**
 * The model's view of a branch, message by message, each with the event it comes from: the latest `compaction`'s
 * summary in place of everything before its `firstKeptId`, then each event's message (`messageOf`) from there, tool
 * results in the order the model made their calls. A `prompt-update` is in it until a request declares the prompt
 * afresh (`restartedAt`, or `options.restart` for the request to come). `deriveMessages` is its messages.
 */
export function modelEntries(branch: readonly SessionEvent[], options: ViewOptions = {}): ModelEntry[] {
  const { start, compaction } = modelView(branch);
  const declared = options.restart === true ? branch.length : restartedAt(branch);
  const summary = compaction === undefined ? undefined : branch[compaction]!;
  const entries: ModelEntry[] =
    summary?.data.type !== "compaction"
      ? []
      : [{ message: { role: "user", content: [{ type: "text", text: summaryText(summary.data) }], timestamp: summary.at }, index: compaction!, summary: true }];
  for (let index = start; index < branch.length; index++) {
    const event = branch[index]!;
    if (event.data.type === "prompt-update" && index <= declared) continue;
    const message = messageOf(event);
    if (message === undefined) continue;
    // A prompt update is the harness's context: after a response's results too, so the calls keep them.
    entries.push(event.data.type === "context" || event.data.type === "prompt-update" ? { message, index, context: true } : { message, index });
  }
  return inCallOrder(afterResults(edited(branch, entries, start)));
}

type ContextEdit = Extract<SessionEvent["data"], { type: "context-edit" }>;

/**
 * Whether `edit` changes `message`, its target's: an omit leaves out anything but a lone tool result (a response takes
 * its results with it), a replace puts its content in place of anything but a response (whose calls its results answer).
 */
export function editApplies(edit: ContextEdit, message: Message): boolean {
  return edit.op === "omit" ? message.role !== "toolResult" : edit.content !== undefined && message.role !== "assistant";
}

/** Of a target's edits, oldest first, the latest that applies to its message. */
function latestApplying(edits: readonly ContextEdit[] | undefined, message: Message): ContextEdit | undefined {
  for (let at = (edits?.length ?? 0) - 1; at >= 0; at--) if (editApplies(edits![at]!, message)) return edits![at];
  return undefined;
}

/**
 * `entries` with the branch's `context-edit`s applied: per target, the latest that applies to it; one that cannot apply
 * changes nothing, and leaves an earlier one in force. An edit names an earlier event, so one before the view's `start`
 * names an event out of it, and is not looked at.
 */
function edited(branch: readonly SessionEvent[], entries: ModelEntry[], start: number): ModelEntry[] {
  const edits = new Map<string, ContextEdit[]>();
  for (let index = start; index < branch.length; index++) {
    const data = branch[index]!.data;
    if (data.type !== "context-edit") continue;
    const target = edits.get(data.target);
    if (target === undefined) edits.set(data.target, [data]);
    else target.push(data);
  }
  if (edits.size === 0) return entries;
  const omittedCalls = new Set<string>();
  const out: ModelEntry[] = [];
  for (const entry of entries) {
    const message = entry.message;
    const edit = entry.summary === true ? undefined : latestApplying(edits.get(branch[entry.index]!.id), message);
    if (edit?.op === "omit") {
      if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") omittedCalls.add(block.id);
      continue;
    }
    if (edit?.op === "replace" && edit.content !== undefined && message.role !== "assistant") {
      out.push({ ...entry, message: { ...message, content: edit.content } });
      continue;
    }
    out.push(entry);
  }
  // A response left out takes its results with it.
  return omittedCalls.size === 0 ? out : out.filter((entry) => !(entry.message.role === "toolResult" && omittedCalls.has(entry.message.toolCallId)));
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
export function deriveMessages(branch: readonly SessionEvent[], options: ViewOptions = {}): Message[] {
  return modelEntries(branch, options).map((entry) => entry.message);
}

/** The model's history before a request, and from where its thinking was made under the request's prefix. */
export interface History {
  readonly messages: Message[];
  /**
   * Thinking in the messages before this index was made under another system prompt, tools, or start of history (a
   * request has declared them afresh since): `LlmRequest.thinkingFrom`. Absent when nothing before it has thinking.
   */
  readonly thinkingFrom?: number;
}

/** `deriveMessages`, with where the thinking made under another prefix ends (`History.thinkingFrom`). */
export function deriveHistory(branch: readonly SessionEvent[], options: ViewOptions = {}): History {
  return historyOf(branch, modelEntries(branch, options), options);
}

/** `deriveHistory`, for a caller that has the branch's `modelEntries(branch, options)` already. */
export function historyOf(branch: readonly SessionEvent[], entries: readonly ModelEntry[], options: ViewOptions = {}): History {
  // The latest request that declared the prompt afresh: the messages before it were made under another prefix.
  const declared = options.restart === true ? branch.length : restartedAt(branch);
  const before = entries.filter((entry) => entry.index < declared).length;
  const thinking = entries
    .slice(0, before)
    .some((entry) => entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "thinking"));
  return { messages: entries.map((entry) => entry.message), ...(thinking ? { thinkingFrom: before } : {}) };
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
  /** The `nested` tools offered beside `tools`; undefined when the log predates their being logged. */
  readonly nested?: readonly string[];
  /**
   * The last request's contributions, who made its system prompt and tools: its own, or, when it logged none, those of
   * the request before it on the branch. Absent when no request on the branch logged any.
   */
  readonly contributions?: readonly Contribution[];
  /**
   * Each section as the model was last told it: the system prompt's, as the request that declared it splits by its
   * sizes (`splitSystem`), then each `prompt-update` event's since. Absent when the logged prompt does not split so.
   */
  readonly sections?: readonly SectionUpdate[];
  /** The declared tools a call to which is refused, as the latest `prompt-update` since the prompt was declared said. */
  readonly unavailable?: readonly string[];
}

/** The non-empty sections `system` is made of, by its request's contributions; undefined when it does not split by them. */
function sectionsOf(system: string | undefined, contributions: readonly Contribution[]): SectionUpdate[] | undefined {
  const texts = splitSystem(system, contributions);
  if (texts === undefined) return undefined;
  return contributions
    .filter((contribution) => contribution.kind === "system")
    .flatMap((contribution, i) => (texts[i] === "" ? [] : [{ id: contribution.label, source: contribution.source, text: texts[i]! }]));
}

/** `sections` with `updates` made: a section with new text replaces its namesake, or comes last; one with none goes. */
function updated(sections: readonly SectionUpdate[], updates: readonly SectionUpdate[]): SectionUpdate[] {
  const next = [...sections];
  for (const update of updates) {
    const at = next.findIndex((section) => section.id === update.id);
    if (update.text === "") {
      if (at !== -1) next.splice(at, 1);
    } else if (at === -1) next.push(update);
    else next[at] = update;
  }
  return next;
}

/**
 * The request state after `event`: a `request` event's header, its omitted fields kept from `state` (the request before
 * it on the branch, as the branch is folded in order); a `prompt-update` event's sections and unavailable tools; any
 * other, `state`.
 */
export function nextRequestState(state: RequestState, event: SessionEvent): RequestState {
  const data = event.data;
  if (data.type === "prompt-update") {
    return {
      ...state,
      ...(state.sections === undefined ? {} : { sections: updated(state.sections, data.sections) }),
      ...(data.unavailable === undefined ? {} : { unavailable: data.unavailable }),
    };
  }
  if (data.type !== "request") return state;
  const system = data.system ?? state.system;
  const contributions = data.contributions ?? state.contributions;
  const declared = data.restart !== undefined || data.system !== undefined || state.sections === undefined;
  const sections = !declared ? state.sections : contributions === undefined ? undefined : sectionsOf(system, contributions);
  return {
    model: data.model,
    ...(data.thinking === undefined ? {} : { thinking: data.thinking }),
    ...(system === undefined ? {} : { system }),
    ...(data.tools !== undefined ? { tools: data.tools } : state.tools === undefined ? {} : { tools: state.tools }),
    ...(data.nested !== undefined ? { nested: data.nested } : state.nested === undefined ? {} : { nested: state.nested }),
    ...(contributions === undefined ? {} : { contributions }),
    ...(sections === undefined ? {} : { sections }),
    ...(data.restart === undefined && state.unavailable !== undefined ? { unavailable: state.unavailable } : {}),
  };
}

/** System prompt, tools, and sections in effect after the last `request` on the branch, and the `prompt-update`s since. */
export function requestState(branch: readonly SessionEvent[]): RequestState {
  let state: RequestState = {};
  for (const event of branch) state = nextRequestState(state, event);
  return state;
}

/**
 * The request a `request` event sent: its header resolved (`state`, after the event), the model's history before it
 * (`history`, `deriveHistory` of the branch before it, with the event's `restart`), and what the event logged beside
 * them. What `rebuildRequest` returns, for a caller that keeps `state` and `history` as it goes rather than deriving
 * them anew. Built from logged events, which were checked as they were logged and as they are read, so not checked
 * again: a long history's messages would be, on every request.
 */
export function requestFrom(state: RequestState, history: History, logged: SessionEvent, sessionId?: string): LlmRequest {
  const providerOptions = logged.data.type === "request" ? logged.data.providerOptions : undefined;
  // In the order of `LlmRequest`'s fields, as its constructor would put them.
  return checkedRequest({
    model: state.model!,
    ...(state.system === undefined ? {} : { system: state.system }),
    messages: history.messages,
    ...(history.thinkingFrom === undefined ? {} : { thinkingFrom: history.thinkingFrom }),
    ...(state.tools === undefined || state.tools.length === 0 ? {} : { tools: state.tools }),
    ...(state.thinking === undefined ? {} : { thinking: state.thinking }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  });
}

/**
 * The `LlmRequest` `fields` make, when they are one already: logged events, which the store checked as it logged them
 * and serves as they read back. The constructor would make a copy of every message and part in walking them, which
 * `disableChecks` does not skip, on every request of a long session. `tests/derive.test.ts` holds it to the
 * constructor's result. Its messages, tools, and options are the log's own, so it is frozen, and they with it: what
 * reads it (an `LlmRequestHook` handler, a provider) cannot change the log in changing it. Each object is frozen once,
 * the first request it is in, so a request costs a look at each message, not a copy.
 */
const checkedRequest = (fields: ConstructorParameters<typeof LlmRequest>[0]): LlmRequest =>
  frozen(Object.assign(Object.create(LlmRequest.prototype) as LlmRequest, fields));

/** `value` frozen, and all it holds: what is frozen already is passed over, as it was frozen so. */
const frozen = <A>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) for (const item of value) frozen(item);
  else for (const item of Object.values(value)) frozen(item);
  return value;
};

/**
 * The exact request sent for the `request` event `requestId`: its resolved
 * header plus the history on the branch before it. Returns undefined when the
 * id is not a request on this branch.
 */
export function rebuildRequest(branch: readonly SessionEvent[], requestId: string, sessionId?: string): LlmRequest | undefined {
  const index = branch.findIndex((event) => event.id === requestId);
  const data = branch[index]?.data;
  if (data?.type !== "request") return undefined;
  return requestFrom(
    requestState(branch.slice(0, index + 1)),
    deriveHistory(branch.slice(0, index), { restart: data.restart !== undefined }),
    branch[index]!,
    sessionId,
  );
}

/*
 * What a plugin reads back of its own state on a branch, the way the log keeps it: a tool's state in its results'
 * `details` (so it follows the branch, and survives a restart with nothing stored), and a plugin's own data in
 * `custom` events. The host and web halves read the same branch with these, rather than walking events by hand.
 */

/**
 * The `details` of the latest successful result of the tool `toolName` on `branch`, or undefined: where a tool that
 * keeps state in its results (a todo list) finds it, as of the branch's end.
 */
export function latestDetails(branch: readonly SessionEvent[], toolName: string): unknown {
  for (let at = branch.length - 1; at >= 0; at--) {
    const data = branch[at]!.data;
    if (data.type !== "message" || data.message.role !== "toolResult" || data.message.toolName !== toolName || data.message.isError) continue;
    if (data.details !== undefined) return data.details;
  }
  return undefined;
}

/** The data of the `custom` events of `kind` on `branch`, oldest first: a plugin's own records (`kind` namespaced by its id). */
export function customEvents(branch: readonly SessionEvent[], kind: string): readonly unknown[] {
  return branch.flatMap((event) => (event.data.type === "custom" && event.data.kind === kind ? [event.data.data] : []));
}

/** The text of the latest prompt on `branch` (its text parts, joined), or undefined when it has none. */
export function lastPromptText(branch: readonly SessionEvent[]): string | undefined {
  for (let at = branch.length - 1; at >= 0; at--) {
    const data = branch[at]!.data;
    if (data.type !== "message" || data.message.role !== "user") continue;
    return data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }
  return undefined;
}
