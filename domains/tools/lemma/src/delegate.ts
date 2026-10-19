import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Cause, Effect, Exit, Schedule, Schema, Semaphore } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import type { Interaction } from "@lemma/contracts";
import { AgentChannels } from "@lemma/agent";
import { contentText } from "@lemma/llm";
import { branchOf, SessionChannels, trajectory } from "@lemma/sessions";
import type { SessionEvent, SessionInfo } from "@lemma/sessions";
import { ToolResult } from "@lemma/tools";
import type { Tool } from "@lemma/tools";
import { callValue, failure, isCode, jsonResult, NAMESPACE, permission } from "./channels.ts";

type Reader = Context.Service.Shape<typeof Registries>;
type Asker = Context.Service.Shape<typeof Interaction>;

/**
 * The request id a delegated prompt is sent with, which the session's log keeps on its user message: how deep the
 * delegation is (1 for a session a top-level session started), so a delegate's own delegations are counted from its
 * log, across restarts, with nothing else written.
 */
const REQUEST_PREFIX = "tools.lemma/delegate/";
const requestIdAt = (depth: number) => `${REQUEST_PREFIX}${depth}/${randomUUID()}`;

/** How deep in delegations a session is: 0 for one a person started, else what its first delegated prompt says. */
export const depthOf = (events: readonly SessionEvent[]): number => {
  for (const event of events) {
    if (event.data.type !== "message" || event.data.message.role !== "user") continue;
    const match = /^tools\.lemma\/delegate\/(\d+)\//.exec(event.data.requestId ?? "");
    return match === null ? 0 : Number(match[1]);
  }
  return 0;
};

export const DelegateInput = Schema.Struct({
  prompt: Schema.NonEmptyString.annotate({ description: "The task, as the new session's first prompt: all it knows of it" }),
  title: Schema.optional(Schema.String.annotate({ description: "The session's title in the sidebar (default: the prompt's first line)" })),
  cwd: Schema.optional(Schema.String.annotate({ description: "The session's directory (default: this session's)" })),
  model: Schema.optional(Schema.String.annotate({ description: 'The model, as "provider/id" (default: the agent\'s)' })),
  timeoutMs: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
      description: "How long to wait for the turn, in milliseconds; past it the turn is cancelled (default: no limit)",
    }),
  ),
});
export type DelegateInput = typeof DelegateInput.Type;

/** How the delegated turn ended: as its log says, `timeout` when it was cancelled for taking too long, or a plugin answered the prompt itself. */
const Ended = Schema.Literals(["done", "error", "cancelled", "max-steps", "timeout", "handled", "refused"]);

export const DelegateOutput = Schema.Struct({
  sessionId: Schema.String,
  ended: Ended,
  /** The session's last reply: the turn's answer. */
  answer: Schema.String,
  error: Schema.optional(Schema.String),
});
export type DelegateOutput = typeof DelegateOutput.Type;

/** The answer and end of the turn that placed `requestId`, from the session's log, as `lemma run` reads it. */
export const summarize = (info: SessionInfo, events: readonly SessionEvent[], requestId: string) => {
  const placed = events.find((event) => event.data.type === "message" && event.data.requestId === requestId);
  const turnId = placed?.data.type === "message" ? placed.data.turnId : undefined;
  // On that turn's own branch, through its last event: a checkout since may have left it off the session's.
  const last = turnId === undefined ? undefined : events.filter((event) => "turnId" in event.data && event.data.turnId === turnId).at(-1);
  const turns = trajectory(branchOf(events, last?.id ?? info.leaf));
  const turn = turnId === undefined ? undefined : turns.find((candidate) => candidate.turnId === turnId);
  const response = turn?.steps.filter((step) => step.response !== undefined).at(-1)?.response;
  return {
    reason: turn?.end?.reason,
    error: turn?.end?.error,
    answer: response === undefined ? "" : contentText(response.message.content),
  };
};

export interface DelegateOptions {
  readonly registries: Reader;
  readonly interaction: Asker;
  /** Delegations running at once at each depth; more wait for one to end. */
  readonly maxDelegations: number;
  /** How deep delegations go: a session this many levels down delegates no further. */
  readonly maxDepth: number;
  /** Ask the person before each delegation. */
  readonly confirm: boolean;
  readonly budget: number;
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
};

/**
 * `lemma_delegate`: a new session in this one's directory, given the prompt, and waited on until the turn it starts
 * ends; resolves to the session, how the turn ended, and its answer. Cancelling the call, or passing `timeoutMs`,
 * cancels the turn.
 */
export const delegateTool = (options: DelegateOptions): Tool<DelegateInput> => {
  // Counted at each depth apart: a delegation holds its slot until its turn ends, which waits on that session's own
  // delegations, so with one count for all, parents holding every slot would wait for ever on children waiting for one.
  const levels = new Map<number, Semaphore.Semaphore>();
  const slotsAt = (depth: number) => {
    let slots = levels.get(depth);
    if (slots === undefined) levels.set(depth, (slots = Semaphore.makeUnsafe(options.maxDelegations)));
    return slots;
  };
  const { registries } = options;
  const output = (result: DelegateOutput, context: Parameters<Tool["execute"]>[1], isError = false) =>
    Effect.map(jsonResult(result, context, options.budget, { sessionId: result.sessionId }), (made) =>
      isError ? new ToolResult({ ...made, isError: true }) : made,
    );
  return {
    name: "lemma_delegate",
    description:
      "Hands a task to a new Lemma session and waits for its turn to end: resolves to { sessionId, ended, answer, error? }. The session starts with only the prompt, so say everything it needs. Several run at once with Promise.all.",
    input: DelegateInput,
    output: DelegateOutput,
    nested: true,
    namespace: NAMESPACE,
    execute: (input, context) =>
      Effect.gen(function* () {
        const own = yield* callValue(registries, SessionChannels.events, { sessionId: context.sessionId }).pipe(
          // A call outside any session (a test, a script's own) is at the top, whether the store says so as the
          // transport does (`HostError`) or as itself (`SessionError`).
          Effect.catchIf(isCode("NotFound"), () => Effect.succeed([] as readonly SessionEvent[])),
        );
        const depth = depthOf(own);
        if (depth >= options.maxDepth) {
          return new ToolResult({
            content: [
              { type: "text", text: `This session is a delegate ${depth} levels deep, as deep as delegations go (${options.maxDepth}): do the task here.` },
            ],
            isError: true,
          });
        }
        // A directory that is not there would give the session nothing to work in: refused before a session is made.
        if (input.cwd !== undefined) {
          const where = input.cwd;
          const isDirectory = yield* Effect.promise(() =>
            stat(where).then(
              (found) => found.isDirectory(),
              () => false,
            ),
          );
          if (!isDirectory)
            return new ToolResult({ content: [{ type: "text", text: `No session was started: ${where} is not a directory on this host.` }], isError: true });
        }
        if (options.confirm) {
          const refused = yield* permission(options.interaction, "Let the agent start a session for a task?", {
            prompt: input.prompt,
            cwd: input.cwd ?? context.cwd,
          });
          if (refused !== undefined) return new ToolResult({ content: [{ type: "text", text: `No session was started: ${refused}` }], isError: true });
        }
        return yield* slotsAt(depth).withPermits(1)(
          Effect.gen(function* () {
            const info = yield* callValue(registries, SessionChannels.create, { cwd: input.cwd ?? context.cwd });
            const sessionId = info.id;
            yield* callValue(registries, SessionChannels.setTitle, { sessionId, title: input.title ?? firstLine(input.prompt) }).pipe(Effect.ignore);
            const requestId = requestIdAt(depth + 1);
            const cancel = callValue(registries, AgentChannels.cancel, { sessionId }).pipe(Effect.ignore);
            const prompting = callValue(registries, AgentChannels.prompt, {
              sessionId,
              content: [{ type: "text", text: input.prompt }],
              requestId,
              whenBusy: "reject",
              ...(input.model === undefined ? {} : { options: { model: input.model } }),
            }).pipe(
              // The outer call cancelled, or the wait timed out: the turn it started goes too.
              Effect.onInterrupt(() => cancel),
            );
            const raced = yield* Effect.exit(
              input.timeoutMs === undefined ? prompting : Effect.raceFirst(prompting, Effect.as(Effect.sleep(input.timeoutMs), "timeout" as const)),
            );
            if (Exit.isFailure(raced)) {
              // The agent refused the prompt before placing it (an unknown model, say): the session it would have run in
              // holds only its title, so it goes, and no session is left behind.
              if (Cause.hasInterruptsOnly(raced.cause)) return yield* Effect.failCause(raced.cause);
              // The agent holds the session a moment longer while it settles the refusal: deleting waits that out.
              yield* callValue(registries, SessionChannels.delete, { sessionId }).pipe(
                Effect.retry({ while: isCode("Busy"), schedule: Schedule.spaced("100 millis"), times: 30 }),
                Effect.ignore,
              );
              const reason = failure("agent.prompt", Cause.squash(raced.cause));
              return new ToolResult({ content: [{ type: "text", text: `No session was started: ${reason}` }], isError: true });
            }
            const outcome = raced.value;
            // A timeout interrupted the prompt's call, which cancelled the turn; a plugin may have answered the prompt itself.
            if (outcome !== "timeout" && outcome.kind === "handled")
              return yield* output({ sessionId, ended: "handled", answer: outcome.message ?? "" }, context);
            if (outcome !== "timeout" && outcome.kind === "refused")
              return yield* output({ sessionId, ended: "refused", answer: "", error: `${outcome.by} refused the prompt: ${outcome.reason}` }, context, true);
            const [now, events] = yield* Effect.all(
              [callValue(registries, SessionChannels.get, { sessionId }), callValue(registries, SessionChannels.events, { sessionId })],
              { concurrency: "unbounded" },
            );
            const turn = summarize(now, events, requestId);
            const ended = outcome === "timeout" ? "timeout" : (turn.reason ?? "error");
            const result: DelegateOutput = {
              sessionId,
              ended,
              answer: turn.answer,
              ...(turn.error === undefined
                ? ended === "timeout"
                  ? { error: `No answer within ${input.timeoutMs} ms; the turn was cancelled` }
                  : {}
                : { error: turn.error }),
            };
            return yield* output(result, context, ended !== "done");
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(new ToolResult({ content: [{ type: "text", text: failure("lemma_delegate", error) }], isError: true })))),
  };
};
