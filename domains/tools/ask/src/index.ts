import { Clock, Data, Deferred, Duration, Effect, Option, Schema, Stream, SubscriptionRef } from "effect";
import { definePlugin } from "@lemma/core";
import { Channels, serveChannel } from "@lemma/contracts";
import { AgentInputHook, QueueChanged } from "@lemma/agent";
import { ToolError, ToolResult, Tools } from "@lemma/tools";
import { AskChannels } from "./channels.ts";
import type { OpenQuestions } from "./channels.ts";
import { AskInput, answerProblem, inputProblem, resultText } from "./questions.ts";
import type { AskDetails, AskOutcome } from "./questions.ts";

export { AskChannels, OpenQuestions } from "./channels.ts";
export { AskInput, AskOption, AskQuestion, QuestionAnswer, answerProblem, displayLabel, inputProblem, resultText } from "./questions.ts";
export type { AskDetails, AskOutcome } from "./questions.ts";

/** `NotFound`: no call with that id is open; `InvalidAnswer`: the answer does not fit its questions. Clients see the reason as the code. */
export class AskError extends Data.TaggedError("AskError")<{ readonly reason: "NotFound" | "InvalidAnswer"; readonly message: string }> {}

const Config = Schema.Struct({
  waitForClientMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 15_000)))
    .annotate({
      title: "Wait for a client (ms)",
      description:
        "When no client that answers questions is connected as the agent asks (the web app is closed, or reconnecting), how long to wait for one before telling the agent nobody can answer.",
    }),
});

export const DESCRIPTION = [
  "Asks the user one to four multiple-choice questions together and waits for their answers.",
  "Use it when a decision is the user's to make and the request, the code, and sensible defaults do not settle it: which approach to take, what they prefer, what they meant.",
  "Do not use it to ask permission to act, to confirm a plan you could simply carry out, or for anything you can find out yourself by reading or running things.",
  'Ask everything you need in one call. Give each question two to four options, and put the one you recommend first, ending its label with " (Recommended)".',
  'The user can always write their own answer, add a note, or skip a question, so never add an "Other" option.',
  "They may also reply with a message instead of answering; then read it and go on from there.",
].join(" ");

/**
 * A call by its session and its id: a provider that sends no ids gives every call the same one, and one session has at
 * most one call open (`ask_user` runs alone).
 */
const callKey = (call: { readonly sessionId: string; readonly toolCallId: string }) => `${call.sessionId}\u0000${call.toolCallId}`;

interface Pending {
  readonly open: OpenQuestions;
  readonly answer: Deferred.Deferred<AskOutcome>;
}

/**
 * The `ask_user` tool: questions for the user, held open until a client answers them through the `ask.*` channels,
 * which its web half draws above the composer. A message sent to the session meanwhile joins the turn as a steer and
 * answers them as a reply; a plugin's notice does not. With no client that answers connected, the model is told nobody
 * is available.
 */
export default definePlugin({
  id: "tools.ask",
  version: "0.1.0",
  config: Config,
  setup: function* (_, owner) {
    const pending = new Map<string, Pending>();
    const open = yield* SubscriptionRef.make<readonly OpenQuestions[]>([]);
    /** Clients with `ask.open` open: those that can answer. */
    const watchers = yield* SubscriptionRef.make(0);
    /**
     * Sessions with a person's steer queued: a question asked now would hold it back, so the steer answers it. A plugin's
     * notice (`QueuedPrompt.source`) answers nothing: it waits behind the questions.
     */
    const steering = new Set<string>();

    const settle = (key: string, outcome: AskOutcome) =>
      Effect.suspend(() => {
        const found = pending.get(key);
        if (found === undefined) return Effect.void;
        pending.delete(key);
        return Deferred.succeed(found.answer, outcome);
      });
    const replied = (sessionId: string) =>
      Effect.forEach(
        [...pending.entries()].filter(([, entry]) => entry.open.sessionId === sessionId),
        ([key]) => settle(key, { kind: "replied" }),
        { discard: true },
      );

    /** Whether a client that answers is connected, or connects within `waitForClientMs` (a reload, a host restart). */
    const someoneWatches = Effect.flatMap(SubscriptionRef.get(watchers), (count) =>
      count > 0
        ? Effect.succeed(true)
        : Stream.runHead(Stream.filter(SubscriptionRef.changes(watchers), (now) => now > 0)).pipe(
            Effect.timeoutOption(Duration.millis(owner.config.waitForClientMs)),
            Effect.map(Option.isSome),
          ),
    );

    /** Holds the questions open until they are answered or replied to; withdrawn when the turn's cancel interrupts the tool. */
    const hold = (entry: Pending) => {
      const key = callKey(entry.open);
      const others = (list: readonly OpenQuestions[]) => list.filter((other) => callKey(other) !== key);
      return Effect.andThen(
        SubscriptionRef.update(open, (list) => [...others(list), entry.open]),
        Deferred.await(entry.answer).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (pending.get(key) === entry) pending.delete(key);
              return SubscriptionRef.update(open, others);
            }),
          ),
        ),
      );
    };

    const ask = (input: AskInput, sessionId: string, toolCallId: string) =>
      Effect.gen(function* () {
        const problem = inputProblem(input);
        if (problem !== undefined) return yield* new ToolError({ tool: "ask_user", reason: "InvalidInput", message: problem });
        const result = (outcome: AskOutcome) => {
          const details: AskDetails = { questions: input.questions, outcome };
          return new ToolResult({ content: [{ type: "text", text: resultText(details) }], details });
        };
        // A steer queued before the call, or while it waited for a client, answers it at once.
        if (steering.has(sessionId)) return result({ kind: "replied" });
        if (!(yield* someoneWatches)) return result({ kind: "unavailable" });
        const entry: Pending = {
          open: { sessionId, toolCallId, questions: input.questions, at: yield* Clock.currentTimeMillis },
          answer: yield* Deferred.make<AskOutcome>(),
        };
        // Checked and registered in one step, so a steer's `QueueChanged` lands on one side of it or the other.
        const steered = yield* Effect.sync(() => {
          if (steering.has(sessionId)) return true;
          pending.set(callKey(entry.open), entry);
          return false;
        });
        return result(steered ? { kind: "replied" } : yield* hold(entry));
      });

    yield* owner.add(Tools, {
      name: "ask_user",
      description: DESCRIPTION,
      input: AskInput,
      // Its result is the transcript's record of the answers, so it is logged as its own.
      direct: true,
      // A call a host restart cut off asks again: asking twice does no harm, and a client keeps what was typed.
      replay: "safe",
      execute: (input, { sessionId, toolCallId }) => ask(input, sessionId, toolCallId),
    });

    // Sent while the agent waits on questions, a follow-up would wait behind the questions it answers: it steers instead.
    yield* owner.on(AgentInputHook, (input, next) =>
      Effect.suspend(() =>
        (input.options.whenBusy ?? "follow-up") === "follow-up" && [...pending.values()].some((entry) => entry.open.sessionId === input.sessionId)
          ? next({ ...input, options: { ...input.options, whenBusy: "steer" } })
          : next(input),
      ),
    );
    yield* owner.observe(QueueChanged, ({ sessionId, queue }) =>
      Effect.suspend(() => {
        if (!queue.some((prompt) => prompt.mode === "steer" && prompt.source === undefined)) {
          steering.delete(sessionId);
          return Effect.void;
        }
        steering.add(sessionId);
        return replied(sessionId);
      }),
    );

    // A client that falls behind gets the latest list, not a backlog.
    yield* owner.add(
      Channels,
      serveChannel(AskChannels.open, () =>
        Stream.unwrap(
          Effect.as(
            Effect.acquireRelease(
              SubscriptionRef.update(watchers, (count) => count + 1),
              () => SubscriptionRef.update(watchers, (count) => count - 1),
            ),
            SubscriptionRef.changes(open).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" })),
          ),
        ),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(AskChannels.answer, ({ sessionId, toolCallId, answers }) =>
        Effect.gen(function* () {
          const key = callKey({ sessionId, toolCallId });
          const found = pending.get(key);
          if (found === undefined)
            return yield* new AskError({
              reason: "NotFound",
              message: `No open questions "${toolCallId}" in ${sessionId}: they were answered, or their turn ended`,
            });
          const problem = answerProblem(found.open.questions, answers);
          if (problem !== undefined) return yield* new AskError({ reason: "InvalidAnswer", message: problem });
          yield* settle(key, { kind: "answered", answers });
        }),
      ),
    );
  },
});
