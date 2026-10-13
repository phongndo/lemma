import { displayLabel } from "./questions.ts";
import type { AskQuestion, QuestionAnswer } from "./questions.ts";

/** What the user has done with one question so far. */
export interface QuestionDraft {
  /** Picked option labels, in the order the options are offered. */
  readonly picked: readonly string[];
  /** Their own answer when nothing is picked; a note on the pick when something is. */
  readonly text: string;
  readonly skipped: boolean;
}

export const emptyDraft: QuestionDraft = { picked: [], text: "", skipped: false };

/** `label` picked or unpicked: one question takes one option, so picking replaces; one with `multiSelect` toggles. */
export const pick = (question: AskQuestion, draft: QuestionDraft, label: string): QuestionDraft => {
  const order = (labels: readonly string[]) => question.options.map((option) => option.label).filter((candidate) => labels.includes(candidate));
  if (question.multiSelect !== true) return { ...draft, picked: [label], skipped: false };
  return {
    ...draft,
    picked: draft.picked.includes(label) ? draft.picked.filter((candidate) => candidate !== label) : order([...draft.picked, label]),
    skipped: false,
  };
};

/** The answer a draft gives, or undefined while it gives none (nothing picked or written, and not skipped). */
export const answerOf = (draft: QuestionDraft): QuestionAnswer | undefined => {
  if (draft.skipped) return { kind: "skipped" };
  const text = draft.text.trim();
  if (draft.picked.length === 0 && text === "") return undefined;
  return text === "" ? { kind: "answered", selected: draft.picked } : { kind: "answered", selected: draft.picked, text };
};

/** Every question's answer, in order: one left unanswered is sent as skipped, as the review says it will be. */
export const answersOf = (drafts: readonly QuestionDraft[]): readonly QuestionAnswer[] => drafts.map((draft) => answerOf(draft) ?? { kind: "skipped" });

/** Whether picking an option answers everything at once: a single one-choice question, with nothing written to go with it. */
export const picksSubmit = (questions: readonly AskQuestion[], draft: QuestionDraft): boolean =>
  questions.length === 1 && questions[0]!.multiSelect !== true && draft.text.trim() === "";

/** An answer in a few words, for the review and the transcript. */
export const describeAnswer = (answer: QuestionAnswer | undefined): string => {
  if (answer === undefined) return "Not answered: the agent decides";
  if (answer.kind === "skipped") return "Skipped: the agent decides";
  const text = answer.text?.trim() ?? "";
  if (answer.selected.length === 0) return `“${text}”`;
  const picked = answer.selected.map((label) => displayLabel(label).text).join(", ");
  return text === "" ? picked : `${picked} — “${text}”`;
};
