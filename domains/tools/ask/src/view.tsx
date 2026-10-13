import { For, Match, Show, Switch } from "solid-js";
import type { ToolBodyProps, ToolView } from "@lemma/threads";
import { describeAnswer } from "./draft.ts";
import type { AskDetails, AskQuestion } from "./questions.ts";

const questionsOf = (args: Record<string, unknown> | undefined): readonly AskQuestion[] =>
  Array.isArray(args?.questions) ? (args.questions as AskQuestion[]).filter((question) => typeof question?.question === "string") : [];

const detailsOf = (details: unknown): AskDetails | undefined => {
  const outcome = (details as Partial<AskDetails> | undefined)?.outcome;
  return typeof outcome?.kind === "string" && Array.isArray((details as AskDetails).questions) ? (details as AskDetails) : undefined;
};

/** A call opened: each question with what became of it. */
function AskBody(props: ToolBodyProps) {
  const details = () => detailsOf(props.result?.details);
  const questions = () => details()?.questions ?? questionsOf(props.args);
  /** Why the tool refused the call (its questions could not be asked as they were), from its error result. */
  const refusal = () =>
    props.result?.isError === true && details() === undefined
      ? props.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
      : undefined;
  const answer = (index: number) => {
    const outcome = details()?.outcome;
    return outcome?.kind === "answered" ? describeAnswer(outcome.answers[index]) : undefined;
  };
  return (
    <div class="ask-record">
      <Switch>
        <Match when={props.state === "running" || props.state === "queued"}>
          <p class="muted small">Waiting for your answer, in the composer.</p>
        </Match>
        <Match when={refusal()}>{(reason) => <p class="muted small">Not asked: {reason()}</p>}</Match>
        <Match when={details()?.outcome.kind === "replied"}>
          <p class="muted small">You replied with a message instead of answering.</p>
        </Match>
        <Match when={details()?.outcome.kind === "unavailable"}>
          <p class="muted small">Nobody was there to answer, so the agent went on with its own judgement.</p>
        </Match>
        <Match when={details() === undefined}>
          <p class="muted small">Not answered: the turn ended first.</p>
        </Match>
      </Switch>
      <ol>
        <For each={questions()}>
          {(question, index) => (
            <li>
              <span class="ask-record-question">{question.question}</span>
              <Show when={answer(index())}>{(text) => <span class="ask-record-answer">{text()}</span>}</Show>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** How the chat and the trajectory show an `ask_user` call: its first question, and when opened, every answer. */
export const askView: ToolView = {
  icon: "chat",
  summary: (args) => {
    const questions = questionsOf(args);
    const first = questions[0];
    if (first === undefined) return {};
    return { primary: first.question, ...(questions.length > 1 ? { secondary: `and ${questions.length - 1} more` } : {}) };
  },
  streaming: "question",
  action: ["asked", "question", "questions"],
  body: AskBody,
};
