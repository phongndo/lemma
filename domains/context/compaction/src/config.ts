import { Effect, Schema } from "effect";

/** Its row in config.jsonc's `plugins`, which configures both its halves. */
export const Config = Schema.Struct({
  at: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThan(1))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 0.8)))
    .annotate({
      title: "Summarize at",
      description: "Share of the model's context window the conversation may fill before its older part is summarized (0.8 is 80%).",
    }),
  keepRecent: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    .pipe(Schema.withDecodingDefaultType(Effect.sync(() => 20_000)))
    .annotate({
      title: "Keep recent",
      description: "Tokens of the latest conversation kept word for word, at most 30% of the window.",
    }),
  model: Schema.optional(Schema.String).annotate({
    title: "Summary model",
    description: "The model that writes summaries, as provider/model; the turn's model when unset.",
  }),
  review: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => false))).annotate({
    title: "Review summaries",
    description: "Have a model that sees only the summary ask what it leaves out, and the turn's model answer: two more model calls per summary.",
  }),
});
export type Config = typeof Config.Type;
