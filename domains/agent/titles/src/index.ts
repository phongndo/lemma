import { Clock, Data, Deferred, Effect, Stream } from "effect";
import { definePlugin } from "@lemma/core";
import { CommandError, Commands } from "@lemma/commands";
import { LlmRequest, Llm, SmallModel } from "@lemma/llm";
import type { ModelRef, StreamEvent } from "@lemma/llm";
import { SessionAppended, Sessions } from "@lemma/sessions";
import { REGENERATE } from "./command.ts";
import { againAsk, cleanTitle, firstAsk, firstPrompt, threadModel, TITLE_PROMPT } from "./title.ts";

export { REGENERATE } from "./command.ts";
export { againAsk, cleanTitle, firstAsk, TITLE_PROMPT } from "./title.ts";

/** How long a title may take to write before it is given up on. */
const TIMEOUT = "60 seconds";
/**
 * Tokens a title may take: a few words, with room for a model to go on past them; and for one asked to reason, room for
 * its reasoning too, which OpenAI and Google count with the answer (pi-ai adds Anthropic's budget to it).
 */
const TITLE_TOKENS = 100;
const REASONING_TOKENS = 2_000;

class TitleFailed extends Data.TaggedError("TitleFailed")<{ readonly message: string }> {}

/**
 * Names a thread with the small model (`SmallModel`): once its first turn has titled it from its first prompt, a title
 * of a few words by what it asks, unless it is renamed meanwhile; and anew when asked (`agent.regenerate-title`).
 */
export default definePlugin({
  id: "agent.titles",
  version: "0.1.0",
  uses: ["lemma/agent@2", "lemma/commands@1", "lemma/llm@3", "lemma/sessions@2"],
  requires: { sessions: Sessions, llm: Llm, small: SmallModel },
  setup: function* ({ sessions, llm, small }, owner) {
    /** Sessions a first title is being written for, each done once it is written or given up on. */
    const writing = new Map<string, Deferred.Deferred<void>>();

    /**
     * A title for `ask`, from the small model for a thread on `near`: the whole answer is read, as a model may wrap its
     * title (in JSON, a code fence, a label line, or its reasoning first), and `cleanTitle` finds it there.
     */
    const write = (sessionId: string, ask: string, near: ModelRef | undefined) =>
      Effect.gen(function* () {
        const choice = yield* small.choose(near);
        if (choice === undefined) return yield* new TitleFailed({ message: "No model is available: log in to a provider" });
        const reasons = choice.thinking !== undefined && choice.thinking !== "off";
        const request = new LlmRequest({
          model: choice.model.ref,
          system: TITLE_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: ask }], timestamp: yield* Clock.currentTimeMillis }],
          ...(choice.thinking === undefined ? {} : { thinking: choice.thinking }),
          maxTokens: reasons ? REASONING_TOKENS : TITLE_TOKENS,
          sessionId,
        });
        let text = "";
        let failed: string | undefined;
        yield* llm.stream(request).pipe(
          Stream.takeUntil((event: StreamEvent) => {
            if (event.type === "text-delta") text += event.delta;
            if (event.type === "error") failed = event.message.errorMessage ?? "the model failed";
            return event.type === "done" || event.type === "error";
          }),
          Stream.runDrain,
          Effect.mapError((error) => new TitleFailed({ message: error.message })),
          Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new TitleFailed({ message: `the model took longer than ${TIMEOUT}` })) }),
        );
        if (failed !== undefined) return yield* new TitleFailed({ message: failed });
        const title = cleanTitle(text);
        return title === undefined ? yield* new TitleFailed({ message: "the model wrote no title" }) : title;
      });

    /** A title in place of `provisional`, the one a turn made from the first prompt, while no other has come since. */
    const first = (sessionId: string, provisional: { readonly seq: number; readonly title: string }) =>
      Effect.gen(function* () {
        const events = yield* sessions.events(sessionId);
        const prompt = firstPrompt(events);
        const ask = prompt === undefined ? undefined : firstAsk(prompt);
        if (ask === undefined) return;
        const title = yield* write(sessionId, ask, threadModel(events));
        // Renamed while it was written: the person's title stays.
        const since = yield* sessions.events(sessionId, { after: provisional.seq });
        if (title !== provisional.title && since.every(({ data }) => data.type !== "title")) yield* sessions.append(sessionId, { type: "title", title });
      });

    yield* owner.observe(SessionAppended, ({ sessionId, event }) => {
      // Only a turn's provisional title is replaced: a rename, an agent's name, or a title written here never is.
      if (event.data.type !== "title" || event.data.provisional !== true || writing.has(sessionId)) return Effect.void;
      const done = Deferred.makeUnsafe<void>();
      writing.set(sessionId, done);
      // A title that cannot be written leaves the one from the prompt; asking again tries once more.
      return owner.background(
        `title ${sessionId}`,
        first(sessionId, { seq: event.seq, title: event.data.title }).pipe(
          Effect.catchCause((cause) => Effect.logDebug("agent.titles: no title written", cause)),
          Effect.ensuring(
            Effect.andThen(
              Effect.sync(() => writing.delete(sessionId)),
              Deferred.succeed(done, undefined),
            ),
          ),
        ),
      );
    });

    /**
     * A title anew, by the thread's first prompt and its latest messages, whatever its title is now: after its first
     * title, while that is being written, so this one is the title it ends with.
     */
    const again = (sessionId: string) =>
      Effect.gen(function* () {
        const pending = writing.get(sessionId);
        if (pending !== undefined) yield* Deferred.await(pending);
        const info = yield* sessions.get(sessionId);
        const branch = yield* sessions.branch(sessionId);
        const ask = againAsk(branch, info.title);
        if (ask === undefined) return yield* new TitleFailed({ message: "the thread has nothing to name yet" });
        const title = yield* write(sessionId, ask, threadModel(branch));
        if (title !== info.title) yield* sessions.append(sessionId, { type: "title", title });
        return title;
      });

    yield* owner.add(Commands, {
      id: REGENERATE,
      title: "Regenerate title",
      category: "Thread",
      description: "Names the open thread anew, by its first prompt and its latest messages, with the small model",
      keywords: ["rename", "name", "title", "thread"],
      run: ({ sessionId }) =>
        sessionId === undefined
          ? Effect.fail(new CommandError({ command: REGENERATE, reason: "Failed", message: "Open a thread to name it" }))
          : again(sessionId).pipe(
              Effect.map((title) => ({ message: `Titled “${title}”` })),
              Effect.mapError((error) => new CommandError({ command: REGENERATE, reason: "Failed", message: `No title: ${error.message}`, cause: error })),
            ),
    });
  },
});
