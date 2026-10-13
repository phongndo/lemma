import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { OpenQuestions } from "./channels.ts";
import { answerOf, answersOf, emptyDraft, pick, picksSubmit } from "./draft.ts";
import type { QuestionDraft } from "./draft.ts";
import type { AskQuestion, QuestionAnswer } from "./questions.ts";

/**
 * One open call as the person answers it: what they picked and wrote for each question, and which question shows. Kept
 * by the web half while the call is open, so switching threads, a reconnect, or a host restart (which asks the same
 * call again) keeps it. The banner draws it, and the composer's text box and send button (`ComposerTakeovers`) write
 * and submit through it.
 */
export interface Asking {
  readonly open: OpenQuestions;
  readonly drafts: Accessor<readonly QuestionDraft[]>;
  /** The question shown, or the review after the last (`questions.length`), which only several questions have. */
  readonly tab: Accessor<number>;
  readonly question: () => AskQuestion | undefined;
  readonly draft: () => QuestionDraft;
  /** The text box's text for the question shown: the person's own answer, or a note on their pick. */
  readonly setText: (text: string) => void;
  readonly choose: (index: number) => void;
  readonly goTo: (index: number) => void;
  /**
   * Whether Enter or the send button does something now: not while answers go out or once they went, and for a lone
   * question not before it has an answer (a pick, words, or a skip), so a stray Enter sends nothing.
   */
  readonly canSubmit: () => boolean;
  /** The answers are going out, or went: nothing more is taken. */
  readonly closed: () => boolean;
  /** Enter or the send button: the next question, the review, or sending the answers. */
  readonly next: () => void;
  readonly skip: () => void;
  readonly submitLabel: () => string;
  readonly placeholder: () => string;
}

export const makeAsking = (
  open: OpenQuestions,
  deps: {
    /** Sends the answers; rejects when they were not taken, having said why. */
    readonly submit: (answers: readonly QuestionAnswer[]) => Promise<void>;
    /** Runs `fn` after `ms`, as the plugin's own timer. */
    readonly after: (ms: number, fn: () => void) => void;
  },
): Asking => {
  const questions = open.questions;
  const several = questions.length > 1;
  const [drafts, setDrafts] = createSignal<readonly QuestionDraft[]>(questions.map(() => emptyDraft));
  const [tab, setTab] = createSignal(0);
  /** Going out, or gone: the call leaves the open list a moment after it is answered, and must not be answered twice. */
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const question = () => questions[tab()];
  const draft = () => drafts()[tab()] ?? emptyDraft;
  const update = (change: (draft: QuestionDraft) => QuestionDraft) => {
    const at = tab();
    if (at < questions.length) setDrafts((all) => all.map((draft, index) => (index === at ? change(draft) : draft)));
  };
  const goTo = (index: number) => setTab(Math.max(0, Math.min(index, several ? questions.length : 0)));
  const canSubmit = () => !sending() && !sent() && (several || answerOf(draft()) !== undefined);
  const send = async () => {
    if (sending() || sent()) return;
    setSending(true);
    try {
      await deps.submit(answersOf(drafts()));
      setSent(true);
    } catch {
      // `submit` told the person why.
    } finally {
      setSending(false);
    }
  };
  const next = () => {
    if (!canSubmit()) return;
    if (!several || tab() === questions.length) return void send();
    goTo(tab() + 1);
  };
  return {
    open,
    drafts,
    tab,
    question,
    draft,
    setText: (text) => update((draft) => ({ ...draft, text, skipped: false })),
    choose: (index) => {
      const current = question();
      const option = current?.options[index];
      if (current === undefined || option === undefined || sent()) return;
      const before = draft();
      update((draft) => pick(current, draft, option.label));
      if (current.multiSelect === true) return;
      if (picksSubmit(questions, before)) return void send();
      // A moment to see the pick land before the next question shows.
      const from = tab();
      if (several) deps.after(160, () => tab() === from && goTo(from + 1));
    },
    goTo,
    canSubmit,
    closed: () => sending() || sent(),
    next,
    skip: () => {
      if (sending() || sent()) return;
      update((draft) => ({ ...draft, picked: [], skipped: true }));
      next();
    },
    submitLabel: () => {
      if (sent()) return "Sent";
      if (sending()) return "Sending…";
      if (!several) return "Submit answer";
      return tab() === questions.length ? "Submit answers" : tab() === questions.length - 1 ? "Review answers" : "Next question";
    },
    placeholder: () => {
      if (tab() === questions.length) return "Submit your answers, or pick a question above to change its answer";
      return draft().picked.length > 0 ? "Add a note to your answer, or leave this blank" : "Type your own answer, or pick an option above";
    },
  };
};

/** How long what was written for a call missing from a fresh list is kept: a host restart asks the call again. */
export const KEEP_MS = 10 * 60_000;

/**
 * Which calls' answers in progress to drop when a list of open calls arrives (`listed`, by key). One missing from a
 * list sent as it changed was answered, replied to, or stopped. One missing from the first list since the stream opened
 * again (`fresh`: a reconnect, a host restart) may be asked again in a moment, so it is kept until `KEEP_MS` after it
 * was last in a list (`seen`).
 */
export const dropped = (
  kept: Iterable<string>,
  listed: ReadonlySet<string>,
  seen: ReadonlyMap<string, number>,
  fresh: boolean,
  now: number,
): readonly string[] => [...kept].filter((key) => !listed.has(key) && !(fresh && now - (seen.get(key) ?? now) < KEEP_MS));
