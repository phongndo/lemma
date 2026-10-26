import { Clock, Effect } from "effect";
import type { ResultCredit } from "@lemma/contracts";
import type { ToolCall, ToolResultMessage } from "@lemma/llm";
import { ToolInvocation } from "@lemma/tools";
import { isCoreClosed } from "../errors.ts";
import { TOOLS_STARTED } from "../resume.ts";
import { boundary, unlessClosing } from "./context.ts";
import type { Turn } from "./context.ts";
import { errorResult } from "./log.ts";
import type { Offer } from "./request.ts";

/*
 * A step's tool calls: run through `ToolRunner.execute`, together where their tools allow, each result logged as it
 * arrives; or answered without running, for a response cut off at its limit or a turn that closes.
 */

/** What a tool call in a response cut off at its output limit returns, instead of running. */
const TRUNCATED_CALL =
  "Not run: your response reached its output token limit before this call was complete, so its arguments may be cut off. Make the call again; if it carries a lot of text (a long file), split it into smaller calls.";

/** The text a cut-off tool call that is not run again returns to the model. */
const interruptedText = (output: string | undefined) =>
  output === undefined || output === ""
    ? "Tool execution was interrupted: the host stopped while it ran. It may or may not have finished; check before running it again."
    : `Tool execution was interrupted: the host stopped while it ran. It may or may not have finished; check before running it again. Its output until then:\n${output}`;

/**
 * The calls that run next, from the first of `pending`: it alone, or, when it `joins` others, it and those right
 * after it that join too, `parallel` of them at most.
 */
export const nextGroup = (pending: readonly ToolCall[], joins: (call: ToolCall) => boolean, parallel: number): ToolCall[] => {
  const [first, ...rest] = pending as [ToolCall, ...ToolCall[]];
  const group = [first];
  if (joins(first)) {
    for (const call of rest) {
      if (!joins(call) || group.length >= parallel) break;
      group.push(call);
    }
  }
  return group;
};

/**
 * Runs one tool call and logs its result. A call in `interrupted` (cut off by a restart, and not safe to repeat) is
 * not run: the model is told so, with the output it had printed. `offer`: what the request offered, which holds the
 * call to the tools declared to the model, and the tools it runs to those offered.
 */
const runCall = (turn: Turn, stepId: string, call: ToolCall, interrupted: ReadonlyMap<string, string | undefined>, offer?: Offer) =>
  Effect.gen(function* () {
    const { services, input, log, state } = turn;
    const { sessionId, turnId, cwd, signal, live } = input;
    const startedAt = yield* Clock.currentTimeMillis;
    const invocation = new ToolInvocation({
      sessionId,
      toolCallId: call.id,
      name: call.name,
      input: call.arguments,
      cwd,
      ...(offer === undefined ? {} : { offered: offer.offered, declared: offer.declared }),
      ...(log.lastId === undefined ? {} : { leafId: log.lastId }),
    });
    // Run as the core shuts down, the call would fail for that alone (its tool not found, its guards closed).
    if (!interrupted.has(call.id)) yield* unlessClosing(turn);
    let credit: ResultCredit | undefined;
    const heard = (shaped: ResultCredit) => {
      if (Object.keys(shaped).length > 0) credit = shaped;
    };
    const result = interrupted.has(call.id)
      ? { content: [{ type: "text" as const, text: interruptedText(interrupted.get(call.id)) }], isError: true, details: undefined }
      : yield* services.tools.execute(invocation, signal, { credit: heard }).pipe(
          Effect.annotateSpans({ "tool.call.id": call.id, "tool.name": call.name }),
          Effect.map((value) => ({ content: value.content, isError: value.isError ?? false, details: value.details })),
          Effect.catch((error) =>
            isCoreClosed(error)
              ? Effect.die(error)
              : Effect.succeed({ content: [{ type: "text" as const, text: error.message }], isError: true, details: undefined }),
          ),
          Effect.catchDefect((defect) =>
            isCoreClosed(defect)
              ? Effect.die(defect)
              : Effect.succeed({
                  content: [{ type: "text" as const, text: `Tool ${call.name} crashed: ${String(defect)}` }],
                  isError: true,
                  details: undefined,
                }),
          ),
        );
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: result.isError,
      timestamp: yield* Clock.currentTimeMillis,
    };
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* log.append({
          type: "message",
          message,
          turnId,
          stepId,
          timing: { startedAt, endedAt: message.timestamp },
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(credit === undefined ? {} : { credit }),
        });
        state.pending = state.pending.filter((pending) => pending.id !== call.id);
        live.toolEnded(call.id);
      }),
    );
    return message;
  });

/**
 * Runs the pending tool calls, logging each result as it arrives: in order,
 * except that a run of calls whose tools may run together (`parallel`) runs
 * at once, up to `parallelTools` of them. Before calls run, an event names
 * them (`TOOLS_STARTED`), so a restart can tell a call that began from one
 * that never did. Returns the results in call order.
 */
export const runTools = (turn: Turn, stepId: string, interrupted: ReadonlyMap<string, string | undefined> = new Map(), offer?: Offer) =>
  Effect.gen(function* () {
    const { services, input, log, settings, state } = turn;
    const together = new Set((yield* services.tools.list).flatMap((tool) => (tool.parallel === "safe" ? [tool.spec.name] : [])));
    const joins = (call: ToolCall) => together.has(call.name) && !interrupted.has(call.id);
    const order = new Map(state.pending.map((call, index) => [call.id, index]));
    const results: ToolResultMessage[] = [];
    while (state.pending.length > 0) {
      // `cancel` aborts before it interrupts; start nothing new in between. A stopping agent suspends here.
      if (input.signal.aborted) return yield* Effect.interrupt;
      yield* boundary(turn);
      // The next call, and when it may run together with others, those after it that may too.
      const group = nextGroup(state.pending, joins, settings.parallelTools);
      const running = group.filter((call) => !interrupted.has(call.id));
      if (running.length > 0) {
        yield* unlessClosing(turn);
        yield* log.append({ type: "custom", kind: TOOLS_STARTED, data: { turnId: input.turnId, stepId, toolCallIds: running.map((call) => call.id) } });
        for (const call of running) state.started.add(call.id);
      }
      // Every call named starts now: none waits for another to finish first.
      yield* Effect.forEach(
        group,
        (call) =>
          Effect.map(runCall(turn, stepId, call, interrupted, offer), (message) => {
            results.push(message);
          }),
        { concurrency: "unbounded", discard: true },
      );
    }
    return results.sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0));
  });

/** Answers each pending call, in order, with `text(call)`, without running it; a call leaves `pending` once its answer is logged. */
export const answerPending = (turn: Turn, stepId: string | undefined, text: (call: ToolCall) => string) =>
  Effect.gen(function* () {
    const { input, log, state } = turn;
    const results: ToolResultMessage[] = [];
    while (state.pending.length > 0) {
      const call = state.pending[0]!;
      const message = errorResult(call, text(call), yield* Clock.currentTimeMillis);
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* log.append({ type: "message", message, turnId: input.turnId, ...(stepId === undefined ? {} : { stepId }) });
          state.pending = state.pending.slice(1);
          input.live.toolEnded(call.id);
        }),
      );
      results.push(message);
    }
    return results;
  });

/** A response cut off at its output limit: its tool calls may be cut off too, so none runs, and each is answered for the model to make again. */
export const answerTruncated = (turn: Turn, stepId: string) => answerPending(turn, stepId, () => TRUNCATED_CALL);
