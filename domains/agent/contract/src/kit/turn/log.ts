import { Clock, Effect, Semaphore } from "effect";
import type { Context } from "effect";
import { assert, Verify } from "@lemma/core";
import { modelEntries, nextRequestState, requestState } from "@lemma/sessions";
import type { ToolCall, ToolResultMessage } from "@lemma/llm";
import type { EventData, RequestState, SessionEvent, Sessions } from "@lemma/sessions";
import type { AgentError } from "../../agent.ts";
import type { KeptBranch } from "../turn.ts";
import { failedAs } from "../errors.ts";

/*
 * What a turn has logged: its appends, each naming the turn's last event as its parent, and the branch they make,
 * kept as the turn appends so a step does not read the session back.
 */

/** What a tool call the branch left without a result tells the model. */
export const BRANCHED_CALL = "No result was recorded for this tool call: the conversation continued without it.";

/** An error result for `call`, logged without running it. */
export const errorResult = (call: ToolCall, text: string, timestamp: number): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text }],
  isError: true,
  timestamp,
});

/**
 * The last assistant message on `branch` the model sees, and its tool calls
 * that have no result after it. A turn answers its calls, so this is set
 * where a checkout put the leaf inside a turn, or a turn ended without
 * logging its results (a write that failed).
 */
export function unansweredCalls(branch: readonly SessionEvent[]): { readonly event: SessionEvent; readonly calls: readonly ToolCall[] } | undefined {
  const entries = modelEntries(branch);
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at]!;
    if (entry.summary === true || entry.message.role !== "assistant") continue;
    const answered = new Set(entries.slice(at + 1).flatMap((later) => (later.message.role === "toolResult" ? [later.message.toolCallId] : [])));
    const calls = entry.message.content.filter((block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id));
    return calls.length === 0 ? undefined : { event: branch[entry.index]!, calls };
  }
  return undefined;
}

/** A turn's appends to its session, and the branch they end. */
export class TurnLog {
  /** The turn's last event: every append names it as its parent, so a checkout elsewhere cannot splice the turn. */
  lastId: string | undefined;
  /**
   * The branch ending at `lastId`, kept as the turn appends (every event it appends chains onto it), so a step does
   * not read the session back. Read from the store when there is none yet, or an append did not chain onto it.
   */
  branch: SessionEvent[] | undefined;
  /** `requestState(branch)`, kept as the branch is. */
  request: RequestState | undefined;
  /** One append at a time, so tool calls running together each chain after the last. */
  private readonly appending = Semaphore.makeUnsafe(1);
  private readonly sessions: Context.Service.Shape<typeof Sessions>;
  private readonly sessionId: string;
  private readonly sessionError: (error: { readonly message: string }) => AgentError;

  constructor(sessions: Context.Service.Shape<typeof Sessions>, sessionId: string) {
    this.sessions = sessions;
    this.sessionId = sessionId;
    this.sessionError = failedAs(sessionId, "Session");
  }

  /** Uninterruptible, so a cancelled turn never loses track of an event that did reach the log. */
  append(data: EventData): Effect.Effect<SessionEvent, AgentError> {
    return this.appending.withPermits(1)(
      Effect.uninterruptible(
        Effect.suspend(() => this.sessions.append(this.sessionId, data, this.lastId === undefined ? undefined : { parent: this.lastId })).pipe(
          Effect.tap((event) =>
            Effect.sync(() => {
              this.lastId = event.id;
              const branch = this.branch;
              if (branch !== undefined && event.parent === (branch.at(-1)?.id ?? null)) {
                branch.push(event);
                this.request = nextRequestState(this.request!, event);
              } else {
                this.branch = undefined;
                this.request = undefined;
              }
            }),
          ),
          Effect.mapError(this.sessionError),
        ),
      ),
    );
  }

  /** `branch`, read from the store, as the turn's branch from here on. */
  keep(branch: readonly SessionEvent[]): void {
    this.branch = [...branch];
    this.request = requestState(branch);
  }

  /** The turn's branch, ending at `lastId`: kept, or read from the store when it is not. */
  get branchNow(): Effect.Effect<SessionEvent[], AgentError> {
    return Effect.suspend(() =>
      this.branch !== undefined
        ? Effect.succeed(this.branch)
        : this.sessions.branch(this.sessionId, { leaf: this.lastId! }).pipe(
            Effect.mapError(this.sessionError),
            Effect.map((branch) => {
              this.keep(branch);
              return this.branch!;
            }),
          ),
    );
  }
}

/**
 * Where a new turn starts: the branch the last turn left (`kept`), if the session's leaf has not moved since (no
 * checkout, no other append), or the session's branch read back. Answers the tool calls a branch read back left
 * without a result, before the turn starts after them: every request needs a result for each call, and a provider
 * adapter that made one up would send what the log does not hold. The results name the call's own turn and step, as
 * that turn's closing results would.
 */
export const openBranch = (
  log: TurnLog,
  sessions: Context.Service.Shape<typeof Sessions>,
  sessionId: string,
  kept: { readonly take: () => KeptBranch | undefined } | undefined,
) =>
  Effect.gen(function* () {
    const sessionError = failedAs(sessionId, "Session");
    // The branch the last turn left, if the session's leaf has not moved since: no reading it all back.
    const taken = kept?.take();
    const leaf = taken === undefined ? undefined : (yield* sessions.get(sessionId).pipe(Effect.mapError(sessionError))).leaf;
    if (taken !== undefined && leaf !== undefined && taken.events.at(-1)?.id === leaf) {
      // Taken, so the turn's own: it goes on appending to it, copying nothing.
      log.lastId = leaf;
      log.branch = taken.events;
      log.request = taken.request;
      // A kept branch is one a turn closed, answering every call it made (`close`): only one read back can leave some.
      if (yield* Verify) assert(unansweredCalls(taken.events) === undefined, `session ${sessionId} kept a branch with tool calls unanswered`);
      return;
    }
    const branch = yield* sessions.branch(sessionId).pipe(Effect.mapError(sessionError));
    // The turn follows the leaf just read, answered or not: a checkout meanwhile cannot move it onto unanswered calls.
    log.lastId = branch.at(-1)?.id;
    log.keep(branch);
    const open = unansweredCalls(branch);
    if (open === undefined || open.event.data.type !== "message") return;
    const { turnId: callTurn, stepId: callStep } = open.event.data;
    for (const call of open.calls) {
      yield* log.append({
        type: "message",
        message: errorResult(call, BRANCHED_CALL, yield* Clock.currentTimeMillis),
        ...(callTurn === undefined ? {} : { turnId: callTurn }),
        ...(callStep === undefined ? {} : { stepId: callStep }),
      });
    }
  });
