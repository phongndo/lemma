import { Effect } from "effect";
import { definePlugin, PluginContext } from "@lemma/core";
import { AssistantDelta, QueueChanged } from "@lemma/agent";
import type { PromptOutcome, QueuedPrompt } from "@lemma/agent";
import { branchOf, deriveMessages, rebuildRequest, requestState, SessionAppended, splitSystem } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";
import type { LlmRequest, Message } from "@lemma/llm";
import { ToolExecuted, ToolOutput } from "@lemma/tools";
import type { ModelCall } from "./model.ts";
import type { ToolRecord } from "./tools.ts";

/** Keys sorted at every level: two values that hold the same data print the same. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

/** Problems with a request a provider would reject or repair: calls without results, results without calls, a call twice. */
export function malformed(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  let open = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      if (!open.delete(message.toolCallId)) problems.push(`message ${index}: a result for ${message.toolCallId}, which no pending call made`);
      continue;
    }
    if (open.size > 0) problems.push(`message ${index} (${message.role}): calls ${[...open].join(", ")} have no result`);
    open = new Set();
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (open.has(block.id)) problems.push(`message ${index}: duplicate tool call ${block.id}`);
        open.add(block.id);
      }
    }
  }
  if (open.size > 0) problems.push(`calls ${[...open].join(", ")} have no result at the end`);
  return problems;
}

/**
 * Problems with a session's log as served: its `seq`s must run 1, 2, … in file order, each event's parent come before
 * it, and each request say who contributed its parts (`Contribution`): its system sections' sizes must split its
 * system prompt (`splitSystem`), and each of its tools must be attributed.
 */
export function transcriptProblems(events: readonly SessionEvent[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) problems.push(`event ${event.id}: seq ${event.seq} at position ${index + 1}`);
    if (seen.has(event.id)) problems.push(`event ${event.id} appears twice`);
    if (event.parent !== null && !seen.has(event.parent)) problems.push(`event ${event.id}: its parent ${event.parent} is not before it`);
    seen.add(event.id);
    const data = event.data;
    if (data.type === "compaction" && data.source.trim() === "") problems.push(`compaction ${event.id} names no source`);
    if (data.type === "prompt-update")
      for (const section of data.sections) if (section.source.trim() === "") problems.push(`prompt-update ${event.id}: ${section.id} names no source`);
    if (data.type !== "request") continue;
    for (const part of data.contributions) if (part.source.trim() === "") problems.push(`request ${event.id}: ${part.label} names no source`);
    const { system, tools } = requestState(branchOf(events, event.id));
    if (splitSystem(system, data.contributions) === undefined) problems.push(`request ${event.id}: its system sections do not make up its system prompt`);
    for (const tool of tools ?? [])
      if (!data.contributions.some((part) => part.kind === "tool" && part.label === tool.name))
        problems.push(`request ${event.id}: tool ${tool.name} is not attributed`);
  }
  return problems;
}

/**
 * Why `request` does not extend `previous`, the request before it on its branch, when it says it does (it has no
 * `restart`): another system prompt or tools, thinking cut elsewhere, or a history that is not the previous one's with
 * more after it. Undefined when it does, so a provider's cache of the previous request serves it.
 */
export function brokenPrefix(previous: LlmRequest, request: LlmRequest): string | undefined {
  if (previous.system !== request.system) return "its system prompt differs from the previous request's";
  if (canonical(previous.tools ?? []) !== canonical(request.tools ?? [])) return "its tools differ from the previous request's";
  if (previous.thinkingFrom !== request.thinkingFrom) return "it cuts thinking elsewhere than the previous request";
  if (request.messages.length < previous.messages.length) return "it has fewer messages than the previous request";
  const changed = previous.messages.findIndex((message, index) => canonical(message) !== canonical(request.messages[index]));
  return changed === -1 ? undefined : `its message ${changed} differs from the previous request's`;
}

/** What one call of `Agent.prompt` came to, as its client saw it. */
export type Outcome =
  | { readonly kind: PromptOutcome["kind"] }
  | { readonly kind: "failed"; readonly reason: string }
  /** The call was cut off (its host stopped or crashed) before it answered: whether it was placed is unknown. */
  | { readonly kind: "unknown" };

/**
 * An outcome that says the prompt was not placed: answered by a plugin instead, or refused before it reached a turn
 * (`Busy`, or withdrawn). A turn that fails after placing it fails its call too, so a failure is not one; nor is `Io`,
 * as a journal write that failed may have landed part-way (renamed into place, its directory not synced).
 */
const refusedBeforePlacing = (outcome: Outcome): boolean =>
  outcome.kind === "handled" || outcome.kind === "refused" || (outcome.kind === "failed" && ["Busy", "Retracted"].includes(outcome.reason));

/** A prompt a client sent, by its request id, and what each attempt to send it came to. */
export interface Sent {
  readonly sessionId: string;
  readonly requestId: string;
  readonly outcomes: Outcome[];
  /** A withdrawal of it answered true. */
  withdrawn: boolean;
}

/** One assistant step's text as its deltas built it, for one call of the model (`seq` starts again at 1 for each). */
interface Streamed {
  text: string;
  seq: number;
  /** A delta went missing (a gap in `seq`): the text cannot be compared. */
  broken: boolean;
  /** Its last event (`done` or `error`) was heard: the host did not go before the checker heard it all. */
  ended: boolean;
}

/**
 * Checks what a simulated run must never do, as it runs and once it has settled: TigerBeetle's state checker. It
 * hears the agent and the log through a plugin of its own in each host (`observer`), and the clients' outcomes from
 * the workload; `audit` reads the log back (the store's and the disk's bytes) and checks it whole. Every problem is a
 * `violation`, which fails the run with its seed.
 */
export class Checker {
  readonly violations: string[] = [];
  /**
   * Fibers run in the order they become ready (not shuffled): the observers of two kinds of event then hear them in
   * the order they were published, so an order between them can be checked.
   */
  private readonly ordered: boolean;

  constructor(options: { readonly ordered?: boolean } = {}) {
    this.ordered = options.ordered ?? true;
  }

  /** Events the store reported appended (durable), by session and id, as they were then. */
  private readonly acked = new Map<string, Map<string, string>>();
  private readonly streamed = new Map<string, Streamed>();
  /** Where each running tool's output has reached, by call. */
  private readonly output = new Map<string, number>();
  /** Calls whose result is in: their output is over. */
  private readonly executed = new Set<string>();
  /** The newest queue each session's clients heard of, and its revision. */
  readonly queues = new Map<string, { readonly revision: number; readonly queue: readonly QueuedPrompt[] }>();
  readonly sent = new Map<string, Sent>();
  /** What the run did that a check counts on, for its coverage report. */
  readonly seen = new Map<string, number>();

  violation(message: string): void {
    this.violations.push(message);
  }

  count(what: string, by = 1): void {
    this.seen.set(what, (this.seen.get(what) ?? 0) + by);
  }

  /** The plugin, in each host, that hears what the agent, the tools, and the store report. Nothing it hears is dropped. */
  observer(): ReturnType<typeof definePlugin> {
    const unbounded = { buffer: 1 << 20, overflow: "suspend" } as const;
    const heard = {
      appended: (sessionId: string, event: SessionEvent) => this.appended(sessionId, event),
      delta: (key: string, seq: number, text: string, last: boolean) => this.delta(key, seq, text, last),
      toolOutput: (toolCallId: string, chunk: string, offset: number) => this.toolOutput(toolCallId, chunk, offset),
      executed: (toolCallId: string) => void this.executed.add(toolCallId),
      queueChanged: (sessionId: string, queue: readonly QueuedPrompt[], revision: number) => this.queueChanged(sessionId, queue, revision),
    };
    return definePlugin({
      id: "sim.checker",
      setup: function* () {
        const owner = yield* PluginContext;
        yield* owner.observe(SessionAppended, ({ sessionId, event }) => Effect.sync(() => heard.appended(sessionId, event)), unbounded);
        yield* owner.observe(
          AssistantDelta,
          ({ sessionId, stepId, seq, event }) =>
            Effect.sync(() =>
              heard.delta(`${sessionId}/${stepId}`, seq, event.type === "text-delta" ? event.delta : "", event.type === "done" || event.type === "error"),
            ),
          unbounded,
        );
        yield* owner.observe(ToolOutput, ({ toolCallId, chunk, offset }) => Effect.sync(() => heard.toolOutput(toolCallId, chunk, offset)), unbounded);
        yield* owner.observe(ToolExecuted, ({ invocation }) => Effect.sync(() => heard.executed(invocation.toolCallId)), unbounded);
        yield* owner.observe(QueueChanged, ({ sessionId, queue, revision }) => Effect.sync(() => heard.queueChanged(sessionId, queue, revision)), unbounded);
      },
    }) as ReturnType<typeof definePlugin>;
  }

  /** Events the store served: a client has them, so a later crash must not take them back (#26). */
  served(sessionId: string, events: readonly SessionEvent[]): void {
    for (const event of events) this.keep(sessionId, event);
  }

  private appended(sessionId: string, event: SessionEvent): void {
    this.keep(sessionId, event);
    this.count(`appended ${event.data.type}`);
  }

  private keep(sessionId: string, event: SessionEvent): void {
    let events = this.acked.get(sessionId);
    if (events === undefined) this.acked.set(sessionId, (events = new Map()));
    events.set(event.id, canonical(event));
  }

  private delta(key: string, seq: number, text: string, last: boolean): void {
    const current = seq === 1 ? undefined : this.streamed.get(key);
    if (seq === 1) this.streamed.set(key, { text, seq, broken: false, ended: last });
    else if (current === undefined || seq !== current.seq + 1) this.streamed.set(key, { text: "", seq, broken: true, ended: last });
    else Object.assign(current, { text: current.text + text, seq, ended: last });
  }

  /**
   * A tool's output only moves on: each chunk starts where the last ended, or at a point a batch dropped it from; and
   * all of it comes before the call's result, as a client showing the output takes the result to end it (checked where
   * the run's fibers are not shuffled, `ordered`).
   */
  private toolOutput(toolCallId: string, chunk: string, offset: number): void {
    if (this.ordered && this.executed.has(toolCallId)) this.violation(`tool call ${toolCallId}: output after its result`);
    const reached = this.output.get(toolCallId) ?? 0;
    if (offset < reached) this.violation(`tool call ${toolCallId}: output at offset ${offset} after output up to ${reached}`);
    this.output.set(toolCallId, offset + chunk.length);
    this.count("tool output");
  }

  /**
   * A queue's revision only grows, across restarts too, so a client keeps the newest queue it heard of. One told
   * again (a retry's) comes with its revision.
   */
  private queueChanged(sessionId: string, queue: readonly QueuedPrompt[], revision: number): void {
    const known = this.queues.get(sessionId);
    const again = known !== undefined && revision === known.revision && canonical(queue) === canonical(known.queue);
    if (known !== undefined && revision <= known.revision && !again) {
      this.violation(`session ${sessionId}: queue revision ${revision} after ${known.revision}, so a client keeps a stale queue`);
      return;
    }
    this.queues.set(sessionId, { revision, queue });
    this.count("queue changed");
  }

  /** A client sent `requestId`, and `outcome` is what it came to. */
  outcome(sessionId: string, requestId: string, outcome: Outcome): void {
    const key = `${sessionId}/${requestId}`;
    let sent = this.sent.get(key);
    if (sent === undefined) this.sent.set(key, (sent = { sessionId, requestId, outcomes: [], withdrawn: false }));
    sent.outcomes.push(outcome);
    this.count(`prompt ${outcome.kind === "failed" ? `failed ${outcome.reason}` : outcome.kind}`);
  }

  withdrew(sessionId: string, requestId: string): void {
    const key = `${sessionId}/${requestId}`;
    // Withdrawn while its call still waits, as a queued prompt's does: no outcome yet, but it must never be placed.
    let sent = this.sent.get(key);
    if (sent === undefined) this.sent.set(key, (sent = { sessionId, requestId, outcomes: [], withdrawn: false }));
    sent.withdrawn = true;
    this.count("withdrawn");
  }

  /**
   * After a host stopped or crashed, the next one's log keeps every event the store reported appended, as it was:
   * an append is reported only once it is durable.
   */
  survived(sessionId: string, events: readonly SessionEvent[]): void {
    const acked = this.acked.get(sessionId);
    if (acked === undefined) return;
    const now = new Map(events.map((event) => [event.id, canonical(event)]));
    for (const [id, event] of acked) {
      const kept = now.get(id);
      if (kept === undefined) this.violation(`session ${sessionId}: event ${id}, reported appended, is gone: ${event.slice(0, 200)}`);
      else if (kept !== event) this.violation(`session ${sessionId}: event ${id} changed since it was reported appended`);
    }
  }

  /**
   * The settled log, whole: `served` as the store serves each session, `file` as its file's bytes parse.
   * - The store serves what the file holds.
   * - Every request the log records rebuilds well formed (every call answered, no result without its call).
   * - Every request the model was asked is one the log rebuilds (compaction's summaries aside).
   * - Every turn the log closes answered each call it made, once.
   * - Each prompt was placed at most once; once if a call to send it answered `placed`; never if it was withdrawn, or
   *   every call to send it was answered without placing it (`refusedBeforePlacing`).
   * - A model call's streamed text is the text the log has for it.
   * - No call of `work`, unsafe to repeat, began twice.
   */
  audit(
    served: ReadonlyMap<string, readonly SessionEvent[]>,
    file: ReadonlyMap<string, readonly SessionEvent[]>,
    calls: readonly ModelCall[],
    tools: ToolRecord,
  ): void {
    for (const [sessionId, events] of served) {
      for (const problem of transcriptProblems(events)) this.violation(`session ${sessionId}: ${problem}`);
      const bytes = file.get(sessionId);
      if (bytes === undefined) this.violation(`session ${sessionId} is served but has no file`);
      else if (canonical(bytes) !== canonical(events))
        this.violation(`session ${sessionId}: the store serves ${events.length} events, its file holds ${bytes.length}`);
      this.survived(sessionId, events);
      for (const event of events) {
        if (event.data.type === "request") {
          const branch = branchOf(events, event.id);
          const rebuilt = rebuildRequest(branch, event.id, sessionId);
          if (rebuilt === undefined) this.violation(`session ${sessionId}: request ${event.id} does not rebuild`);
          else for (const problem of malformed(rebuilt.messages)) this.violation(`session ${sessionId}: request ${event.id}: ${problem}`);
          // A request that does not declare its prompt afresh extends the previous one's prefix, as sent.
          const previous = branch
            .slice(0, -1)
            .reverse()
            .find((earlier) => earlier.data.type === "request");
          if (rebuilt !== undefined && previous !== undefined && event.data.restart === undefined) {
            const broken = brokenPrefix(rebuildRequest(branch, previous.id, sessionId)!, rebuilt);
            if (broken !== undefined) this.violation(`session ${sessionId}: request ${event.id} has no restart, but ${broken}`);
          }
          this.count(event.data.restart === undefined ? "request" : `request ${event.data.restart}`);
        }
        if (event.data.type === "prompt-update") this.count("prompt-update");
        if (event.data.type === "turn-end") {
          // The calls the closed turn left on its branch: none without a result.
          const branch = branchOf(events, event.id);
          for (const problem of malformed(deriveMessages(branch))) this.violation(`session ${sessionId}: turn ${event.data.turnId} closed with ${problem}`);
          this.count(`turn ${event.data.reason}`);
        }
        if (event.data.type === "message" && event.data.message.role === "assistant" && event.data.stepId !== undefined) {
          const streamed = this.streamed.get(`${sessionId}/${event.data.stepId}`);
          const text = event.data.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
          if (streamed !== undefined && streamed.ended && !streamed.broken && streamed.text !== text) {
            this.violation(`session ${sessionId}: step ${event.data.stepId} streamed ${JSON.stringify(streamed.text)} but logged ${JSON.stringify(text)}`);
          }
        }
      }
    }
    // Every request a turn asked is in its session's log, as asked.
    const rebuilt = new Map<string, Set<string>>();
    for (const [sessionId, events] of served) {
      const requests = new Set<string>();
      for (const event of events) {
        if (event.data.type !== "request") continue;
        const request = rebuildRequest(branchOf(events, event.id), event.id, sessionId);
        if (request !== undefined) requests.add(canonical(request));
      }
      rebuilt.set(sessionId, requests);
    }
    for (const call of calls) {
      if (call.summary) continue;
      const sessionId = call.request.sessionId ?? "";
      if (!rebuilt.get(sessionId)?.has(canonical(call.request))) {
        this.violation(`session ${sessionId}: host ${call.host} asked the model a request the log does not rebuild`);
      }
    }
    // Exactly once.
    for (const sent of this.sent.values()) {
      const events = served.get(sent.sessionId) ?? [];
      const placed = events.filter(
        (event) => event.data.type === "message" && event.data.message.role === "user" && event.data.requestId === sent.requestId,
      ).length;
      const where = `session ${sent.sessionId}: prompt ${sent.requestId}`;
      if (placed > 1) this.violation(`${where} was placed ${placed} times`);
      if (sent.outcomes.some((outcome) => outcome.kind === "placed") && placed !== 1)
        this.violation(`${where} answered placed, but the log has it ${placed} times`);
      const never = sent.withdrawn || sent.outcomes.every(refusedBeforePlacing);
      if (never && placed > 0) {
        const answers = sent.outcomes.map((outcome) => (outcome.kind === "failed" ? `failed ${outcome.reason}` : outcome.kind)).join(", ");
        this.violation(`${where} was placed, though ${sent.withdrawn ? "withdrawn" : "every call to send it was answered without placing it"} (${answers})`);
      }
    }
    for (const [toolCallId, began] of tools.began) {
      if (began > 1) this.violation(`tool call ${toolCallId} of work, unsafe to repeat, began ${began} times`);
    }
  }
}
