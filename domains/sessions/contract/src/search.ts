import { contentText } from "@lemma/llm";
import { Schema } from "effect";
import type { SessionEvent } from "./sessions.ts";

/** A place in a session that matched a search (`sessions.search`): a prompt or a reply, with the text around the match. */
export const SessionSearchMatch = Schema.Struct({
  sessionId: Schema.String,
  /** The message's event. */
  eventId: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  /** The words around the first match, on one line: `…the parser drops trailing commas when…`. */
  snippet: Schema.String,
});
export type SessionSearchMatch = typeof SessionSearchMatch.Type;

/** The words a search looks for, every one of which a message must contain: lower-cased, split at whitespace. */
export const searchWords = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");

/** How much of a message shows before and after its first match: little before, so a narrow row still shows the match. */
const BEFORE = 20;
const AFTER = 100;

/**
 * `text` on one line around the match at `at`, `length` long, cut at word ends where that keeps the match (a match
 * inside a long word, a path, is cut into instead), with an ellipsis where it was cut; code fences' marks left out.
 */
export const snippetAt = (text: string, at: number, length = 0): string => {
  let start = Math.max(0, at - BEFORE);
  let end = Math.min(text.length, Math.max(at + AFTER, at + length));
  if (start > 0) {
    const space = text.slice(start, at).search(/\s/);
    if (space !== -1) start += space + 1;
  }
  if (end < text.length) {
    const after = text.slice(at + length, end);
    const space = after.search(/\s\S*$/);
    if (space !== -1) end = at + length + space;
  }
  const part = text.slice(start, end);
  const line = part
    .replace(/```\w*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${line}${end < text.length ? "…" : ""}`;
};

/**
 * The newest prompt or reply in `events` (a branch, oldest first) whose text holds every one of `words`
 * (`searchWords`), as a match; none when no message does.
 */
export const searchLog = (sessionId: string, events: readonly SessionEvent[], words: readonly string[]): SessionSearchMatch | undefined => {
  if (words.length === 0) return undefined;
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at]!;
    if (event.data.type !== "message") continue;
    const { message } = event.data;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = contentText(message.content);
    const lower = text.toLowerCase();
    if (!words.every((word) => lower.includes(word))) continue;
    return { sessionId, eventId: event.id, role: message.role, snippet: snippetAt(text, lower.indexOf(words[0]!), words[0]!.length) };
  }
  return undefined;
};
