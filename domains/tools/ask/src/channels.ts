import { Schema } from "effect";
import { defineChannel } from "@lemma/contracts";
import { AskQuestion, QuestionAnswer } from "./questions.ts";

/** A call of `ask_user` waiting for its answer. */
export const OpenQuestions = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  questions: Schema.Array(AskQuestion),
  /** Epoch ms it was asked. */
  at: Schema.Number,
});
export type OpenQuestions = typeof OpenQuestions.Type;

/** How clients see and answer the questions `tools.ask` holds open. */
export const AskChannels = {
  /**
   * Every open call now, then the list again whenever it changes. A client with it open is one that can answer: while
   * none is, a call is answered at once that nobody is available.
   */
  open: defineChannel({
    kind: "stream",
    id: "ask.open",
    title: "Open questions",
    description: "Questions the agent is waiting on, now and whenever they change",
    payload: Schema.Void,
    success: Schema.Array(OpenQuestions),
  }),
  /**
   * Answers an open call, named by its session and its id: one answer per question, in order. The first answer wins; a
   * later one fails `NotFound`.
   */
  answer: defineChannel({
    kind: "call",
    id: "ask.answer",
    title: "Answer questions",
    description: "Answers the agent's open questions, one answer per question",
    payload: Schema.Struct({ sessionId: Schema.String, toolCallId: Schema.String, answers: Schema.Array(QuestionAnswer) }),
    success: Schema.Void,
  }),
} as const;
