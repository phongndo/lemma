import type { TurnEndReason } from "@lemma/sessions";

/**
 * What a thread asks of the person, the most pressing first: it waits on them (an approval, an answer), a turn runs in
 * it, a turn failed or stopped short, or a turn finished that they have not looked at. One record per thread, which
 * every place that shows threads reads (the sidebar, notifications), so they agree.
 */
export type AttentionState = "waiting" | "working" | "failed" | "done";

/** A thread's attention (`Threads.attention`). */
export interface ThreadAttention {
  readonly state: AttentionState;
  /** In a few words: what it waits for (`Needs approval`), `Working`, why it stopped (`Failed`, `Out of steps`), `Done`. */
  readonly label: string;
  /** Since when, epoch ms: it began waiting, its turn began, or its turn ended. */
  readonly since: number;
}

/** A turn's end the person has not looked at: what `failed` and `done` are made from. */
export interface UnseenEnd {
  readonly reason: Exclude<TurnEndReason, "cancelled">;
  /** When it ended, epoch ms. */
  readonly at: number;
}

/** A turn ended so is one to tell the person about: not one they cancelled. */
export const tells = (reason: TurnEndReason): reason is UnseenEnd["reason"] => reason !== "cancelled";

/** What is known of a thread that its attention is made from. */
export interface AttentionFacts {
  /** What it waits on the person for (`ThreadWaits`), and since when this page saw it waiting. */
  readonly waiting?: string | undefined;
  readonly waitingSince?: number | undefined;
  /** A turn runs in it, and since when this page saw it start. */
  readonly running: boolean;
  readonly runningSince?: number | undefined;
  /** Its last turn's end, while the person has not looked at it. */
  readonly unseen?: UnseenEnd | undefined;
}

/**
 * A thread's attention, the most pressing first: waiting, then working, then a turn's unseen end (failed, or done); at
 * rest, none. `now` stands in for a time this page did not see begin.
 */
export const attentionOf = (facts: AttentionFacts, now: number): ThreadAttention | undefined => {
  if (facts.waiting !== undefined) return { state: "waiting", label: facts.waiting, since: facts.waitingSince ?? now };
  if (facts.running) return { state: "working", label: "Working", since: facts.runningSince ?? now };
  const end = facts.unseen;
  if (end === undefined) return undefined;
  if (end.reason === "done") return { state: "done", label: "Done", since: end.at };
  return { state: "failed", label: end.reason === "max-steps" ? "Out of steps" : "Failed", since: end.at };
};

/** A stored end as far as it reads (`localStorage` holds what an older version, or another tab, wrote). */
export const isUnseenEnd = (value: unknown): value is UnseenEnd =>
  typeof value === "object" &&
  value !== null &&
  ((value as UnseenEnd).reason === "done" || (value as UnseenEnd).reason === "error" || (value as UnseenEnd).reason === "max-steps") &&
  typeof (value as UnseenEnd).at === "number";
