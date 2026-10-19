import { isDeepStrictEqual } from "node:util";
import { Clock, Data, Effect, Stream } from "effect";
import { inChainOrder, Notice } from "@lemma/contracts";
import { AgentInputHook, AgentRequestHook } from "@lemma/agent";
import { CompactionError, CompactionHook, CONTEXT_CONTRACT } from "@lemma/context";
import type { CompactionRequest, CompactionResult } from "@lemma/context";
import { addUsage, Llm, LlmRequest } from "@lemma/llm";
import { deriveHistory, modelEntries, modelView, requestState, SessionRemoved } from "@lemma/sessions";
import { declaredTools } from "@lemma/tools";
import type { PromptContent, RequestDraft } from "@lemma/agent";
import type { AssistantMessage, ModelInfo, StreamEvent, Usage } from "@lemma/llm";
import { definePlugin, Events, Hooks } from "@lemma/core";
import type { HandlerStep } from "@lemma/core";
import {
  answersAsk,
  chooseCut,
  estimateTokens,
  filesOf,
  forkAsk,
  REVIEW_PROMPT,
  SUMMARY_PROMPT,
  summaryAsk,
  transcript,
  validCut,
  viewTokens,
} from "./compact.ts";
import { Config } from "./config.ts";

export { chooseCut, estimateTokens, measuredTokens, transcript } from "./compact.ts";

class SummaryFailed extends Data.TaggedError("SummaryFailed")<{ readonly message: string }> {}

/**
 * Tokens set aside for the framing of what is sent beyond its text (the system prompt and the ask are counted as
 * characters), and the characters a token is taken to be at most in what is sent.
 */
const PROMPT_TOKENS = 200;
const DENSE_CHARS_PER_TOKEN = 1.5;
/** Compactions a turn makes, at most, before the threshold no longer asks for one: past that, each refills the window. */
const PER_TURN = 3;

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
  implements: [CONTEXT_CONTRACT],
  version: "0.1.0",
  config: Config,
  requires: { llm: Llm },
  setup: function* ({ llm }, owner) {
    const config = owner.config;
    const events = yield* Events;
    const hooks = yield* Hooks;
    /** Per session, the turn in which writing a summary failed: not tried again until the next turn. */
    const failedIn = new Map<string, string>();
    /** Per session, the turn told it summarized `PER_TURN` times and would not again. */
    const thrashedIn = new Map<string, string>();
    /** Per session, a compaction the user asked for (`/compact`), made before the session's next model call. */
    const requested = new Map<string, { readonly instructions?: string }>();

    /** A model call's answer, settled: its message, or why it gave none. */
    const settle = (request: LlmRequest) =>
      llm.stream(request).pipe(
        Stream.runFold(
          (): Extract<StreamEvent, { type: "done" | "error" }> | undefined => undefined,
          (last, event) => (event.type === "done" || event.type === "error" ? event : last),
        ),
        Effect.flatMap((settled) =>
          settled?.type === "done"
            ? Effect.succeed(settled.message)
            : Effect.fail(new SummaryFailed({ message: settled?.message.errorMessage ?? "the model gave no summary" })),
        ),
      );

    /**
     * The text of an answer that ended as one does: undefined for one cut off at its limit, which would lose the rest of
     * what it replaces, or one that called a tool (a fork offers the turn's tools), whose text only leads up to the call.
     */
    const answerText = (message: AssistantMessage): string | undefined =>
      message.stopReason !== "stop"
        ? undefined
        : message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("")
            .trim();

    const summarize = (writer: ModelInfo, ask: string, output: number, sessionId: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          settle(
            new LlmRequest({
              model: writer.ref,
              system: SUMMARY_PROMPT,
              messages: [{ role: "user", content: [{ type: "text", text: ask }], timestamp: now }],
              maxTokens: output,
              sessionId,
            }),
          ),
        ),
        Effect.flatMap((message) => {
          const summary = answerText(message);
          if (summary === undefined) {
            const why = message.stopReason === "length" ? `ran past ${output} tokens` : `ended as ${message.stopReason}`;
            return Effect.fail(new SummaryFailed({ message: `the summary ${why}` }));
          }
          return summary === ""
            ? Effect.fail(new SummaryFailed({ message: "the model gave an empty summary" }))
            : Effect.succeed({ summary, usage: message.usage });
        }),
      );

    /**
     * The turn's last request with `ask` after it, as its model would be asked it next: the same system prompt, tools,
     * thinking, and history, so the provider's cache of that request serves all but what follows it. Undefined when the
     * branch has no request for `writer`, or the fork with its answer would not fit the window.
     */
    const forkOf = (asked: CompactionRequest, writer: ModelInfo, ask: string, output: number) =>
      Effect.gen(function* () {
        const state = requestState(asked.branch);
        if (asked.reason === "overflow" || state.model !== writer.ref || state.system === undefined) return undefined;
        if (asked.tokens + Math.ceil(ask.length / 4) + output > writer.contextWindow) return undefined;
        const history = deriveHistory(asked.branch);
        return new LlmRequest({
          model: writer.ref,
          system: state.system,
          messages: [...history.messages, { role: "user", content: [{ type: "text", text: ask }], timestamp: yield* Clock.currentTimeMillis }],
          ...(history.thinkingFrom === undefined ? {} : { thinkingFrom: history.thinkingFrom }),
          ...(state.tools === undefined || state.tools.length === 0 ? {} : { tools: state.tools }),
          ...(state.thinking === undefined ? {} : { thinking: state.thinking }),
          maxTokens: output,
          sessionId: asked.sessionId,
        });
      });

    /**
     * Asks a model that sees only `summary` what it leaves out, and the turn's own (through a fork of its last request)
     * to answer: the answers, to go after the summary, and what the calls made cost. No answers when there is nothing
     * to ask, or either answer did not end as one does; fails only when the first call does.
     */
    const review = (asked: CompactionRequest, writer: ModelInfo, summary: string, output: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const reader = yield* settle(
          new LlmRequest({
            model: writer.ref,
            system: REVIEW_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: summary }], timestamp: now }],
            maxTokens: 1_024,
            sessionId: asked.sessionId,
          }),
        );
        const questions = answerText(reader);
        if (questions === undefined || questions === "" || /^none\.?$/i.test(questions)) return { usage: reader.usage };
        const fork = yield* forkOf(asked, writer, answersAsk(questions), output);
        const answering = fork === undefined ? undefined : yield* Effect.option(settle(fork));
        if (answering === undefined || answering._tag === "None") return { usage: reader.usage };
        const answers = answerText(answering.value);
        const usage = addUsage(reader.usage, answering.value.usage);
        return answers === undefined || answers === "" ? { usage } : { usage, answers: `## Questions a reader asked, answered\n\n${questions}\n\n${answers}` };
      });

    /**
     * `CompactionHook`'s terminal: a model (the config's, else the request's) summarizes what comes before the cut. The
     * request's own model writes it in a fork of its last request, which its provider's cache serves; failing that (an
     * overflow, another model, a failed call, or an answer cut off, calling a tool, or with no text), a model is sent the
     * history as a transcript to summarize. A review that fails leaves the summary as it was written.
     */
    const write = (asked: CompactionRequest): Effect.Effect<CompactionResult, CompactionError> =>
      Effect.gen(function* () {
        const kept = asked.branch[asked.firstKept];
        if (kept === undefined) return { kind: "skip", reason: `no event at ${asked.firstKept} to keep from` } as const;
        // A handler may have moved the cut (`next`): never between a tool call and its result, nor outside the view.
        if (!validCut(asked.branch, asked.firstKept)) return yield* new SummaryFailed({ message: `the history cannot be kept from event ${asked.firstKept}` });
        // What the model saw before the cut, in the order it was logged.
        const older = modelEntries(asked.branch)
          .filter((entry) => entry.summary !== true && entry.index < asked.firstKept)
          .sort((a, b) => a.index - b.index)
          .map((entry) => entry.message);
        const writer = yield* llm.model(config.model ?? asked.model);
        // What is sent fits the writer's window with its answer, even for text as dense as 1.5 characters a token.
        const output = Math.min(8_192, writer.maxTokens, Math.floor(writer.contextWindow / 4));
        const fork = yield* forkOf(asked, writer, forkAsk(asked.previous !== undefined, asked.instructions), output);
        const forked =
          fork === undefined
            ? undefined
            : yield* settle(fork).pipe(
                Effect.catch((error) =>
                  Effect.as(Effect.logDebug(`compaction: the fork gave no summary (${error.message}); summarizing a transcript instead`), undefined),
                ),
              );
        const forkedText = forked === undefined ? undefined : answerText(forked);
        const written =
          forked !== undefined && forkedText !== undefined && forkedText !== ""
            ? { summary: forkedText, usage: forked.usage }
            : yield* Effect.gen(function* () {
                // What is sent besides the transcript, the system prompt and the ask around it, comes out of its room.
                const around = SUMMARY_PROMPT.length + summaryAsk("", asked.previous !== undefined, asked.instructions).length;
                const budget = Math.floor((writer.contextWindow - output - PROMPT_TOKENS) * DENSE_CHARS_PER_TOKEN) - around;
                const text = transcript(older, asked.previous, budget);
                const serial = yield* summarize(writer, summaryAsk(text, asked.previous !== undefined, asked.instructions), output, asked.sessionId);
                return { summary: serial.summary, usage: forked === undefined ? serial.usage : addUsage(forked.usage, serial.usage) };
              });
        const reviewed = config.review
          ? yield* review(asked, writer, written.summary, output).pipe(
              Effect.catch((error) =>
                Effect.as(Effect.logWarning(`compaction: the summary's review failed (${error.message}); the summary is kept without it`), undefined),
              ),
            )
          : undefined;
        const usage: Usage = reviewed === undefined ? written.usage : addUsage(written.usage, reviewed.usage);
        const summary = reviewed?.answers === undefined ? written.summary : `${written.summary}\n\n${reviewed.answers}`;
        return { kind: "summary", summary, firstKeptId: kept.id, usage } as const;
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
        // A turn that keeps filling the window again (one output too large for it) is not summarized over and over.
        const made = branch.filter((event) => event.data.type === "compaction" && event.data.turnId === draft.turnId).length;
        if (reason === "threshold" && made >= PER_TURN) {
          if (thrashedIn.get(draft.sessionId) !== draft.turnId) {
            thrashedIn.set(draft.sessionId, draft.turnId);
            yield* events.publish(Notice, {
              level: "warning",
              source: owner.id,
              message: `Summarized ${PER_TURN} times this turn and still near the context limit: not summarizing again until the next turn`,
            });
          }
          return;
        }
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
        const result = yield* hooks.invoke(CompactionHook, request, write, { onStep: (step) => void steps.push(step) });
        if (result.kind === "skip") return yield* told(`The earlier conversation was not summarized: ${result.reason}`);
        // What a handler wrote keeps the history from a place it may be kept from, as the terminal's does.
        const keptAt = branch.findIndex((event) => event.id === result.firstKeptId);
        if (!validCut(branch, keptAt))
          return yield* new CompactionError({ message: `the summary keeps the history from ${result.firstKeptId}, which it cannot be kept from` });
        // The files the replaced history read and changed, whoever wrote the summary, after the previous summary's.
        const { start } = modelView(branch);
        const replaced = branch.slice(start, keptAt).flatMap((event) => (event.data.type === "message" ? [event.data.message] : []));
        const files = filesOf(replaced, previous?.type === "compaction" ? previous.files : undefined);
        // Written by the outermost handler whose summary is not the one the rest of the chain handed it, or by this
        // plugin's model (the terminal).
        const writtenBy =
          inChainOrder(steps).find(
            (step) => step.output?.kind === "summary" && (step.next?.output === undefined || !isDeepStrictEqual(step.output, step.next.output)),
          )?.pluginId ?? owner.id;
        yield* draft.append({
          type: "compaction",
          summary: result.summary,
          firstKeptId: result.firstKeptId,
          tokensBefore: tokens,
          source: writtenBy,
          turnId: draft.turnId,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(files.read.length + files.modified.length === 0 ? {} : { files: { read: [...files.read], modified: [...files.modified] } }),
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
        thrashedIn.delete(sessionId);
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
