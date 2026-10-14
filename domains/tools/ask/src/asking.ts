import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { OpenQuestions } from "./channels.ts";
import { answerOf, answersOf, emptyDraft, pick } from "./draft.ts";
import type { QuestionDraft } from "./draft.ts";
import { displayLabel } from "./questions.ts";
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
  /** The text box's text for the question shown: the person's own answer, or a note on what they picked. */
  readonly setText: (text: string) => void;
  /** The option highlighted, by keys or the pointer, as a menu's active row: none until the person moves to one, or picks one. */
  readonly active: Accessor<number | undefined>;
  readonly setActive: (index: number | undefined) => void;
  /**
   * Picks an option, or unpicks it when picked. It stays on the question, so the text box can add a note to the pick;
   * Enter or the send button goes on.
   */
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
  /** Sends every question as skipped, whatever was picked or written: the agent decides them all. */
  readonly dismiss: () => void;
  readonly submitLabel: () => string;
  readonly placeholder: () => string;
  /**
   * A key in the composer's text box while it holds nothing, as a completion menu takes it: Up and Down move the
   * highlight, a digit picks, Enter picks the highlighted option when it is not picked yet, and Left and Right move
   * between questions. Whether it was taken; Enter otherwise goes on (`next`), as the send button does.
   */
  readonly boxKey: (key: string) => boolean;
}

export const makeAsking = (
  open: OpenQuestions,
  deps: {
    /** Sends the answers; rejects when they were not taken, having said why. */
    readonly submit: (answers: readonly QuestionAnswer[]) => Promise<void>;
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
  const [active, setActive] = createSignal<number | undefined>(undefined);
  /** Where a question shows from: its picked option highlighted, else none. */
  const landing = (at: number) => {
    const shown = questions[at];
    const picked = shown?.options.findIndex((option) => (drafts()[at] ?? emptyDraft).picked.includes(option.label)) ?? -1;
    return picked < 0 ? undefined : picked;
  };
  const goTo = (index: number) => {
    const at = Math.max(0, Math.min(index, several ? questions.length : 0));
    setActive(landing(at));
    setTab(at);
  };
  const canSubmit = () => !sending() && !sent() && (several || answerOf(draft()) !== undefined);
  const send = async (answers = answersOf(drafts())) => {
    if (sending() || sent()) return;
    setSending(true);
    try {
      await deps.submit(answers);
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
  const choose = (index: number) => {
    const current = question();
    const option = current?.options[index];
    if (current === undefined || option === undefined || sent()) return;
    setActive(index);
    update((draft) => pick(current, draft, option.label));
  };
  const boxKey = (key: string): boolean => {
    if (draft().text !== "") return false;
    const current = question();
    const count = current?.options.length ?? 0;
    const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : undefined;
    if (current !== undefined && (key === "ArrowDown" || key === "ArrowUp")) {
      const at = active();
      setActive(key === "ArrowDown" ? (at === undefined ? 0 : (at + 1) % count) : at === undefined ? count - 1 : (at + count - 1) % count);
      return true;
    }
    if (current !== undefined && digit !== undefined && digit < count) {
      choose(digit);
      return true;
    }
    const at = active();
    if (current !== undefined && key === "Enter" && at !== undefined && !draft().picked.includes(current.options[at]?.label ?? "")) {
      choose(at);
      return true;
    }
    if (several && (key === "ArrowRight" || key === "ArrowLeft")) {
      goTo(tab() + (key === "ArrowRight" ? 1 : -1));
      return true;
    }
    return false;
  };
  return {
    open,
    drafts,
    tab,
    question,
    draft,
    setText: (text) => update((draft) => ({ ...draft, text, skipped: false })),
    active,
    setActive,
    choose,
    goTo,
    canSubmit,
    closed: () => sending() || sent(),
    next,
    dismiss: () => void send(questions.map(() => ({ kind: "skipped" }))),
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
      const picked = draft().picked;
      if (picked.length === 0) return "Type your own answer, or pick an option above";
      return `Add a note to “${picked.map((label) => displayLabel(label).text).join(", ")}”, or leave this blank`;
    },
    boxKey,
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
