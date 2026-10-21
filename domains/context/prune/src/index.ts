import { Effect, Schema } from "effect";
import { Notice } from "@lemma/contracts";
import { definePlugin, Events } from "@lemma/core";
import { CompactionHook } from "@lemma/context";
import type { Message } from "@lemma/llm";
import { modelEntries } from "@lemma/sessions";
import type { EventData, SessionEvent } from "@lemma/sessions";
import { ToolRunner } from "@lemma/tools";

/** Its row in config.jsonc's `plugins`. */
export const Config = Schema.Struct({
  room: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 0.1)))
    .annotate({
      title: "Room",
      description: "Share of the model's context window shortening must leave free below where compaction summarizes, or it summarizes instead (0.1 is 10%).",
    }),
  minChars: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 4_000)))
    .annotate({ title: "Longer than", description: "Characters a tool result's text must exceed to be shortened." }),
  keepChars: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 1_000)))
    .annotate({ title: "Keep", description: "Characters of a shortened result kept: half from its start, half from its end." }),
  keepRecent: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 20_000)))
    .annotate({ title: "Recent tokens", description: "Tokens of the latest conversation whose tool results are left whole." }),
  exclude: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync((): readonly string[] => [])))
    .annotate({
      title: "Never shorten",
      description: "Tools whose results are left whole, besides those that say so themselves: ones running again would not give back.",
    }),
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
 * The tool results to shorten on `branch`: in the model's view, answered by the model, before the latest `keepRecent`
 * tokens of it, longer than `minChars`, of a tool not in `exclude`, and not edited already. Pure, so it is tested
 * without a host.
 */
export const toShorten = (branch: readonly SessionEvent[], config: Pick<Config, "minChars" | "keepRecent" | "exclude">): readonly SessionEvent[] => {
  const edited = new Set(branch.flatMap((event) => (event.data.type === "context-edit" ? [event.data.target] : [])));
  const excluded = new Set(config.exclude);
  const entries = modelEntries(branch);
  const targets: SessionEvent[] = [];
  // From the latest message back: the tokens of the view after each, and whether the model has answered it.
  let after = 0;
  let answered = false;
  for (let at = entries.length - 1; at >= 0; at--) {
    const { index, message, summary } = entries[at]!;
    const chars = textOf(message).length;
    const event = branch[index]!;
    if (
      answered &&
      after >= config.keepRecent &&
      summary !== true &&
      message.role === "toolResult" &&
      !excluded.has(message.toolName) &&
      !edited.has(event.id) &&
      chars > config.minChars
    )
      targets.push(event);
    after += chars / CHARS_PER_TOKEN;
    if (message.role === "assistant") answered = true;
  }
  return targets.reverse();
};

/** A result's shortening: the `context-edit` to append, and the tokens it frees, about. */
export interface Shortening {
  readonly edit: Extract<EventData, { type: "context-edit" }>;
  readonly freed: number;
}

/**
 * Each of `targets` shortened to `keepChars` of its text (its images stay as they are), said to come from `source`;
 * one the note would make no shorter is left as it is.
 */
export const shorten = (targets: readonly SessionEvent[], keepChars: number, source: string): readonly Shortening[] =>
  targets.flatMap((target) => {
    const data = target.data;
    if (data.type !== "message" || data.message.role !== "toolResult") return [];
    const text = textOf(data.message);
    const short = shortened(text, keepChars);
    if (short.length >= text.length) return [];
    // Only its text is long: its images stay as they are.
    const images = data.message.content.filter((part) => part.type === "image");
    return [
      {
        edit: { type: "context-edit", target: target.id, op: "replace", content: [{ type: "text", text: short }, ...images], source },
        freed: (text.length - short.length) / CHARS_PER_TOKEN,
      },
    ];
  });

/** `tokens` as a notice says them: in thousands from a thousand on. */
const about = (tokens: number): string => (tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${Math.round(tokens)}`);

/**
 * Shortens old, long tool results in what the model sees, each to its start and end, said to be shortened, through a
 * `context-edit` (the log keeps it whole), in place of a summary `context.compaction` was about to write
 * (`CompactionHook`). An edit has the next request declare its prompt afresh, as a summary does, so it costs no more
 * than the summary it replaces: made when it leaves `room` of the window below where compaction summarizes. Off until a
 * row turns it on.
 */
export default definePlugin({
  id: "context.prune",
  uses: ["lemma/context@1", "lemma/sessions@1", "lemma/llm@1", "lemma/tools@1"],
  config: Config,
  requires: { runner: ToolRunner },
  setup: function* ({ runner }, owner) {
    const config = owner.config;
    const events = yield* Events;

    yield* owner.on(CompactionHook, (request, next) =>
      Effect.gen(function* () {
        const { threshold, append } = request;
        // An overflow, or `/compact`, is compaction's; so is every compaction of a plugin written before these.
        if (request.reason !== "threshold" || threshold === undefined || append === undefined) return yield* next(request);
        // Besides the config's, the tools that say running them again would not give their results back.
        const irreplaceable = (yield* runner.list).flatMap((tool) => (tool.irreplaceable === true ? [tool.spec.name] : []));
        const shortenings = shorten(toShorten(request.branch, { ...config, exclude: [...config.exclude, ...irreplaceable] }), config.keepChars, owner.id);
        const freed = shortenings.reduce((sum, shortening) => sum + shortening.freed, 0);
        // Shortening that leaves too little room below the threshold would have compaction summarize soon after anyway.
        if (shortenings.length === 0 || request.tokens - freed > threshold - config.room * request.contextWindow) return yield* next(request);
        // Edits it could not append leave the rest to compaction, which summarizes as it would have.
        const appended = yield* Effect.forEach(shortenings, ({ edit }) => append({ ...edit, turnId: request.turnId })).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.as(Effect.logWarning(`context.prune: could not shorten old tool results (${error.message}); summarizing instead`), false),
          ),
        );
        if (!appended) return yield* next(request);
        const results = `${shortenings.length} old tool result${shortenings.length === 1 ? "" : "s"}`;
        yield* events.publish(Notice, {
          level: "info",
          source: owner.id,
          message: `Shortened ${results} (about ${about(freed)} tokens) instead of summarizing the earlier conversation`,
        });
        return { kind: "skip", reason: `${owner.id} shortened ${results} instead` } as const;
      }),
    );
  },
});
