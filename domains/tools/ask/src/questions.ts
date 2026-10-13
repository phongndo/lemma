import { Schema } from "effect";

export const AskOption = Schema.Struct({
  label: Schema.String.annotate({
    description: 'What the user picks, in 1-5 words. Put the option you recommend first and end its label with " (Recommended)".',
  }),
  description: Schema.optional(Schema.String.annotate({ description: "One line: what picking it means, or what it costs." })),
  preview: Schema.optional(
    Schema.String.annotate({
      description: "Markdown shown beside the options while this one is focused, for choices best compared by seeing them: a code sketch, a layout, a config.",
    }),
  ),
});
export type AskOption = typeof AskOption.Type;

export const AskQuestion = Schema.Struct({
  header: Schema.String.annotate({ description: 'A label of at most 12 characters, shown as the question\'s tab: "Storage", "Auth".' }),
  question: Schema.String.annotate({ description: "The whole question, ending with a question mark." }),
  options: Schema.Array(AskOption)
    .check(Schema.isMinLength(2), Schema.isMaxLength(4))
    .annotate({ description: 'Two to four distinct choices. Do not add an "Other" option: the user can always write their own answer.' }),
  multiSelect: Schema.optional(Schema.Boolean.annotate({ description: "The user may pick several options. Default false." })),
});
export type AskQuestion = typeof AskQuestion.Type;

export const AskInput = Schema.Struct({
  questions: Schema.Array(AskQuestion).check(Schema.isMinLength(1), Schema.isMaxLength(4)).annotate({ description: "One to four questions, asked together." }),
});
export type AskInput = typeof AskInput.Type;

/**
 * The user's answer to one question: options they picked (by label) and what they wrote, their own answer when they
 * picked none and a note on their pick when they did; or skipped, leaving it to the agent.
 */
export const QuestionAnswer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("answered"), selected: Schema.Array(Schema.String), text: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("skipped") }),
]);
export type QuestionAnswer = typeof QuestionAnswer.Type;

/**
 * What became of a call, logged as its result's `details` for the transcript to show: answered (one answer per
 * question, in order), replied (the user sent a message instead, which follows the result), or unavailable (no client
 * that answers questions was connected).
 */
export type AskOutcome =
  | { readonly kind: "answered"; readonly answers: readonly QuestionAnswer[] }
  | { readonly kind: "replied" }
  | { readonly kind: "unavailable" };

export interface AskDetails {
  readonly questions: readonly AskQuestion[];
  readonly outcome: AskOutcome;
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** A label as the user sees it, its " (Recommended)" suffix a badge instead. */
export const displayLabel = (label: string): { readonly text: string; readonly recommended: boolean } =>
  RECOMMENDED.test(label) ? { text: label.replace(RECOMMENDED, ""), recommended: true } : { text: label, recommended: false };

/** Why the model's questions cannot be asked as they are, or undefined. Answers name options by label, so labels must differ. */
export const inputProblem = (input: AskInput): string | undefined => {
  const texts = new Set<string>();
  for (const question of input.questions) {
    if (question.question.trim() === "") return "Each question needs its text.";
    if (texts.has(question.question)) return `The question "${question.question}" is asked twice; ask each once.`;
    texts.add(question.question);
    const labels = new Set<string>();
    for (const option of question.options) {
      if (option.label.trim() === "") return `An option of "${question.question}" has no label.`;
      if (labels.has(option.label)) return `"${question.question}" offers "${option.label}" twice; each option needs its own label.`;
      labels.add(option.label);
    }
  }
  return undefined;
};

/** Why `answers` cannot answer `questions`, or undefined. */
export const answerProblem = (questions: readonly AskQuestion[], answers: readonly QuestionAnswer[]): string | undefined => {
  if (answers.length !== questions.length) return `${questions.length} questions need ${questions.length} answers, not ${answers.length}`;
  for (const [index, answer] of answers.entries()) {
    if (answer.kind === "skipped") continue;
    const question = questions[index]!;
    const unknown = answer.selected.find((label) => !question.options.some((option) => option.label === label));
    if (unknown !== undefined) return `"${unknown}" is not an option of "${question.question}"`;
    if (new Set(answer.selected).size !== answer.selected.length) return `An option of "${question.question}" is picked twice`;
    if (question.multiSelect !== true && answer.selected.length > 1) return `"${question.question}" takes one option`;
    if (answer.selected.length === 0 && (answer.text ?? "").trim() === "") return `The answer to "${question.question}" picks nothing and says nothing`;
  }
  return undefined;
};

const quoted = (text: string) => JSON.stringify(text);

const answerLine = (answer: QuestionAnswer): string => {
  if (answer.kind === "skipped") return "skipped: decide yourself";
  const text = answer.text?.trim() ?? "";
  if (answer.selected.length === 0) return `wrote ${quoted(text)}`;
  const chose = `chose ${answer.selected.map(quoted).join(", ")}`;
  return text === "" ? chose : `${chose}, and added ${quoted(text)}`;
};

/** What the model reads: one text for each outcome, so a skip, a reply, or nobody being there never reads as a refusal. */
export const resultText = (details: AskDetails): string => {
  switch (details.outcome.kind) {
    case "answered": {
      const { answers } = details.outcome;
      return [
        "The user answered:",
        ...details.questions.map((question, index) => `${index + 1}. ${quoted(question.question)} → ${answerLine(answers[index]!)}`),
      ].join("\n");
    }
    case "replied":
      return "The user did not answer these questions. They sent a message instead, which follows; read it before you go on.";
    case "unavailable":
      return "Nobody is available to answer. Go on with your best judgement, and say which assumptions you made.";
  }
};
