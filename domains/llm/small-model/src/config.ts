import { Schema } from "effect";
import { ThinkingLevel } from "@lemma/llm";

/** Its row in config.jsonc's `plugins`, which configures both its halves. */
export const Config = Schema.Struct({
  model: Schema.optional(Schema.String).annotate({
    title: "Model",
    description: "The model small tasks run on, such as a thread's title, as provider/model; a small model of the thread's provider when unset.",
  }),
  thinking: Schema.optional(ThinkingLevel).annotate({
    title: "Reasoning",
    description: "How hard the model reasons, as far as it offers that level; the least it offers when unset.",
  }),
});
export type Config = typeof Config.Type;
