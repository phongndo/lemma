import { modelView } from "@lemma/contracts";
import type { Message, SessionEvent } from "@lemma/contracts";

/** What an image costs in the estimate, in characters (about 1,200 tokens). */
const IMAGE_CHARS = 4_800;
/** Characters a token stands for, roughly, in the estimate. */
const CHARS_PER_TOKEN = 4;

/** A message's size in characters, as the model reads it. */
const messageChars = (message: Message): number => {
  let chars = 0;
  for (const part of message.content) {
    if (part.type === "text") chars += part.text.length;
    else if (part.type === "image") chars += IMAGE_CHARS;
    else if (part.type === "thinking") chars += part.thinking.length;
    else if (part.type === "toolCall") chars += part.name.length + JSON.stringify(part.arguments).length;
  }
  return chars;
};

const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * How many tokens the next request's context holds, about. The last response
 * after the latest compaction reports the context it was given and its own
 * output; later messages (tool results, a new prompt) are estimated from
 * their length. Without such a response, everything is estimated, with
 * `baseChars()` for the system prompt and tools (only then worked out).
 */
export const estimateTokens = (branch: readonly SessionEvent[], baseChars: () => number): number => {
  const { start, compaction } = modelView(branch);
  let tokens: number | undefined;
  let from = start;
  for (let i = branch.length - 1; i > (compaction ?? -1); i--) {
    const data = branch[i]!.data;
    if (data.type !== "message" || data.message.role !== "assistant") continue;
    const usage = data.message.usage;
    const reported = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    if (reported === 0) continue;
    tokens = reported;
    from = i + 1;
    break;
  }
  if (tokens === undefined) {
    const summary = compaction === undefined ? undefined : branch[compaction]!.data;
    tokens = tokensOf(baseChars() + (summary?.type === "compaction" ? summary.summary.length : 0));
  }
  for (const event of branch.slice(from)) if (event.data.type === "message") tokens += tokensOf(messageChars(event.data.message));
  return tokens;
};

/**
 * Where to cut the model's view so about `keep` tokens of it stay word for
 * word: the index on `branch` of the first event kept. A cut falls on a
 * prompt or a response, never between a tool call and its result, and leaves
 * at least one message to summarize. Undefined when there is no such place.
 */
export const chooseCut = (branch: readonly SessionEvent[], keep: number): number | undefined => {
  const { start } = modelView(branch);
  const seen: { readonly index: number; readonly message: Message }[] = [];
  for (let i = start; i < branch.length; i++) {
    const data = branch[i]!.data;
    if (data.type === "message") seen.push({ index: i, message: data.message });
  }
  let tail = 0;
  let smallest: number | undefined;
  for (let at = seen.length - 1; at >= 1; at--) {
    tail += tokensOf(messageChars(seen[at]!.message));
    if (seen[at]!.message.role === "toolResult") continue;
    // The latest place keeping at least `keep`; failing that, the earliest, keeping the most.
    if (tail >= keep) return seen[at]!.index;
    smallest = seen[at]!.index;
  }
  return smallest;
};

/** Each tool result, and each text, is cut to this many characters in what is sent for summarizing. */
const RESULT_CHARS = 2_000;
const TEXT_CHARS = 8_000;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} … (${text.length - max} more characters)`);

const render = (message: Message): string => {
  if (message.role === "toolResult") {
    const text = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    return `[tool result: ${message.toolName}${message.isError ? ", failed" : ""}]\n${cut(text, RESULT_CHARS)}`;
  }
  const parts = (message.content as readonly Message["content"][number][]).flatMap((part) => {
    if (part.type === "text") return [cut(part.text, TEXT_CHARS)];
    if (part.type === "image") return ["[image]"];
    if (part.type === "toolCall") return [`→ ${part.name} ${cut(JSON.stringify(part.arguments), RESULT_CHARS)}`];
    return [];
  });
  return `[${message.role}]\n${parts.join("\n")}`;
};

/**
 * The conversation to summarize, as text: the previous summary, then each
 * message, with long tool output and text cut. Over `maxChars`, the oldest
 * messages go (the previous summary stays).
 */
export const transcript = (messages: readonly Message[], previous: string | undefined, maxChars: number): string => {
  const head = previous === undefined ? "" : `[summary of the conversation before this]\n${previous}\n\n`;
  const rendered = messages.map(render);
  let total = head.length;
  let first = rendered.length;
  while (first > 0 && total + rendered[first - 1]!.length + 2 <= maxChars) total += rendered[--first]!.length + 2;
  const omitted = first === 0 ? "" : `[${first} earlier message${first === 1 ? "" : "s"} omitted]\n\n`;
  return `${head}${omitted}${rendered.slice(first).join("\n\n")}`;
};

export const SUMMARY_PROMPT = `You summarize a coding session so that a model continuing it, with only your summary and the most recent messages, can carry on the work without losing anything that matters.

Write a concise, specific summary in the user's language. Keep:
- the user's goals, requests, and constraints, in their own terms;
- decisions made and why;
- files read, created, or changed (with paths), and commands run with the results that matter;
- errors hit and how they were resolved;
- where the work stands and what remains to do.

Leave out pleasantries and anything already superseded. Write the summary only, with no preamble.`;
