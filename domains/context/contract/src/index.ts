import { Data, Predicate } from "effect";
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
  /**
   * `threshold`: it would fill more of the window than the plugin's `at`; `overflow`: the model refused the last request
   * as too long; `requested`: the user asked for one (`/compact`).
   */
  readonly reason: "threshold" | "overflow" | "requested";
  /** The turn's branch, root to its last event. */
  readonly branch: readonly SessionEvent[];
  /** Index in `branch` of the first event kept word for word: the summary stands for what the model saw before it. */
  readonly firstKept: number;
  /** The summary a compaction before wrote, which this one's replaces. */
  readonly previous?: string;
  /** What the user asked the summary to focus on (`/compact <instructions>`). */
  readonly instructions?: string;
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
 * `skip`), moves the cut (`next` with another `firstKept`), or reworks the summary `next` wrote. The history is kept
 * from a message in the model's view, after one at least, and never a tool result (whose call the summary would
 * take): a cut elsewhere fails the compaction. What it returns is appended as the turn's `compaction` event, its
 * `source` the outermost plugin whose summary differs from the one it was handed (the plugin's own model's when none).
 *
 * @composition a chain: the terminal writes the summary with the plugin's model; a handler returns its own without
 * `next`, skips, moves the cut, or reworks what `next` wrote. A handler that fails fails the compaction
 * (`CompactionError`): the history stays as it was and the call goes ahead. Checked: a summary or a skip of the right
 * shape.
 */
export const CompactionHook = Hook.make<CompactionRequest, CompactionResult, CompactionError>("lemma/context.compaction", {
  check: {
    input: (value) =>
      Predicate.isObject(value) && Array.isArray(value.branch) && Number.isInteger(value.firstKept)
        ? undefined
        : "expected a compaction request with its branch and firstKept, an index into it",
    output: (value) =>
      !Predicate.isObject(value)
        ? "expected { kind: summary | skip }"
        : value.kind === "summary"
          ? typeof value.summary === "string" && typeof value.firstKeptId === "string"
            ? undefined
            : "a summary needs summary and firstKeptId strings"
          : value.kind === "skip"
            ? typeof value.reason === "string"
              ? undefined
              : "a skip needs a reason string"
            : `unknown kind ${JSON.stringify(value.kind)}: expected summary or skip`,
  },
  summary: {
    input: (request) => ({ reason: request.reason, tokens: request.tokens, window: request.contextWindow }),
    output: (result) => (result.kind === "summary" ? { kind: "summary", chars: result.summary.length } : { kind: "skip" }),
  },
});
