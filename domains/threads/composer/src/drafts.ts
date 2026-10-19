import type { ImageContent } from "@lemma/llm";
import { written } from "@lemma/threads";

/** A prompt being written. */
export interface Draft {
  readonly text: string;
  readonly images: readonly ImageContent[];
  /** Kept from a send that did not get through, so sending it again unchanged cannot place it twice; an edit drops it. */
  readonly requestId?: string;
}

/** What the composer holds: a prompt's text and images, with no request id. */
export type Prompt = Pick<Draft, "text" | "images">;

/**
 * Unsent prompts by thread id (`""` for a new thread): they survive switching threads and the composer leaving the
 * page, as it does while settings show.
 */
export type Drafts = Map<string, Draft>;

/**
 * The composer's drafts, each thread's passed on as it changes (`publish`: `Threads.setDraft`, which keeps them across
 * reloads and lets the sidebar show them), seeded from what was `kept`. `""`, written with no thread shown, stays here.
 */
export class SharedDrafts extends Map<string, Draft> {
  private readonly publish: (key: string, prompt: Prompt | undefined) => void;

  constructor(kept: Iterable<readonly [string, Prompt]>, publish: (key: string, prompt: Prompt | undefined) => void) {
    super();
    this.publish = publish;
    for (const [key, prompt] of kept) super.set(key, { text: prompt.text, images: prompt.images });
  }

  override set(key: string, draft: Draft): this {
    super.set(key, draft);
    if (key !== "") this.publish(key, { text: draft.text, images: draft.images });
    return this;
  }

  override delete(key: string): boolean {
    if (key !== "") this.publish(key, undefined);
    return super.delete(key);
  }
}

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
  if (recalled) return void drafts.delete(key);
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
