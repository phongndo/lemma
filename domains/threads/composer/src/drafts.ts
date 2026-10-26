import { written } from "@lemma/threads";
import type { ThreadDraft, ThreadsService } from "@lemma/threads";

/** A prompt being written: a thread's draft (`Threads.drafts`), with the request id of a send that did not get through. */
export type Draft = ThreadDraft;

/** What the composer holds: a prompt's text and images, with no request id. */
export type Prompt = Pick<Draft, "text" | "images">;

/**
 * Unsent prompts by thread id (`""` for a new thread), as `Threads` keeps them: they survive switching threads, the
 * composer leaving the page (as it does while settings show), and, their text, a reload. Setting none drops one.
 */
export interface Drafts {
  readonly get: (key: string) => Draft | undefined;
  readonly set: (key: string, draft: Draft | undefined) => void;
}

/** The drafts `Threads` keeps, read as they are now (`draft`) and written through (`setDraft`). */
export const draftsOf = (threads: Pick<ThreadsService, "draft" | "setDraft">): Drafts => ({ get: threads.draft, set: threads.setDraft });

/** What a reload would lose: images (only the text is kept), a send that did not get through, or a prompt written with no thread shown. */
export const lostOnReload = (key: string, draft: Draft): boolean => unsent(draft) && (draft.images.length > 0 || draft.requestId !== undefined || key === "");

/** Holds something to send: text other than whitespace, or an image; as `Threads.drafts` counts one (`written`). */
export const unsent = (prompt: Prompt): boolean => written(prompt);

/**
 * Keeps what the composer holds as the thread's draft, with the retry id it had: every change is kept, for when the
 * composer shows the thread again. A sent prompt brought back (`recalled`) is history being read, no draft: it drops
 * the thread's.
 */
export const keepDraft = (drafts: Drafts, key: string, prompt: Prompt, recalled: boolean): void => {
  if (recalled) return drafts.set(key, undefined);
  const requestId = drafts.get(key)?.requestId;
  drafts.set(key, { text: prompt.text, images: prompt.images, ...(requestId === undefined ? {} : { requestId }) });
};

/** The person changed the thread's draft: sending it is a new submission, not a retry, so it drops its request id. */
export const dropRetry = (drafts: Drafts, key: string): void => {
  const draft = drafts.get(key);
  if (draft?.requestId !== undefined) drafts.set(key, { text: draft.text, images: draft.images });
};

/**
 * What a refused prompt (`sent`) returns to its thread as, given what was written there `since` it went: itself,
 * request id and all, when nothing was; else the two together, it first, as a new prompt (an edit, so no request id).
 */
export const returned = (sent: Draft, since: Draft | undefined): Draft =>
  since === undefined || !unsent(since)
    ? sent
    : { text: [sent.text, since.text].filter((part) => part.trim() !== "").join("\n\n"), images: [...sent.images, ...since.images] };
