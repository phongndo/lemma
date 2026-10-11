import { Data } from "effect";
import { Hook } from "@lemma/core";
import type { ModelRef, Usage } from "@lemma/llm";
import type { SessionEvent } from "@lemma/sessions";

/*
 * The context domain's contract: what the model is told beyond the conversation, and how a conversation is kept
 * within its model's window. Its prompt sections are the agent's (`PromptSections`); this is the compaction.
 */

/** A compaction about to be made, before a model call: what it would replace, and why it runs now. */
export interface CompactionRequest {
  readonly sessionId: string;
  readonly turnId: string;
  /** The model the request asks, and its context window in tokens. */
  readonly model: ModelRef;
  readonly contextWindow: number;
  /** The request's size as estimated, in tokens. */
  readonly tokens: number;
  /** `threshold`: it would fill more of the window than the plugin's `at`; `overflow`: the model refused the last request as too long. */
  readonly reason: "threshold" | "overflow";
  /** The turn's branch, root to its last event. */
  readonly branch: readonly SessionEvent[];
  /** Index in `branch` of the first event kept word for word: the summary stands for what the model saw before it. */
  readonly firstKept: number;
  /** The summary a compaction before wrote, which this one's replaces. */
  readonly previous?: string;
}

/**
 * What a compaction makes: a `summary` standing for the history before `firstKeptId` (and what writing it cost), or
 * `skip`, which leaves the history as it is.
 */
export type CompactionResult =
  | { readonly kind: "summary"; readonly summary: string; readonly firstKeptId: string; readonly usage?: Usage }
  | { readonly kind: "skip"; readonly reason: string };

/** Writing a summary failed; the history stays as it was, and the call goes ahead. */
export class CompactionError extends Data.TaggedError("CompactionError")<{ readonly message: string; readonly cause?: unknown }> {}

/**
 * Around every compaction `context.compaction` makes, before a model call that needs one; the terminal has a model
 * write the summary (the plugin's own). A handler writes its own (returns without `next`), skips this one (returns
 * `skip`), moves the cut (`next` with another `firstKept`), or reworks the summary `next` wrote. What it returns is
 * appended as the turn's `compaction` event, its `source` the plugin that wrote the summary.
 */
export const CompactionHook = Hook.make<CompactionRequest, CompactionResult, CompactionError>("lemma/context.compaction", {
  summary: {
    input: (request) => ({ reason: request.reason, tokens: request.tokens, window: request.contextWindow }),
    output: (result) => (result.kind === "summary" ? { kind: "summary", chars: result.summary.length } : { kind: "skip" }),
  },
});
