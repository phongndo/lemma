import type { LlmFailure } from "@lemma/llm";
import { ConnectionError, ProviderError } from "./http.ts";

/**
 * Why a model call failed, for a caller deciding whether to ask again (`LlmFailure`), decided here for every
 * protocol. What is most certain about a failure decides first: a stop the provider named (`stopFailure`), then a lost
 * connection, the provider's words for an overflow or a limit, the HTTP status it refused with, and last its wording.
 */

/** Stops a provider names for an answer it did not give, in any of the protocols, and what each is. */
const STOPS: Readonly<Record<string, LlmFailure>> = {
  // An answer it will not give: asked again, the same.
  refusal: { kind: "fatal" },
  sensitive: { kind: "fatal" },
  content_filter: { kind: "fatal" },
  // The request is too long for the model's window.
  model_context_window_exceeded: { kind: "overflow" },
  // The provider's own connection to the model failed.
  network_error: { kind: "transient" },
};

/** What a stop the provider named is, where `STOPS` knows it; undefined leaves it to its wording (`classifyFailure`). */
export const stopFailure = (reason: string | undefined): LlmFailure | undefined => (reason === undefined ? undefined : STOPS[reason]);

/** Context overflow, as providers word it (Anthropic, OpenAI, OpenRouter, and the servers speaking their protocols). */
const OVERFLOW = [
  /prompt (?:is )?too long/i,
  /request_too_large/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /maximum context length is \d+/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /is longer than the model'?s context length/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  /exceeded (?:max )?context length/i,
  /exceed context limit/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /token limit exceeded/i,
];
const RATE_LIMIT = /rate.?limit|too many requests|resource.?exhausted/i;
/** Over a quota or a per-minute token limit, or out of credit: asking again will not help. */
const NEVER_PASSES = /insufficient_quota|exceeded your current quota|billing|request too large|usage_limit_exceeded|credit/i;
/** Wording of a failure that passes: the provider or the connection, not the request. */
const PASSING =
  /overloaded|server_error|server_busy|api_error|internal (?:server )?error|temporarily|unavailable|high demand|at capacity|provider returned error|timed? ?out|try again|ended (?:before|without)|terminated|other side closed|socket|network|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b/i;

/**
 * Why a call failed, for a caller deciding whether to ask again: `overflow` when the provider says the request is too
 * long for the context window; by status when it refused the request (a 429 a `rate-limit`, a 408, 409, or 5xx
 * `transient`, another 4xx `fatal`, as is a quota or billing limit); by its wording when it failed mid-answer or the
 * connection did. What cannot be told to pass is `fatal`.
 */
export function classifyFailure(error: unknown, message: string): LlmFailure {
  const after = error instanceof ProviderError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {};
  if (error instanceof ConnectionError) return { kind: "transient" };
  if (!RATE_LIMIT.test(message) && OVERFLOW.some((pattern) => pattern.test(message))) return { kind: "overflow" };
  if (NEVER_PASSES.test(message)) return { kind: "fatal" };
  const status = error instanceof ProviderError ? error.status : undefined;
  if (status !== undefined) {
    if (status === 413) return { kind: "overflow" };
    if (status === 429) return { kind: "rate-limit", ...after };
    if (status === 408 || status === 409 || status >= 500) return { kind: "transient", ...after };
    return { kind: "fatal" };
  }
  if (RATE_LIMIT.test(message)) return { kind: "rate-limit", ...after };
  return PASSING.test(message) ? { kind: "transient", ...after } : { kind: "fatal" };
}
