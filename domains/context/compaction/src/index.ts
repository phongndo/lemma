import { isDeepStrictEqual } from "node:util";
import { Clock, Data, Effect, Stream } from "effect";
import { inChainOrder, Notice } from "@lemma/contracts";
import { AgentInputHook, AgentRequestHook } from "@lemma/agent";
import { CompactionError, CompactionHook } from "@lemma/context";
import type { CompactionRequest, CompactionResult } from "@lemma/context";
import { Llm, LlmRequest } from "@lemma/llm";
import { modelView, SessionRemoved } from "@lemma/sessions";
import { declaredTools } from "@lemma/tools";
import type { PromptContent, RequestDraft } from "@lemma/agent";
import type { ModelInfo, StreamEvent } from "@lemma/llm";
import { definePlugin, Events, Hooks } from "@lemma/core";
import type { HandlerStep } from "@lemma/core";
import { chooseCut, estimateTokens, SUMMARY_PROMPT, summaryAsk, transcript, validCut, viewTokens } from "./compact.ts";
import { Config } from "./config.ts";

export { chooseCut, estimateTokens, measuredTokens, transcript } from "./compact.ts";

class SummaryFailed extends Data.TaggedError("SummaryFailed")<{ readonly message: string }> {}

/**
 * Tokens set aside for the framing of what is sent beyond its text (the system prompt and the ask are counted as
 * characters), and the characters a token is taken to be at most in what is sent.
 */
const PROMPT_TOKENS = 200;
const DENSE_CHARS_PER_TOKEN = 1.5;

/**
 * What a prompt asks of compaction: undefined unless it is `/compact`, alone or with what the summary should focus on
 * (`instructions`), in text only.
 */
export const compactAsked = (content: PromptContent): { readonly instructions?: string } | undefined => {
  if (content.some((part) => part.type !== "text")) return undefined;
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(
    content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim(),
  );
  if (match === null) return undefined;
  const instructions = match[1]?.trim();
  return instructions === undefined || instructions === "" ? {} : { instructions };
};

/** Characters of a request besides its messages: its system prompt, and the tools the model is sent, not those only a tool calls. */
export const requestChars = (draft: Pick<RequestDraft, "sections" | "tools">): number =>
  draft.sections.reduce((sum, section) => sum + section.text.length, 0) + JSON.stringify(declaredTools(draft.tools).map((tool) => tool.spec)).length;

/**
 * Keeps a conversation within its model's context window: before a model
 * call that would fill more than `at` of the window, the older part of the
 * turn's history is summarized by a model and a `compaction` event is
 * appended to the turn (`RequestDraft.append`), which every reader of the log
 * (`deriveMessages`) then shows the model in place of that part. The log
 * keeps every original event.
 */
export default definePlugin({
  id: "context.compaction",
  version: "0.1.0",
  config: Config,
  requires: { llm: Llm },
  setup: function* ({ llm }, owner) {
    const config = owner.config;
    const events = yield* Events;
    const hooks = yield* Hooks;
    /** Per session, the turn in which writing a summary failed: not tried again until the next turn. */
    const failedIn = new Map<string, string>();
    /** Per session, a compaction the user asked for (`/compact`), made before the session's next model call. */
    const requested = new Map<string, { readonly instructions?: string }>();

    const summarize = (writer: ModelInfo, ask: string, output: number, sessionId: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          llm
            .stream(
              new LlmRequest({
                model: writer.ref,
                system: SUMMARY_PROMPT,
                messages: [{ role: "user", content: [{ type: "text", text: ask }], timestamp: now }],
                maxTokens: output,
                sessionId,
              }),
            )
            .pipe(
              Stream.runFold(
                (): Extract<StreamEvent, { type: "done" | "error" }> | undefined => undefined,
                (last, event) => (event.type === "done" || event.type === "error" ? event : last),
              ),
              Effect.flatMap((settled) => {
                if (settled?.type !== "done") return Effect.fail(new SummaryFailed({ message: settled?.message.errorMessage ?? "the model gave no summary" }));
                // A summary cut off at its length limit would lose the rest of what it replaces.
                if (settled.message.stopReason === "length") return Effect.fail(new SummaryFailed({ message: `the summary ran past ${output} tokens` }));
                const summary = settled.message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("")
                  .trim();
                return summary === ""
                  ? Effect.fail(new SummaryFailed({ message: "the model gave an empty summary" }))
                  : Effect.succeed({ summary, usage: settled.message.usage });
              }),
            ),
        ),
      );

    /** `CompactionHook`'s terminal: a model (the config's, else the request's) summarizes what comes before the cut. */
    const write = (asked: CompactionRequest): Effect.Effect<CompactionResult, CompactionError> =>
      Effect.gen(function* () {
        const kept = asked.branch[asked.firstKept];
        if (kept === undefined) return { kind: "skip", reason: `no event at ${asked.firstKept} to keep from` } as const;
        // A handler may have moved the cut (`next`): never between a tool call and its result, nor outside the view.
        if (!validCut(asked.branch, asked.firstKept)) return yield* new SummaryFailed({ message: `the history cannot be kept from event ${asked.firstKept}` });
        const { start } = modelView(asked.branch);
        const older = asked.branch.slice(start, asked.firstKept).flatMap((event) => (event.data.type === "message" ? [event.data.message] : []));
        const writer = yield* llm.model(config.model ?? asked.model);
        // What is sent fits the writer's window with its answer, even for text as dense as 1.5 characters a token.
        const output = Math.min(8_192, writer.maxTokens, Math.floor(writer.contextWindow / 4));
        // What is sent besides the transcript, the system prompt and the ask around it, comes out of its room.
        const around = SUMMARY_PROMPT.length + summaryAsk("", asked.previous !== undefined, asked.instructions).length;
        const budget = Math.floor((writer.contextWindow - output - PROMPT_TOKENS) * DENSE_CHARS_PER_TOKEN) - around;
        const text = transcript(older, asked.previous, budget);
        const written = yield* summarize(writer, summaryAsk(text, asked.previous !== undefined, asked.instructions), output, asked.sessionId);
        return { kind: "summary", summary: written.summary, firstKeptId: kept.id, usage: written.usage } as const;
      }).pipe(Effect.mapError((error) => new CompactionError({ message: error.message, cause: error })));

    const compact = (draft: RequestDraft) =>
      Effect.gen(function* () {
        const model = yield* llm.model(draft.model);
        const branch = draft.branch;
        const tokens = estimateTokens(branch, () => requestChars(draft));
        // The previous call was refused as too long (the estimate was wrong), or the user asked: summarize now. An
        // overflow's compaction is not the user's: theirs stays asked for, and the call after it makes it.
        const asked = draft.overflow === true ? undefined : requested.get(draft.sessionId);
        const reason = draft.overflow === true ? "overflow" : asked !== undefined ? "requested" : "threshold";
        if (reason === "threshold" && tokens < config.at * model.contextWindow) return;
        // Asked for once, from here: a request that fails is not made again, nor one that finds nothing to summarize.
        if (asked !== undefined) requested.delete(draft.sessionId);
        const keep = Math.min(config.keepRecent, Math.floor(model.contextWindow * 0.3));
        // Asked for in a conversation not much longer than what is kept, it keeps a quarter of it, so most is summarized.
        const first = chooseCut(branch, reason === "requested" ? Math.min(keep, Math.floor(viewTokens(branch) / 4)) : keep);
        const told = (message: string) => (reason === "requested" ? events.publish(Notice, { level: "info", source: owner.id, message }) : Effect.void);
        if (first === undefined) return yield* told("There is no earlier conversation to summarize");
        const { compaction } = modelView(branch);
        const previous = compaction === undefined ? undefined : branch[compaction]!.data;
        const request: CompactionRequest = {
          sessionId: draft.sessionId,
          turnId: draft.turnId,
          model: draft.model,
          contextWindow: model.contextWindow,
          tokens,
          reason,
          branch,
          firstKept: first,
          ...(previous?.type === "compaction" ? { previous: previous.summary } : {}),
          ...(asked?.instructions === undefined ? {} : { instructions: asked.instructions }),
        };
        const steps: HandlerStep<CompactionRequest, CompactionResult>[] = [];
        const made = yield* hooks.invoke(CompactionHook, request, write, { onStep: (step) => void steps.push(step) });
        if (made.kind === "skip") return yield* told(`The earlier conversation was not summarized: ${made.reason}`);
        // What a handler wrote keeps the history from a place it may be kept from, as the terminal's does.
        const keptAt = branch.findIndex((event) => event.id === made.firstKeptId);
        if (!validCut(branch, keptAt))
          return yield* new CompactionError({ message: `the summary keeps the history from ${made.firstKeptId}, which it cannot be kept from` });
        // Written by the outermost handler whose summary is not the one the rest of the chain handed it, or by this
        // plugin's model (the terminal).
        const writtenBy =
          inChainOrder(steps).find(
            (step) => step.output?.kind === "summary" && (step.next?.output === undefined || !isDeepStrictEqual(step.output, step.next.output)),
          )?.pluginId ?? owner.id;
        yield* draft.append({
          type: "compaction",
          summary: made.summary,
          firstKeptId: made.firstKeptId,
          tokensBefore: tokens,
          source: writtenBy,
          turnId: draft.turnId,
          ...(made.usage === undefined ? {} : { usage: made.usage }),
        });
        yield* events.publish(Notice, {
          level: "info",
          source: owner.id,
          message: `Summarized the earlier conversation (about ${Math.round(tokens / 1000)}k tokens) to stay within ${model.name}'s context window`,
        });
      });

    // `/compact` is handled, not placed: the next model call in the session, in the running turn or the next one, makes
    // the compaction whatever the estimate says.
    yield* owner.on(AgentInputHook, (input, next) => {
      const asked = compactAsked(input.content);
      if (asked === undefined) return next(input);
      requested.set(input.sessionId, asked);
      return Effect.succeed({ kind: "handle", message: "The earlier conversation will be summarized before the next model call" } as const);
    });

    yield* owner.observe(SessionRemoved, ({ sessionId }) =>
      Effect.sync(() => {
        requested.delete(sessionId);
        failedIn.delete(sessionId);
      }),
    );

    // A summary that fails leaves the conversation as it was: the call goes ahead (and may fail for length), and the
    // turn goes on without trying again, so a lasting cause costs one attempt and one warning a turn. A call the model
    // refused as too long (`overflow`) is tried once more whatever happened before: without a summary it fails again.
    yield* owner.on(
      AgentRequestHook,
      (draft, next) =>
        Effect.gen(function* () {
          if (draft.overflow === true || requested.has(draft.sessionId) || failedIn.get(draft.sessionId) !== draft.turnId) {
            yield* compact(draft).pipe(
              Effect.catch((error) =>
                Effect.andThen(
                  Effect.sync(() => failedIn.set(draft.sessionId, draft.turnId)),
                  events.publish(Notice, { level: "warning", source: owner.id, message: `Could not summarize the earlier conversation: ${error.message}` }),
                ),
              ),
            );
          }
          return yield* next(draft);
        }),
      // After every handler shaping the request (adding sections and tools), so the draft it sizes is final.
      { phase: "fit" },
    );
  },
});
