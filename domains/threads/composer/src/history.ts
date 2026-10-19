import type { ImageContent, TextContent } from "@lemma/llm";
import type { ThreadsService } from "@lemma/threads";

type BranchEvent = ReturnType<ThreadsService["branch"]>[number];

/** A prompt sent in the thread, as Up brings it back into the composer. */
export interface SentPrompt {
  readonly text: string;
  readonly images: readonly ImageContent[];
}

/** A user message's content as the composer holds it: its text (its parts joined) and images. */
export const promptOf = (content: readonly (TextContent | ImageContent)[]): SentPrompt => ({
  text: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n"),
  images: content.flatMap((part) => (part.type === "image" ? [part] : [])),
});

/** The prompts on a thread's branch, oldest first: each user message's text (its parts joined) and images. */
export const sentPrompts = (branch: readonly BranchEvent[]): readonly SentPrompt[] =>
  branch.flatMap((event) => (event.data.type === "message" && event.data.message.role === "user" ? [promptOf(event.data.message.content)] : []));

/**
 * Which of `count` sent prompts (oldest first) Up (`older`) or Down (`newer`) brings back from the one at `at`, which
 * is `undefined` while the composer holds none: Up from none goes to the newest and stops at the oldest; Down past the
 * newest goes back to none, an empty composer. An `at` beyond them (the branch has since grown shorter) counts as none.
 */
export const recallStep = (count: number, at: number | undefined, direction: "older" | "newer"): number | undefined => {
  const from = at === undefined || at >= count ? undefined : at;
  if (direction === "older") return count === 0 ? undefined : from === undefined ? count - 1 : Math.max(0, from - 1);
  return from === undefined || from >= count - 1 ? undefined : from + 1;
};

/** The composer as Up or Down finds it: what it holds, the sent prompt it brought back (`recalledAt`), and the selection. */
export interface RecallFrom {
  readonly text: string;
  readonly images: readonly unknown[];
  readonly recalledAt: number | undefined;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * What Up (`older`) or Down (`newer`) brings into the composer: the sent prompt at `at`, or past the newest (`at`
 * undefined) an empty composer. Undefined when the key is the field's, to move the cursor: the composer holds a prompt
 * of its own, or one brought back with the selection anywhere but collapsed at its start or end, or there is nowhere
 * further to go. `history` is read only when the key is the composer's, as the branch may have changed since.
 */
export const recallTarget = (
  history: () => readonly SentPrompt[],
  from: RecallFrom,
  direction: "older" | "newer",
): { readonly at: number | undefined; readonly prompt: SentPrompt } | undefined => {
  const { recalledAt, selectionStart: start, selectionEnd: end } = from;
  if (recalledAt === undefined && (from.text !== "" || from.images.length > 0)) return undefined;
  if (recalledAt !== undefined && (start !== end || (start !== 0 && start !== from.text.length))) return undefined;
  const sent = history();
  const at = recallStep(sent.length, recalledAt, direction);
  if (at === recalledAt) return undefined;
  return { at, prompt: at === undefined ? { text: "", images: [] } : sent[at]! };
};
