import { Effect, Schema } from "effect";

export const Config = Schema.Struct({
  dirs: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultType(Effect.sync((): readonly string[] => [])))
    .annotate({
      title: "More directories",
      description: "Directories of skills besides ~/.lemma/skills and ~/.agents/skills, a skill a folder in each (~/.claude/skills). A leading ~ is your home.",
    }),
  trigger: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.withDecodingDefaultType(Effect.sync(() => "$"))).annotate({
    title: "Trigger",
    description: "Typed at the start of a word, offers the skills; a prompt naming one after it ($review) carries its instructions.",
  }),
});
