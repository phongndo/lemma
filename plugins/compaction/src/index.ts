import { Data, Effect, Layer, Schema, Stream } from "effect";
import { AgentRequestHook, Llm, LlmRequest, modelView, Notice } from "@lemma/contracts";
import type { ModelInfo, RequestDraft, StreamEvent } from "@lemma/contracts";
import { definePlugin, Events, PluginContext } from "@lemma/core";
import { chooseCut, estimateTokens, SUMMARY_PROMPT, transcript } from "./compact.ts";

export { chooseCut, estimateTokens, messageChars, transcript } from "./compact.ts";

const Config = Schema.Struct({
  at: Schema.optionalWith(Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThan(1)), { default: () => 0.8 }).annotations({
    title: "Summarize at",
    description: "Share of the model's context window the conversation may fill before its older part is summarized (0.8 is 80%).",
  }),
  keepRecent: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), { default: () => 20_000 }).annotations({
    title: "Keep recent",
    description: "Tokens of the latest conversation kept word for word, at most 30% of the window.",
  }),
  model: Schema.optional(Schema.String).annotations({
    title: "Summary model",
    description: "The model that writes summaries, as provider/model; the turn's model when unset.",
  }),
});
type Config = typeof Config.Type;

class SummaryFailed extends Data.TaggedError("SummaryFailed")<{ readonly message: string }> {}

/** Runs after every other request handler (those adding sections and tools), so the draft it sizes is final. */
const ORDER = 1_000;
/** Tokens set aside for the summary prompt's own text, and the characters a token is taken to be at most in what is sent. */
const PROMPT_TOKENS = 1_000;
const DENSE_CHARS_PER_TOKEN = 1.5;

/**
 * Keeps a conversation within its model's context window: before a model
 * call that would fill more than `at` of the window, the older part of the
 * turn's history is summarized by a model and a `compaction` event is
 * appended to the turn (`RequestDraft.append`), which every reader of the log
 * (`deriveMessages`) then shows the model in place of that part. The log
 * keeps every original event.
 */
export default definePlugin({
  id: "compaction",
  version: "0.1.0",
  config: Config,
  requires: [Llm],
  layer: (config: Config) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const llm = yield* Llm;
        const events = yield* Events;
        /** Per session, the turn in which writing a summary failed: not tried again until the next turn. */
        const failedIn = new Map<string, string>();

        const summarize = (writer: ModelInfo, text: string, output: number, sessionId: string) =>
          llm
            .stream(
              new LlmRequest({
                model: writer.ref,
                system: SUMMARY_PROMPT,
                messages: [{ role: "user", content: [{ type: "text", text: `${text}\n\nSummarize the conversation above.` }], timestamp: Date.now() }],
                maxTokens: output,
                sessionId,
              }),
            )
            .pipe(
              Stream.runFold(undefined as Extract<StreamEvent, { type: "done" | "error" }> | undefined, (last, event) =>
                event.type === "done" || event.type === "error" ? event : last,
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
            );

        const compact = (draft: RequestDraft) =>
          Effect.gen(function* () {
            const model = yield* llm.model(draft.model);
            const branch = draft.branch;
            const tokens = estimateTokens(
              branch,
              () => draft.sections.reduce((sum, section) => sum + section.text.length, 0) + JSON.stringify(draft.tools.map((tool) => tool.spec)).length,
            );
            // The previous call was refused as too long: the estimate was wrong, so summarize now.
            if (tokens < config.at * model.contextWindow && draft.overflow !== true) return;
            const first = chooseCut(branch, Math.min(config.keepRecent, Math.floor(model.contextWindow * 0.3)));
            if (first === undefined) return;
            const { start, compaction } = modelView(branch);
            const previous = compaction === undefined ? undefined : branch[compaction]!.data;
            const older = branch.slice(start, first).flatMap((event) => (event.data.type === "message" ? [event.data.message] : []));
            const writer = config.model === undefined ? model : yield* llm.model(config.model);
            // What is sent fits the writer's window with its answer, even for text as dense as 1.5 characters a token.
            const output = Math.min(8_192, writer.maxTokens, Math.floor(writer.contextWindow / 4));
            const budget = Math.floor((writer.contextWindow - output - PROMPT_TOKENS) * DENSE_CHARS_PER_TOKEN);
            const text = transcript(older, previous?.type === "compaction" ? previous.summary : undefined, budget);
            const written = yield* summarize(writer, text, output, draft.sessionId);
            yield* draft.append({
              type: "compaction",
              summary: written.summary,
              firstKeptId: branch[first]!.id,
              tokensBefore: tokens,
              source: owner.id,
              turnId: draft.turnId,
              usage: written.usage,
            });
            yield* events.publish(Notice, {
              level: "info",
              source: owner.id,
              message: `Summarized the earlier conversation (about ${Math.round(tokens / 1000)}k tokens) to stay within ${model.name}'s context window`,
            });
          });

        // A summary that fails leaves the conversation as it was: the call goes ahead (and may fail for length), and the
        // turn goes on without trying again, so a lasting cause costs one attempt and one warning a turn. A call the model
        // refused as too long (`overflow`) is tried once more whatever happened before: without a summary it fails again.
        yield* owner.on(
          AgentRequestHook,
          (draft, next) =>
            Effect.gen(function* () {
              if (draft.overflow === true || failedIn.get(draft.sessionId) !== draft.turnId) {
                yield* compact(draft).pipe(
                  Effect.catchAll((error) =>
                    Effect.zipRight(
                      Effect.sync(() => failedIn.set(draft.sessionId, draft.turnId)),
                      events.publish(Notice, { level: "warning", source: owner.id, message: `Could not summarize the earlier conversation: ${error.message}` }),
                    ),
                  ),
                );
              }
              return yield* next(draft);
            }),
          { order: ORDER },
        );
      }),
    ),
});
