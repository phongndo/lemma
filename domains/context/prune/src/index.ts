import { Effect, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { AgentRequestHook } from "@lemma/agent";
import type { RequestDraft } from "@lemma/agent";
import { Llm } from "@lemma/llm";
import type { Message } from "@lemma/llm";
import { deriveMessages, modelEntries } from "@lemma/sessions";
import type { SessionEvent } from "@lemma/sessions";

/** Its row in config.jsonc's `plugins`. */
export const Config = Schema.Struct({
  at: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThan(1))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 0.5)))
    .annotate({
      title: "Prune at",
      description: "Share of the model's context window the conversation may fill before old, long tool results are shortened (0.5 is 50%).",
    }),
  minChars: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 4_000)))
    .annotate({ title: "Longer than", description: "Characters a tool result's text must exceed to be shortened." }),
  keepChars: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 1_000)))
    .annotate({ title: "Keep", description: "Characters of a shortened result kept: half from its start, half from its end." }),
  keepTurns: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 2)))
    .annotate({ title: "Recent turns", description: "Turns, the latest first, whose tool results are left whole." }),
});
export type Config = typeof Config.Type;

/** Characters a token stands for, roughly. */
const CHARS_PER_TOKEN = 4;

const textOf = (message: Message): string =>
  message.content
    .flatMap((part) =>
      part.type === "text" ? [part.text] : part.type === "thinking" ? [part.thinking] : part.type === "toolCall" ? [JSON.stringify(part.arguments)] : [],
    )
    .join("\n");

/** What a shortened result says in place of what it leaves out. */
export const shortened = (text: string, keep: number): string => {
  const half = Math.floor(keep / 2);
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} characters left out by context.prune; run the tool again for them] …\n${text.slice(text.length - half)}`;
};

/**
 * The tool results to shorten on `branch`: in the model's view, longer than `minChars`, before the latest
 * `keepTurns` turns, and not edited already. Pure, so it is tested without a host.
 */
export const toShorten = (branch: readonly SessionEvent[], config: Pick<Config, "minChars" | "keepTurns">): readonly SessionEvent[] => {
  const edited = new Set(branch.flatMap((event) => (event.data.type === "context-edit" ? [event.data.target] : [])));
  const turns = branch.flatMap((event, index) => (event.data.type === "turn-start" ? [index] : []));
  // Results logged from the oldest turn kept whole on are left alone; with fewer turns than that, all of them are.
  const before = config.keepTurns === 0 ? branch.length : (turns.at(-config.keepTurns) ?? -1);
  return modelEntries(branch).flatMap((entry) => {
    const event = branch[entry.index]!;
    if (entry.summary === true || entry.index >= before || entry.message.role !== "toolResult" || edited.has(event.id)) return [];
    return textOf(entry.message).length > config.minChars ? [event] : [];
  });
};

/**
 * Shortens old, long tool results in what the model sees once a conversation fills `at` of its model's window: each
 * becomes its start and end, said to be shortened, through a `context-edit` (the log keeps it whole). Runs in
 * `AgentRequestHook`'s `fit` phase before compaction, and hands it the request with its edits, so compaction measures
 * the shortened conversation and summarizes only if shortening was not enough. Off until a row turns it on.
 */
export default definePlugin({
  id: "context.prune",
  uses: ["lemma/agent@1", "lemma/sessions@1", "lemma/llm@1"],
  config: Config,
  requires: { llm: Llm },
  setup: function* ({ llm }, owner) {
    const config = owner.config;
    yield* owner.on(
      AgentRequestHook,
      (draft: RequestDraft, next) =>
        Effect.gen(function* () {
          const window = yield* Effect.map(llm.model(draft.model), (model) => model.contextWindow).pipe(Effect.orElseSucceed(() => undefined));
          if (window === undefined) return yield* next(draft);
          const chars = draft.history.reduce((sum, message) => sum + textOf(message).length, 0);
          if (chars / CHARS_PER_TOKEN < config.at * window) return yield* next(draft);
          const targets = toShorten(draft.branch, config);
          if (targets.length === 0) return yield* next(draft);
          const appended: SessionEvent[] = [];
          for (const target of targets) {
            const data = target.data;
            if (data.type !== "message") continue;
            const text = textOf(data.message);
            // Only its text is long: its images stay as they are.
            const images = data.message.role === "toolResult" ? data.message.content.filter((part) => part.type === "image") : [];
            appended.push(
              yield* draft.append({
                type: "context-edit",
                target: target.id,
                op: "replace",
                content: [{ type: "text", text: shortened(text, config.keepChars) }, ...images],
                source: owner.id,
                turnId: draft.turnId,
              }),
            );
          }
          // What it hands on is the conversation as shortened, so compaction sizes that.
          const branch = [...draft.branch, ...appended];
          return yield* next({ ...draft, branch, history: deriveMessages(branch) });
        }),
      { phase: "fit", order: -10 },
    );
  },
});
