import { modelEntries } from "@lemma/sessions";
import { patchPaths } from "@lemma/tools/patch";
import type { Message } from "@lemma/llm";
import type { ModelEntry, SessionEvent } from "@lemma/sessions";

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
 * How many tokens the next request's context holds, as measured: the last
 * response after the latest compaction reports the context it was given and
 * its own output, and later messages (tool results, a new prompt) are
 * estimated from their length. Undefined without such a response.
 */
export const measuredTokens = (branch: readonly SessionEvent[], entries: readonly ModelEntry[] = modelEntries(branch)): number | undefined => {
  // A response logged before the latest compaction (one it kept) was given the context from before it, and one logged
  // before the latest edit of the view (a `context-edit`) the context from before that.
  let after = entries[0]?.summary === true ? entries[0].index : -1;
  for (let index = branch.length - 1; index > after; index--) {
    if (branch[index]!.data.type !== "context-edit") continue;
    after = index;
    break;
  }
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at]!;
    if (entry.index <= after || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    const reported = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    if (reported === 0) continue;
    return reported + entriesTokens(entries, entry.index + 1);
  }
  return undefined;
};

/** The tokens of the view's messages from event `from` on, about; the summary is not one of them. */
const entriesTokens = (entries: readonly ModelEntry[], from = 0): number => {
  let tokens = 0;
  for (const entry of entries) if (entry.summary !== true && entry.index >= from) tokens += tokensOf(messageChars(entry.message));
  return tokens;
};

/**
 * How many tokens the next request's context holds, about: `measuredTokens`,
 * or without a response to measure from, everything estimated as the request
 * sends it (the summary as the model reads it, with its files), with
 * `baseChars()` for the system prompt and tools (only then worked out).
 */
export const estimateTokens = (branch: readonly SessionEvent[], baseChars: () => number): number => {
  const entries = modelEntries(branch);
  const measured = measuredTokens(branch, entries);
  if (measured !== undefined) return measured;
  const summary = entries[0]?.summary === true ? entries[0].message : undefined;
  return tokensOf(baseChars() + (summary === undefined ? 0 : messageChars(summary))) + entriesTokens(entries);
};

/**
 * The view's messages in the order of their events on the branch, which is what a cut divides (a `context` entry the
 * view moved after a response's tool results is before them on the branch), with where each tool call is made.
 */
const inBranchOrder = (branch: readonly SessionEvent[]) => {
  const entries = modelEntries(branch)
    .filter((entry) => entry.summary !== true)
    .sort((a, b) => a.index - b.index);
  const callAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) if (block.type === "toolCall") callAt.set(block.id, entry.index);
  }
  return { entries, callAt };
};

/** The tokens of the messages in the model's view, about (what a cut divides). */
export const viewTokens = (branch: readonly SessionEvent[]): number => entriesTokens(modelEntries(branch));

/**
 * Where to cut the model's view so about `keep` tokens of it stay word for
 * word: the index on `branch` of the first event kept. A cut falls on a
 * prompt or a response, never between a tool call and its result, and leaves
 * at least one message to summarize. Undefined when there is no such place.
 */
export const chooseCut = (branch: readonly SessionEvent[], keep: number): number | undefined => {
  const { entries, callAt } = inBranchOrder(branch);
  let tail = 0;
  let smallest: number | undefined;
  // The earliest call a kept result answers: a cut after it would summarize the call and keep its result.
  let earliestCall = Infinity;
  for (let at = entries.length - 1; at >= 1; at--) {
    const entry = entries[at]!;
    tail += tokensOf(messageChars(entry.message));
    if (entry.message.role === "toolResult") {
      earliestCall = Math.min(earliestCall, callAt.get(entry.message.toolCallId) ?? Infinity);
      continue;
    }
    if (earliestCall < entry.index) continue;
    // The latest place keeping at least `keep`; failing that, the earliest, keeping the most.
    if (tail >= keep) return entry.index;
    smallest = entry.index;
  }
  return smallest;
};

/** Each tool result, and each text, is cut to this many characters in what is sent for summarizing. */
const RESULT_CHARS = 2_000;
const TEXT_CHARS = 8_000;

/** What wraps the messages in what is sent for summarizing. */
const OPEN = "<conversation>\n";
const CLOSE = "\n</conversation>";

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
 * message in a `<conversation>`, with long tool output and text cut. Over
 * `maxChars`, the oldest messages go (the previous summary stays).
 */
export const transcript = (messages: readonly Message[], previous: string | undefined, maxChars: number): string => {
  const head = previous === undefined ? "" : `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
  const rendered = messages.map(render);
  let total = head.length + OPEN.length + CLOSE.length;
  let first = rendered.length;
  while (first > 0 && total + rendered[first - 1]!.length + 2 <= maxChars) total += rendered[--first]!.length + 2;
  const omitted = first === 0 ? "" : `[${first} earlier message${first === 1 ? "" : "s"} omitted]\n\n`;
  return `${head}${OPEN}${omitted}${rendered.slice(first).join("\n\n")}${CLOSE}`;
};

/**
 * What the writing model is asked, after the transcript: to fold in the previous summary when there is one, with the
 * user's focus when they gave one (`/compact <instructions>`, cut as a tool result is). It ends with the same line whatever comes before it.
 */
export const summaryAsk = (text: string, previous: boolean, instructions: string | undefined): string =>
  [
    text,
    ...(previous
      ? [
          "<previous-summary> summarizes the conversation before this one: write one summary of both. Keep what is still true from it, move work now finished to Done, and drop only what the conversation has superseded.",
        ]
      : []),
    ...(instructions === undefined ? [] : [`The user asked the summary to focus on: ${cut(instructions, RESULT_CHARS)}`]),
    "Summarize the conversation above.",
  ].join("\n\n");

/** The summary's form, whoever asks for it. */
const SUMMARY_FORM = `Write the summary in the user's language, in this form, leaving out a section with nothing in it:

## Goal
What the user wants, in their own terms.

## Constraints and preferences
Requirements, conventions, and preferences the user stated.

## Progress
### Done
### In progress
### Blocked

## Key decisions
Decisions made, and why.

## Next steps
What remains to do, in order.

## Critical context
What the work depends on: files read, created, or changed (with paths); commands run and the results that matter; errors hit and how they were resolved; and any background work or other agents started, with their ids, their status, and where their results are.

Preserve exact file paths, identifiers, commands, and error messages. Leave out pleasantries and anything superseded. Write the summary only, with no preamble.`;

export const SUMMARY_PROMPT = `You write a checkpoint of a coding session for another model, which will continue the work with only your summary and the most recent messages. You are not taking part in the conversation: do not continue it, answer its questions, or call tools.

${SUMMARY_FORM}`;

/**
 * What the turn's own model is asked, after the conversation as its last request sent it (a fork of that request,
 * which its provider's cache serves): to stop and write the summary. It ends as `summaryAsk` does.
 */
export const forkAsk = (previous: boolean, instructions: string | undefined): string =>
  [
    "<compaction>",
    "From Lemma, not the user: the conversation is near the limit of your context window. Stop working on the task, and call no tools: write a checkpoint of the session for another model, which will continue the work with only your summary and the most recent messages.",
    SUMMARY_FORM,
    ...(previous
      ? [
          "The conversation begins with a summary of what came before it: write one summary of both, keeping what is still true from it, and moving work now finished to Done.",
        ]
      : []),
    ...(instructions === undefined ? [] : [`The user asked the summary to focus on: ${cut(instructions, RESULT_CHARS)}`]),
    "</compaction>",
    "Summarize the conversation above.",
  ].join("\n\n");

/** At most this many paths are kept of each kind, the latest. */
const FILES_KEPT = 50;

/** The files a summary stands for having read and changed, by the bundled tools' names and arguments. */
export interface Files {
  readonly read: readonly string[];
  readonly modified: readonly string[];
}

/**
 * The files the summarized messages read and changed, after those `before` (the previous compaction's) lists: each
 * path once, at its latest, the latest `FILES_KEPT` of each kind. Only calls whose result succeeded count: a failed
 * edit changed nothing. A file changed is not listed as read too.
 */
export const filesOf = (messages: readonly Message[], before: Files | undefined): Files => {
  const succeeded = new Set(messages.flatMap((message) => (message.role === "toolResult" && message.isError !== true ? [message.toolCallId] : [])));
  const read = [...(before?.read ?? [])];
  const modified = [...(before?.modified ?? [])];
  const note = (list: string[], path: unknown) => {
    if (typeof path !== "string" || path === "") return;
    const at = list.indexOf(path);
    if (at !== -1) list.splice(at, 1);
    list.push(path);
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || !succeeded.has(part.id)) continue;
      const args = part.arguments;
      if (part.name === "read") note(read, args.path);
      else if (part.name === "edit" || part.name === "write") note(modified, args.path);
      else if (part.name === "apply_patch") {
        if (typeof args.input === "string") for (const path of patchPaths(args.input)) note(modified, path);
      }
    }
  }
  return { read: read.filter((path) => !modified.includes(path)).slice(-FILES_KEPT), modified: modified.slice(-FILES_KEPT) };
};

/** What a model that sees only the summary is asked, to find what the summary leaves out. */
export const REVIEW_PROMPT = `You read a checkpoint summary of a coding session that another model will continue from, with only the summary and the most recent messages. List up to five questions about facts the summary leaves out that the work would need (exact paths, values, commands, errors, decisions and their reasons), one per line, numbered. Ask only what the summary does not answer; if it is complete, answer "None".`;

/** What the turn's own model, which saw the conversation, is asked: to answer the questions about what it summarized. */
export const answersAsk = (questions: string): string =>
  [
    "<compaction-review>",
    "From Lemma, not the user: a reader of your summary asked these questions about what it leaves out. Answer each from the conversation, briefly and exactly, numbered as asked; say so where the conversation does not tell. Call no tools.",
    questions,
    "</compaction-review>",
  ].join("\n\n");
