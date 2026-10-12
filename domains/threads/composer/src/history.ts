import type { ImageContent } from "@lemma/llm";
import type { ThreadsService } from "@lemma/threads";

type BranchEvent = ReturnType<ThreadsService["branch"]>[number];

/** A prompt sent in the thread, as Up brings it back into the composer. */
export interface SentPrompt {
  readonly text: string;
  readonly images: readonly ImageContent[];
}

/** The prompts on a thread's branch, oldest first: each user message's text (its parts joined) and images. */
export const sentPrompts = (branch: readonly BranchEvent[]): readonly SentPrompt[] =>
  branch.flatMap((event) => {
    if (event.data.type !== "message" || event.data.message.role !== "user") return [];
    const content = event.data.message.content;
    return [
      {
        text: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n"),
        images: content.flatMap((part) => (part.type === "image" ? [part] : [])),
      },
    ];
  });

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
