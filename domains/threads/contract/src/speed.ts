import type { AssistantMessage } from "@lemma/llm";
import type { Timing } from "@lemma/sessions";

/** A call that streamed for less than this came whole (or nearly), so its time says nothing of its speed. */
const MIN_STREAM_MS = 100;

/**
 * What a model call streamed: its output tokens from its first token to its end, and how long that took. Reasoning
 * the provider kept hidden (counted in `usage.reasoning`, with no thinking text in the message) was done before the
 * first token arrived, so it is left out. Undefined when the call did not stream.
 */
export const streamed = (message: AssistantMessage, timing: Timing | undefined): { readonly tokens: number; readonly ms: number } | undefined => {
  if (timing?.firstTokenAt === undefined) return undefined;
  const ms = timing.endedAt - timing.firstTokenAt;
  if (ms < MIN_STREAM_MS) return undefined;
  const shown = message.content.some((part) => part.type === "thinking" && part.thinking.length > 0);
  const tokens = message.usage.output - (shown ? 0 : (message.usage.reasoning ?? 0));
  return tokens > 0 ? { tokens, ms } : undefined;
};

/** Output tokens per second over the calls' streaming: the model's speed, apart from its wait for a first token and the tools'. */
export const throughput = (calls: Iterable<{ readonly message: AssistantMessage; readonly timing?: Timing | undefined }>): number | undefined => {
  let tokens = 0;
  let ms = 0;
  for (const call of calls) {
    const part = streamed(call.message, call.timing);
    if (part === undefined) continue;
    tokens += part.tokens;
    ms += part.ms;
  }
  return ms === 0 ? undefined : (tokens * 1000) / ms;
};

/** `52 tok/s`, with a tenth below ten. */
export const formatThroughput = (tokensPerSecond: number): string => `${tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond)} tok/s`;
